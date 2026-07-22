import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { start } from "../../core/execution_loop.js";
import { parseChartModuleSync } from "../../core/inspect.js";
import { explainReplay, type ReplayExplanation } from "../../core/replay_check.js";
import type { ChartAst } from "../../core/types.js";
import type { SchemaRegistry } from "../../core/schema_registry.js";
import { ChartRuntime } from "./chart_runtime.js";
import { JsonlLogStore } from "./log_store.js";
import { finalMachineFailureMessage, terminalStateForFinalMachine } from "./run_outcome.js";
import { markRunHeartbeat, patchRunStatus } from "./run_status.js";
import {
	defaultFailedTerminalNotificationPayload,
	persistTerminalNotificationRequest,
	renderTerminalNotificationPayload,
} from "./terminal_notifications.js";
import { watchSessionSteering } from "./session_steering.js";
import { assertChartPreflight } from "./chart_typecheck.js";
import type { AgentExecutor } from "./agent_executor.js";

export type HyperchartRunnerConfig = {
	runId: string;
	runDir: string;
	chartPath: string;
	chartId: string;
	exportName?: string;
	workDir: string;
	args?: Record<string, unknown>;
	defaultModel?: string;
	/** Role name -> model ref (in the host's model format) applied to agent definitions declaring `role`. */
	modelRoles?: Record<string, string>;
	/** Toolset name -> tool names (in the host's tool vocabulary) applied to agent definitions declaring `toolset`. */
	toolsets?: Record<string, string[]>;
	ignoreReplayWarnings?: boolean;
	/** Host-specific configuration directory; interpretation belongs to the host's executor factory. */
	agentDir?: string;
};

export type SteerableAgentExecutor = AgentExecutor & {
	steer(actionKey: string, message: string): Promise<boolean>;
};

export type ExecutorContext = {
	config: HyperchartRunnerConfig;
	ast: ChartAst;
	schemaRegistry: SchemaRegistry;
	sessionsDir: string;
};

export function readRunnerConfig(path: string): HyperchartRunnerConfig {
	const value = JSON.parse(readFileSync(path, "utf8")) as Partial<HyperchartRunnerConfig>;
	if (
		typeof value.runId !== "string" ||
		typeof value.runDir !== "string" ||
		typeof value.chartPath !== "string" ||
		typeof value.chartId !== "string" ||
		typeof value.workDir !== "string"
	) {
		throw new Error(`Invalid hyperchart runner config: ${path}`);
	}
	return {
		runId: value.runId,
		runDir: value.runDir,
		chartPath: value.chartPath,
		chartId: value.chartId,
		workDir: value.workDir,
		...(typeof value.agentDir === "string" ? { agentDir: value.agentDir } : {}),
		...(typeof value.exportName === "string" ? { exportName: value.exportName } : {}),
		...(isRecord(value.args) ? { args: value.args } : {}),
		...(typeof value.defaultModel === "string" ? { defaultModel: value.defaultModel } : {}),
		...(isRecord(value.modelRoles) ? { modelRoles: stringEntries(value.modelRoles) } : {}),
		...(isRecord(value.toolsets) ? { toolsets: stringArrayEntries(value.toolsets) } : {}),
		...(value.ignoreReplayWarnings === true ? { ignoreReplayWarnings: true } : {}),
	};
}

/**
 * The host-agnostic runner main: status/heartbeat/signal lifecycle, chart
 * preflight and parse, replay-compatibility gate, steering watcher, and
 * ChartRuntime execution. Hosts supply only the agent-executor factory.
 */
