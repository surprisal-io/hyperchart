import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { explainReplay, parseChartModule, start, type ReplayExplanation } from "../../index.js";
import { ChartRuntime } from "../generic/chart_runtime.js";
import { JsonlLogStore } from "../generic/log_store.js";
import { finalMachineFailureMessage, terminalStateForFinalMachine } from "../generic/run_outcome.js";
import { assertChartPreflight } from "./chart_typecheck.js";
import { PiAgentExecutor } from "./pi_agent_executor.js";
import { markRunHeartbeat, patchRunStatus } from "./run_status.js";

export type HyperchartRunnerConfig = {
	runId: string;
	runDir: string;
	chartPath: string;
	chartId: string;
	exportName?: string;
	workDir: string;
	args?: Record<string, unknown>;
	defaultModel?: string;
	ignoreReplayWarnings?: boolean;
	agentDir: string;
};

let runtime: ChartRuntime | undefined;
let heartbeat: NodeJS.Timeout | undefined;
let stopping = false;

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const configPath = argv[0];
	if (configPath === undefined) throw new Error("hyperchart runner requires a config path");
	const config = readConfig(configPath);
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
	installSignalHandlers(config.runDir);
	heartbeat = setInterval(() => markRunHeartbeat(config.runDir), 2_000);
	heartbeat.unref();

	try {
		await assertChartPreflight(config.chartPath);
		const parsed = await parseChartModule(
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
		const modelRegistry = createModelRegistry(config.agentDir);
		const executor = new PiAgentExecutor({
			workDir: config.workDir,
			agentDir: config.agentDir,
			modelRegistry,
			sessionsDir: join(config.runDir, "sessions"),
			...(config.defaultModel === undefined ? {} : { defaultModel: config.defaultModel }),
		});
		runtime = new ChartRuntime({
			ast: parsed.ast,
			logStore,
			agentExecutor: executor,
			workDir: config.workDir,
			chartDir: dirname(config.chartPath),
			onWarn: (message) => console.warn(message),
		});
		const finalState = await start(runtime, config.args);
		if (!stopping) {
			const log = await logStore.readAll();
			const terminalState = terminalStateForFinalMachine(finalState, log);
			const error = terminalState === "failed" ? finalMachineFailureMessage(finalState, log) : undefined;
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
			patchRunStatus(config.runDir, {
				runId: config.runId,
				state: "failed",
				pid: process.pid,
				heartbeatAt: Date.now(),
				exitCode: 1,
				error: error instanceof Error ? error.message : String(error),
			});
			process.exitCode = 1;
		}
	} finally {
		if (heartbeat !== undefined) clearInterval(heartbeat);
		await runtime?.dispose().catch(() => undefined);
	}
}

function readConfig(path: string): HyperchartRunnerConfig {
	const value = JSON.parse(readFileSync(path, "utf8")) as Partial<HyperchartRunnerConfig>;
	if (
		typeof value.runId !== "string" ||
		typeof value.runDir !== "string" ||
		typeof value.chartPath !== "string" ||
		typeof value.chartId !== "string" ||
		typeof value.workDir !== "string" ||
		typeof value.agentDir !== "string"
	) {
		throw new Error(`Invalid hyperchart runner config: ${path}`);
	}
	return {
		runId: value.runId,
		runDir: value.runDir,
		chartPath: value.chartPath,
		chartId: value.chartId,
		workDir: value.workDir,
		agentDir: value.agentDir,
		...(typeof value.exportName === "string" ? { exportName: value.exportName } : {}),
		...(isRecord(value.args) ? { args: value.args } : {}),
		...(typeof value.defaultModel === "string" ? { defaultModel: value.defaultModel } : {}),
		...(value.ignoreReplayWarnings === true ? { ignoreReplayWarnings: true } : {}),
	};
}

function formatReplayWarningsError(runDir: string, warnings: readonly string[]): string {
	return [
		"Replay over the current chart produced warning-level compatibility issues.",
		...warnings,
		`Resolve them by rewinding, or explicitly confirm continuing with: hyperchart_run runDir=${runDir} ignoreReplayWarnings=true`,
	].join("\n");
}

function formatReplayCompatibilityError(runDir: string, explanation: ReplayExplanation): string {
	const broken = explanation.broken;
	if (broken === undefined) return "Replay compatibility check failed";
	const target = broken.invokeSeqId ?? broken.seqId;
	return [
		`Replay over the current chart is incompatible at seqId ${broken.seqId}${broken.state === undefined ? "" : ` (${broken.state})`}.`,
		`Original error: ${broken.error}`,
		`Rewind to the compatible prefix explicitly before resuming: hyperchart_rewind runDir=${runDir} seqId=${target} mode=before`,
		`Or use: hyperchart_rewind runDir=${runDir} to=compatible`,
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

function createModelRegistry(agentDir: string): ModelRegistry {
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	return ModelRegistry.create(authStorage, join(agentDir, "models.json"));
}

function installSignalHandlers(runDir: string): void {
	const stop = async (signal: NodeJS.Signals) => {
		if (stopping) return;
		stopping = true;
		if (heartbeat !== undefined) clearInterval(heartbeat);
		const exitCode = signal === "SIGTERM" ? 143 : 130;
		patchRunStatus(runDir, {
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1]?.endsWith("hyperchart_runner.ts")) {
	void main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