export async function runHyperchartRunner(
	config: HyperchartRunnerConfig,
	buildExecutor: (context: ExecutorContext) => Promise<SteerableAgentExecutor> | SteerableAgentExecutor,
): Promise<void> {
	let runtime: ChartRuntime | undefined;
	let heartbeat: NodeJS.Timeout | undefined;
	let stopSteering: (() => void) | undefined;
	let stopping = false;

	process.chdir(config.workDir);
	mkdirSync(join(config.runDir, "sessions"), { recursive: true });
	patchRunStatus(config.runDir, {
		runId: config.runId,
		chartId: config.chartId,
		state: "starting",
		pid: process.pid,
		heartbeatAt: Date.now(),
		error: undefined,
		exitCode: undefined,
	});
	const stop = async (signal: NodeJS.Signals) => {
		if (stopping) return;
		stopping = true;
		if (heartbeat !== undefined) clearInterval(heartbeat);
		stopSteering?.();
		const exitCode = signal === "SIGTERM" ? 143 : 130;
		patchRunStatus(config.runDir, {
			state: "stopped",
			pid: process.pid,
			heartbeatAt: Date.now(),
			exitCode,
		});
		await runtime?.dispose().catch(() => undefined);
		process.exit(exitCode);
	};
	process.on("SIGTERM", () => void stop("SIGTERM"));
	process.on("SIGINT", () => void stop("SIGINT"));
	heartbeat = setInterval(() => markRunHeartbeat(config.runDir), 2_000);
	heartbeat.unref();

	try {
		await assertChartPreflight(config.chartPath);
		const parsed = parseChartModuleSync(
			config.chartPath,
			config.exportName === undefined ? {} : { exportName: config.exportName },
		);
		if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
		const logStore = new JsonlLogStore(resolve(config.runDir, "log.jsonl"), (message) => console.warn(message));
		const existingLog = await logStore.readAll();
		const replayExplanation = existingLog.length === 0 ? undefined : explainReplay(parsed.ast, existingLog);
		if (replayExplanation?.broken !== undefined) {
			throw new Error(formatReplayCompatibilityError(config.runDir, replayExplanation));
		}
		const replayWarnings = replayExplanation === undefined ? [] : formatReplayWarnings(replayExplanation);
		if (replayWarnings.length > 0 && config.ignoreReplayWarnings !== true) {
			throw new Error(formatReplayWarningsError(config.runDir, replayWarnings));
		}
		for (const warning of replayWarnings) console.warn(warning);
		patchRunStatus(config.runDir, {
			runId: config.runId,
			chartId: parsed.ast.id,
			state: "running",
			pid: process.pid,
			heartbeatAt: Date.now(),
			error: undefined,
			exitCode: undefined,
			...(replayWarnings.length === 0 ? { replayWarnings: undefined } : { replayWarnings }),
		});
		const sessionsDir = join(config.runDir, "sessions");
		const executor = await buildExecutor({
			config,
			ast: parsed.ast,
			schemaRegistry: parsed.schemaRegistry,
			sessionsDir,
		});
		stopSteering = watchSessionSteering(sessionsDir, (request) => executor.steer(request.actionKey, request.message));
		runtime = new ChartRuntime({
			ast: parsed.ast,
			logStore,
			agentExecutor: executor,
			workDir: config.workDir,
			chartDir: dirname(config.chartPath),
			schemaRegistry: parsed.schemaRegistry,
			onWarn: (message) => console.warn(message),
		});
		const finalState = await start(runtime, config.args);
		if (!stopping) {
			const log = await logStore.readAll();
			const terminalState = terminalStateForFinalMachine(finalState, log);
			const error = terminalState === "failed" ? finalMachineFailureMessage(finalState, log) : undefined;
			persistTerminalNotificationRequest(
				config.runDir,
				renderTerminalNotificationPayload(finalState, {
					runId: config.runId,
					runDir: config.runDir,
					workDir: config.workDir,
					outcome: terminalState,
					...(error === undefined ? {} : { error }),
				}),
			);
			patchRunStatus(config.runDir, {
				runId: config.runId,
				chartId: parsed.ast.id,
				state: terminalState,
				pid: process.pid,
				heartbeatAt: Date.now(),
				exitCode: terminalState === "failed" ? 1 : 0,
				error,
			});
			if (terminalState === "failed") process.exitCode = 1;
		}
	} catch (error) {
		if (!stopping) {
			const message = error instanceof Error ? error.message : String(error);
			try {
				persistTerminalNotificationRequest(
					config.runDir,
					defaultFailedTerminalNotificationPayload({
						runId: config.runId,
						runDir: config.runDir,
						chartId: config.chartId,
						error: message,
					}),
				);
			} catch (notificationError) {
				console.error(notificationError);
			}
			patchRunStatus(config.runDir, {
				runId: config.runId,
				state: "failed",
				pid: process.pid,
				heartbeatAt: Date.now(),
				exitCode: 1,
				error: message,
			});
			process.exitCode = 1;
		}
	} finally {
		if (heartbeat !== undefined) clearInterval(heartbeat);
		stopSteering?.();
		await runtime?.dispose().catch(() => undefined);
	}
}

function formatReplayWarningsError(runDir: string, warnings: readonly string[]): string {
	return [
		"Replay over the current chart produced warning-level compatibility issues.",
		...warnings,
		`Resolve them by rewinding, or explicitly confirm continuing with: hyperchart action=run runDir=${runDir} ignoreReplayWarnings=true`,
	].join("\n");
}

function formatReplayCompatibilityError(runDir: string, explanation: ReplayExplanation): string {
	const broken = explanation.broken;
	if (broken === undefined) return "Replay compatibility check failed";
	const target = broken.invokeSeqId ?? broken.seqId;
	return [
		`Replay over the current chart is incompatible at seqId ${broken.seqId}${broken.state === undefined ? "" : ` (${broken.state})`}.`,
		`Original error: ${broken.error}`,
		`Rewind to the compatible prefix explicitly before resuming: hyperchart action=rewind runDir=${runDir} seqId=${target} mode=before`,
		`Or use: hyperchart action=rewind runDir=${runDir} to=compatible`,
	].join("\n");
}

function formatReplayWarnings(explanation: ReplayExplanation): string[] {
	const warnings: string[] = [];
	if (explanation.skipped.length > 0) {
		const states = [...new Set(explanation.skipped.map((entry) => entry.state))].slice(0, 8).join(", ");
		warnings.push(
			`Replay warning: ${explanation.skipped.length} durable record(s) were skipped because their states were inactive under the current chart${states.length === 0 ? "" : ` (${states})`}.`,
		);
	}
	if (explanation.stale.length > 0) {
		const states = [...new Set(explanation.stale.map((entry) => entry.state))].slice(0, 8).join(", ");
		warnings.push(
			`Replay warning: ${explanation.stale.length} durable record(s) have stale provenance under the current chart${states.length === 0 ? "" : ` (${states})`}.`,
		);
	}
	return warnings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringEntries(value: Record<string, unknown>): Record<string, string> {
	return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function stringArrayEntries(value: Record<string, unknown>): Record<string, string[]> {
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, string[]] =>
				Array.isArray(entry[1]) && entry[1].every((item) => typeof item === "string"),
		),
	);
}
