import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { z } from "zod";
import { inspectChartAst, parseChartModuleSync } from "@surprisal/hyperchart";
import {
	USER_INTERACTION_WAIT_LEASE_MS,
	acquireActiveUserInteraction,
	assertChartPreflight,
	claimTerminalNotificationReceipt,
	claimUserInteractionReceipt,
	createRunDir,
	listHyperchartFiles,
	loadHostSettings,
	loadRunMeta,
	readDeliverableTerminalNotificationRequest,
	readUserInteractionClose,
	readUserInteractionResponse,
	rewindHyperchartRun,
	saveRunMeta,
	validateAndPersistUserInteractionResponse,
	type HyperchartRunnerConfig,
	type OwnedUserInteraction,
	type RunMeta,
	type UserInteractionOwner,
} from "@surprisal/hyperchart/runtime";
import { hyperchartRunFromInspectResult, summarizeChartInspect, summarizeRunInspect } from "@surprisal/hyperchart/host";
import { hyperchartRunFromRunDir } from "@surprisal/hyperchart/inspect";
import { openRunInspector } from "@surprisal/hyperchart/inspect";
import {
	isPidAlive,
	isRunLive,
	patchRunStatus,
	queueSessionSteering,
	readRunStatus,
	readSessionProgress,
} from "@surprisal/hyperchart/sessions";
import { claudeHostPaths, claudeRunsRoot, claudeUserChartsDir } from "../claude/paths.js";
import { createClaudeAgentDefaultsResolver } from "../claude/agent_definitions.js";
import {
	claudeUserInteractionDetails,
	claudeUserInteractionInstruction,
	ownedClaudeUserInteractionSummary,
} from "../monitor.js";
import { spawnDetachedRunner, watchRun } from "./spawn_runner.js";

export type HyperchartMcpDeps = {
	/** Working directory of the Claude session the MCP server belongs to. */
	cwd: string;
	runsRoot?: string;
	/** Owning Claude Code session, captured once by the MCP server. */
	sessionId?: string;
	/** Test seam: replaces opening the system browser for hyperchart_view. */
	openBrowser?: (url: string) => void | Promise<void>;
};

export type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

export type HyperchartMcpTool = {
	name: string;
	description: string;
	inputSchema: z.ZodRawShape;
	handler(args: Record<string, unknown>): Promise<ToolResult>;
};

const cwdField = {
	cwd: z.string().optional().describe("Working directory override; defaults to the session working directory"),
};

export function createHyperchartMcpTools(deps: HyperchartMcpDeps): HyperchartMcpTool[] {
	const runsRoot = () => deps.runsRoot ?? claudeRunsRoot();
	const cwdOf = (args: Record<string, unknown>) => (typeof args.cwd === "string" ? args.cwd : deps.cwd);
	const interactionOwner = (cwd: string): UserInteractionOwner | undefined => deps.sessionId === undefined
		? undefined
		: { runsRoot: runsRoot(), host: "claude", sessionId: deps.sessionId, workDir: cwd };
	const resolveRunDirArg = (spec: string, cwd: string) => {
		if (spec.includes("/") || spec.includes("\\") || spec.startsWith(".")) return resolve(cwd, spec);
		return resolve(runsRoot(), spec);
	};

	return [
		{
			name: "hyperchart_list",
			description:
				"List Hyperchart definitions (project .claude/hypercharts and user ~/.claude/hypercharts) and this directory's runs.",
			inputSchema: { ...cwdField },
			handler: async (args) => {
				const cwd = cwdOf(args);
				const paths = claudeHostPaths();
				const projectChartsDir = paths.getProjectHyperchartsDir(cwd);
				const sharedChartsDir = paths.getSharedHyperchartsDir(cwd);
				const userChartsDir = claudeUserChartsDir();
				// Weakest scope first so a stronger chart with the same name wins,
				// matching resolveChartPath's candidate order.
				const chartsByName = new Map<string, { name: string; scope: "user" | "shared" | "project"; chartPath: string }>();
				for (const [scope, root] of [
					["user", userChartsDir],
					...(sharedChartsDir === undefined ? [] : ([["shared", sharedChartsDir]] as const)),
					["project", projectChartsDir],
				] as const) {
					for (const chartPath of listHyperchartFiles(root)) {
						const name = chartNameFor(chartPath, root);
						chartsByName.set(name, { name, scope, chartPath });
					}
				}
				const runs = runDirsFor(runsRoot(), cwd).map((runDir) => {
					const status = readRunStatus(runDir);
					return {
						runId: basename(runDir),
						runDir,
						chartId: status?.chartId ?? loadRunMeta(runDir).chartId,
						state: status?.state ?? "unknown",
						updatedAt: status?.updatedAt,
					};
				});
				return ok({ projectChartsDir, userChartsDir, charts: [...chartsByName.values()], runs });
			},
		},
		{
			name: "hyperchart_inspect",
			description:
				"Statically validate and inspect a chart definition without running it. Returns a compact digest by default; pass verbose=true for the full object (large — includes chart source and schemas).",
			inputSchema: {
				chartPath: z.string().describe("Chart name or path (resolved against project and user chart dirs)"),
				exportName: z.string().optional(),
				verbose: z.boolean().optional().describe("Return the full inspection object instead of the compact digest"),
				...cwdField,
			},
			handler: async (args) => {
				const cwd = cwdOf(args);
				const chartPath = claudeHostPaths().resolveChartPath(args.chartPath as string, cwd);
				await assertChartPreflight(chartPath);
				const parsed = parseChartModuleSync(
					chartPath,
					typeof args.exportName === "string" ? { exportName: args.exportName } : {},
				);
				if (!parsed.ok) return fail(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
				const inspected = inspectChartAst(parsed.ast, {
					chartPath,
					agentDefaults: createClaudeAgentDefaultsResolver(cwd, chartPath),
				});
				return ok(args.verbose === true ? inspected : summarizeChartInspect(inspected));
			},
		},
		{
			name: "hyperchart_run",
			description:
				"Start a chart as a detached background run, or resume an existing run directory. Updates are delivered automatically by the Hyperchart plugin monitor; Claude must not start Bash/Monitor polling watchers. wait=true returns at either terminal status or the session arbiter's active user-input gate.",
			inputSchema: {
				chartPath: z.string().optional(),
				runDir: z.string().optional().describe("Existing run id or directory to resume"),
				args: z.record(z.string(), z.unknown()).optional(),
				exportName: z.string().optional(),
				ignoreReplayWarnings: z.boolean().optional(),
				defaultModel: z.string().optional(),
				wait: z.boolean().optional().describe("Block only this current task until terminal status or an owned active user gate; do not start polling watchers"),
				...cwdField,
			},
			handler: async (args) => {
				const cwd = cwdOf(args);
				const requestedRunDir = typeof args.runDir === "string" ? resolveRunDirArg(args.runDir, cwd) : undefined;
				let meta: RunMeta | undefined;
				let chartPath: string;
				let exportName = typeof args.exportName === "string" ? args.exportName : undefined;
				let workDir = cwd;
				if (requestedRunDir !== undefined && typeof args.chartPath !== "string") {
					meta = loadRunMeta(requestedRunDir);
					if (resolve(meta.workDir) !== resolve(cwd)) {
						return fail(`Run '${basename(requestedRunDir)}' belongs to ${meta.workDir}; run from that directory`);
					}
					chartPath = meta.chartPath;
					exportName = meta.exportName;
					workDir = meta.workDir;
				} else if (typeof args.chartPath === "string") {
					chartPath = claudeHostPaths().resolveChartPath(args.chartPath, cwd);
				} else {
					return fail("hyperchart_run requires chartPath unless runDir points at an existing run");
				}

				await assertChartPreflight(chartPath);
				const parsed = parseChartModuleSync(chartPath, exportName === undefined ? {} : { exportName });
				if (!parsed.ok) return fail(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));

				const runDir = requestedRunDir ?? createRunDir(workDir, parsed.ast.id, { rootDir: runsRoot() });
				if (meta === undefined) {
					saveRunMeta(runDir, {
						chartPath,
						...(exportName === undefined ? {} : { exportName }),
						workDir,
						chartId: parsed.ast.id,
						createdAt: new Date().toISOString(),
						...(deps.sessionId === undefined ? {} : { originSessionId: deps.sessionId }),
					});
				}
				mkdirSync(resolve(runDir, "sessions"), { recursive: true });
				const runId = basename(runDir);
				const existingStatus = readRunStatus(runDir);
				if (isRunLive(existingStatus)) {
					if (args.wait === true) {
						const boundary = await watchClaudeRunBoundary(runDir, interactionOwner(cwd));
						if (boundary.kind === "user") return waitedUserInteractionResult(boundary.interaction, { runId, runDir, chartId: parsed.ast.id });
						return waitedRunResult(runDir, meta ?? loadRunMeta(runDir), deps.sessionId, { runId, runDir, chartId: parsed.ast.id, status: boundary.status });
					}
					return ok({ runId, runDir, chartId: parsed.ast.id, attached: true, status: existingStatus });
				}

				patchRunStatus(runDir, {
					runId,
					chartId: parsed.ast.id,
					state: "starting",
					heartbeatAt: Date.now(),
					error: undefined,
					exitCode: undefined,
				});
				const hostPaths = claudeHostPaths();
				const sharedChartsDir = hostPaths.getSharedHyperchartsDir(workDir);
				const { modelRoles, toolsets } = loadHostSettings(
					[
						claudeUserChartsDir(),
						...(sharedChartsDir === undefined ? [] : [sharedChartsDir]),
						hostPaths.getProjectHyperchartsDir(workDir),
					],
					"claude",
				);
				const config: HyperchartRunnerConfig = {
					runId,
					runDir,
					chartPath,
					chartId: parsed.ast.id,
					workDir,
					...(exportName === undefined ? {} : { exportName }),
					...(isRecord(args.args) ? { args: args.args } : {}),
					...(args.ignoreReplayWarnings === true ? { ignoreReplayWarnings: true } : {}),
					...(typeof args.defaultModel === "string" ? { defaultModel: args.defaultModel } : {}),
					...(Object.keys(modelRoles).length === 0 ? {} : { modelRoles }),
					...(Object.keys(toolsets).length === 0 ? {} : { toolsets }),
				};
				const pid = spawnDetachedRunner(config);
				patchRunStatus(runDir, { runId, chartId: parsed.ast.id, state: "running", pid, heartbeatAt: Date.now() });
				if (args.wait === true) {
					const boundary = await watchClaudeRunBoundary(runDir, interactionOwner(cwd));
					if (boundary.kind === "user") return waitedUserInteractionResult(boundary.interaction, { runId, runDir, chartId: parsed.ast.id });
					return waitedRunResult(runDir, loadRunMeta(runDir), deps.sessionId, { runId, runDir, chartId: parsed.ast.id, status: boundary.status });
				}
				return ok({
					runId,
					runDir,
					chartId: parsed.ast.id,
					pid,
					updates: "Terminal updates are automatic; do not start Bash/Monitor polling watchers.",
					...(deps.sessionId === undefined
						? { limitation: "CLAUDE_CODE_SESSION_ID is unavailable, so automatic terminal notification ownership cannot be established." }
						: {}),
				});
			},
		},
		{
			name: "hyperchart_respond",
			description:
				"Commit the real result of native AskUserQuestion to the exact active Hyperchart user gate. Never call this with an inferred or model-authored answer.",
			inputSchema: {
				runId: z.string().min(1),
				seqId: z.number().int().positive(),
				event: z.string().min(1),
				output: z.unknown().optional(),
				...cwdField,
			},
			handler: async (args) => {
				try {
					const cwd = cwdOf(args);
					const owner = interactionOwner(cwd);
					if (owner === undefined) return fail("CLAUDE_CODE_SESSION_ID is unavailable; user interaction ownership cannot be established");
					const runId = args.runId as string;
					const seqId = args.seqId as number;
					if (args.event === "FAILED") return fail("FAILED is reserved and cannot be returned by a user");
					const event = {
						type: args.event as string,
						...(args.output === undefined ? {} : { output: args.output }),
					};
					const runDir = resolve(runsRoot(), runId);
					if (basename(runId) !== runId || dirname(canonicalPath(runDir)) !== canonicalPath(runsRoot())) {
						return fail(`Run coordinate '${runId}' is not a run id under the configured runs root`);
					}
					const meta = loadRunMeta(runDir);
					if (meta.originSessionId !== owner.sessionId) return fail(`Run '${runId}' is not owned by this session`);
					if (canonicalPath(meta.workDir) !== canonicalPath(cwd)) return fail(`Run '${runId}' belongs to another working directory`);

					// Identical retries are mailbox operations and remain valid even if the chart
					// source was subsequently moved or made unparsable. The shared helper still
					// enforces exact owner/cwd before its idempotent return.
					const hasResolution = readUserInteractionResponse(runDir, seqId) !== undefined ||
						readUserInteractionClose(runDir, seqId) !== undefined;
					if (hasResolution) {
						const committed = await validateAndPersistUserInteractionResponse({ runDir, runId, seqId, event, owner });
						return ok({ runId, seqId, event, committed: true, idempotent: committed.idempotent });
					}
					const active = acquireActiveUserInteraction(owner);
					if (active === undefined || active.request.runId !== runId || active.request.seqId !== seqId) {
						return fail(`User interaction (${runId}, ${seqId}) is not the active gate`);
					}

					const parsed = parseChartModuleSync(
						meta.chartPath,
						meta.exportName === undefined ? {} : { exportName: meta.exportName },
					);
					if (!parsed.ok) return fail(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
					const committed = await validateAndPersistUserInteractionResponse({
						runDir,
						runId,
						seqId,
						event,
						schemaRegistry: parsed.schemaRegistry,
						owner,
					});
					return ok({ runId, seqId, event, committed: true, idempotent: committed.idempotent });
				} catch (error) {
					return fail(error instanceof Error ? error.message : String(error));
				}
			},
		},
		{
			name: "hyperchart_run_inspect",
			description:
				"Inspect the durable state of one run: state statuses, sessions, artifacts, issues. Returns a compact digest by default; pass verbose=true for the full object (large — includes chart source, schemas, and transcripts).",
			inputSchema: {
				runDir: z.string().describe("Run id or directory"),
				verbose: z.boolean().optional().describe("Return the full inspection object instead of the compact digest"),
				...cwdField,
			},
			handler: async (args) => {
				const cwd = cwdOf(args);
				const runDir = resolveRunDirArg(args.runDir as string, cwd);
				const meta = loadRunMeta(runDir);
				const run = await hyperchartRunFromRunDir(runDir, {
					agentDefaults: createClaudeAgentDefaultsResolver(meta.workDir, meta.chartPath),
				});
				const inspected = args.verbose === true ? run : summarizeRunInspect(run);
				return ok({
					...inspected,
					userInteractions: ownedClaudeUserInteractionSummary({
						runsRoot: runsRoot(),
						cwd,
						...(deps.sessionId === undefined ? {} : { sessionId: deps.sessionId }),
					}),
				});
			},
		},
		{
			name: "hyperchart_stop",
			description: "Stop one run (SIGTERM to its runner) or all active runs for this directory.",
			inputSchema: {
				runDir: z.string().optional(),
				all: z.boolean().optional(),
				...cwdField,
			},
			handler: async (args) => {
				const cwd = cwdOf(args);
				if ((typeof args.runDir === "string") === (args.all === true)) {
					return fail("hyperchart_stop requires exactly one of runDir or all=true");
				}
				const targets =
					args.all === true
						? activeRunDirsForWorkDir(runsRoot(), cwd)
						: [resolveRunDirArg(args.runDir as string, cwd)];
				const stopped = targets.map((runDir) => stopRunDirectory(runDir, cwd));
				return ok({ stopped });
			},
		},
		{
			name: "hyperchart_rewind",
			description:
				"Back up and truncate a stopped run's durable log so replay can continue from a specific state or seqId (recovery after a durably-recorded failure).",
			inputSchema: {
				runDir: z.string().describe("Existing run directory or run id to rewind"),
				state: z.string().optional().describe("State path to rewind to, e.g. plan.verify-beats#key.verify"),
				seqId: z.number().optional().describe("Durable log seqId to rewind to"),
				to: z.literal("compatible").optional().describe("Cut to the first prefix compatible with the current chart"),
				mode: z.enum(["before", "after"]).optional().describe("Cut before or after the matching record. Default: before"),
				cleanupSessions: z
					.boolean()
					.optional()
					.describe("Remove downstream session progress and move downstream session dirs into the backup. Default: true"),
				cleanupArtifacts: z
					.boolean()
					.optional()
					.describe("Best-effort backup+remove artifact files declared by downstream actions. Default: false"),
				...cwdField,
			},
			handler: async (args) => {
				const cwd = cwdOf(args);
				const runDir = resolveRunDirArg(args.runDir as string, cwd);
				const result = await rewindHyperchartRun({
					runDir,
					...(typeof args.state === "string" ? { state: args.state } : {}),
					...(typeof args.seqId === "number" ? { seqId: args.seqId } : {}),
					...(args.to === "compatible" ? { to: "compatible" as const } : {}),
					mode: args.mode === "after" ? "after" : "before",
					cleanupSessions: args.cleanupSessions !== false,
					cleanupArtifacts: args.cleanupArtifacts === true,
					cwd,
				});
				return ok(result);
			},
		},
		{
			name: "hyperchart_steer",
			description: "Queue a steering message for a live agent session of a run (delivered after its current tool call).",
			inputSchema: {
				runDir: z.string(),
				actionKey: z.string().describe("Action key of the live session, as shown by hyperchart_run_inspect"),
				message: z.string(),
				...cwdField,
			},
			handler: async (args) => {
				const cwd = cwdOf(args);
				const runDir = resolveRunDirArg(args.runDir as string, cwd);
				const sessionsDir = resolve(runDir, "sessions");
				const session = readSessionProgress(sessionsDir).sessions[args.actionKey as string];
				if (session === undefined) return fail(`Agent session '${String(args.actionKey)}' was not found in this run`);
				if (session.status !== "starting" && session.status !== "running") {
					return fail(`Agent session '${session.actionName}' is ${session.status} and cannot be steered`);
				}
				const request = queueSessionSteering(sessionsDir, args.actionKey as string, args.message as string);
				return ok({ queued: true, requestId: request.id, actionName: session.actionName });
			},
		},
		{
			name: "hyperchart_view",
			description:
				"Open the localhost browser inspector and return its URL. Pass runDir for a live/finished run, or chartPath for a static view of a chart definition (reloads the chart on refresh).",
			inputSchema: {
				runDir: z.string().optional(),
				chartPath: z.string().optional().describe("Chart name or path to view statically (no run required)"),
				open: z.boolean().optional().describe("Set false to return the URL without opening a browser"),
				...cwdField,
			},
			handler: async (args) => {
				const cwd = cwdOf(args);
				if ((typeof args.runDir === "string") === (typeof args.chartPath === "string")) {
					return fail("hyperchart_view requires exactly one of runDir or chartPath");
				}
				const openBrowser =
					args.open === false
						? { openBrowser: () => undefined }
						: deps.openBrowser === undefined
							? {}
							: { openBrowser: deps.openBrowser };
				if (typeof args.chartPath === "string") {
					const chartPath = claudeHostPaths().resolveChartPath(args.chartPath, cwd);
					await assertChartPreflight(chartPath);
					const agentDefaults = createClaudeAgentDefaultsResolver(cwd, chartPath);
					const loadChart = () => {
						const parsed = parseChartModuleSync(chartPath);
						if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
						return hyperchartRunFromInspectResult(inspectChartAst(parsed.ast, { chartPath, agentDefaults }), { cwd });
					};
					const chartId = loadChart().chartName;
					const { url } = await openRunInspector({
						runId: `chart:${chartId}`,
						loadRun: async () => loadChart(),
						...openBrowser,
					});
					return ok({ url, chartId, chartPath });
				}
				const runDir = resolveRunDirArg(args.runDir as string, cwd);
				const meta = loadRunMeta(runDir);
				const sessionsDir = resolve(runDir, "sessions");
				const agentDefaults = createClaudeAgentDefaultsResolver(meta.workDir, meta.chartPath);
				const { url } = await openRunInspector({
					runId: basename(runDir),
					loadRun: () => hyperchartRunFromRunDir(runDir, { agentDefaults }),
					steerSession: (actionKey, message) => {
						queueSessionSteering(sessionsDir, actionKey, message);
					},
					...openBrowser,
				});
				return ok({ url });
			},
		},
	];
}

type ClaudeRunBoundary =
	| { kind: "terminal"; status: Awaited<ReturnType<typeof watchRun>> }
	| { kind: "user"; interaction: OwnedUserInteraction };

function watchClaudeRunBoundary(runDir: string, owner: UserInteractionOwner | undefined): Promise<ClaudeRunBoundary> {
	if (owner === undefined) return watchRun(runDir).then((status) => ({ kind: "terminal" as const, status }));
	return new Promise((resolveBoundary, rejectBoundary) => {
		let settled = false;
		const finish = (boundary: ClaudeRunBoundary) => {
			if (settled) return;
			settled = true;
			clearInterval(timer);
			resolveBoundary(boundary);
		};
		const inspectInteraction = () => {
			try {
				const active = acquireActiveUserInteraction(owner);
				if (active === undefined) return;
				if (active.presentation === "pending") {
					// Pin only. The MCP tool result has not yet been delivered, so confirmation
					// here would make a crash in the return window suppress recovery.
					claimUserInteractionReceipt(active.runDir, active.request.seqId, "claude", owner.sessionId, {
						source: "wait",
						leaseMs: USER_INTERACTION_WAIT_LEASE_MS,
					});
				}
				const current = acquireActiveUserInteraction(owner);
				if (current === undefined || interactionCoordinateKey(current) !== interactionCoordinateKey(active)) return;
				finish({ kind: "user", interaction: current });
			} catch {
				// Isolate malformed/concurrently-created mailboxes and keep watching.
			}
		};
		const timer = setInterval(inspectInteraction, 100);
		timer.unref();
		watchRun(runDir).then(
			(status) => finish({ kind: "terminal", status }),
			(error) => {
				if (settled) return;
				settled = true;
				clearInterval(timer);
				rejectBoundary(error);
			},
		);
		inspectInteraction();
	});
}

function interactionCoordinateKey(interaction: OwnedUserInteraction): string {
	return `${interaction.request.runId}\0${interaction.request.seqId}`;
}

function waitedUserInteractionResult(interaction: OwnedUserInteraction, waitedRun: { runId: string; runDir: string; chartId: string }): ToolResult {
	return ok({
		boundary: "user",
		final: false,
		runId: interaction.request.runId,
		runDir: interaction.runDir,
		chartId: interaction.request.actionUid.chart,
		interaction: claudeUserInteractionDetails(interaction),
		instruction: claudeUserInteractionInstruction(interaction),
		waitedRun,
		presentation: interaction.presentation === "confirmed" ? "confirmed-recovery" : "claimed-not-confirmed",
	});
}

function waitedRunResult(runDir: string, meta: RunMeta, sessionId: string | undefined, value: Record<string, unknown>): ToolResult {
	if (sessionId === undefined) {
		return ok({
			...value,
			limitation: "CLAUDE_CODE_SESSION_ID is unavailable; wait=true cannot claim a per-session receipt and automatic routing is disabled.",
		});
	}
	if (meta.originSessionId !== sessionId) {
		return ok({ ...value, limitation: "This run is not owned by the current Claude session; its terminal prompt was not receipted here." });
	}
	const request = readDeliverableTerminalNotificationRequest(runDir);
	if (request === undefined) return ok(value);
	if (!claimTerminalNotificationReceipt(runDir, "claude", sessionId)) {
		return ok({ ...value, notification: "Terminal prompt delivery is already confirmed or in progress for this Claude session." });
	}
	return { content: [{ type: "text", text: request.payload.prompt }] };
}

function ok(value: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): ToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

/** Derive the spec `resolveChartPath` accepts back: bundle dir for `<dir>/chart.ts`, else the filename without its chart extension. */
function chartNameFor(chartPath: string, root: string): string {
	const rel = relative(root, chartPath).replaceAll("\\", "/");
	if (rel !== "chart.ts" && rel.endsWith("/chart.ts")) return rel.slice(0, -"/chart.ts".length);
	return rel.replace(/(?:\.chart)?\.ts$/, "");
}

function runDirsFor(root: string, cwd: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.map((entry) => resolve(root, entry))
		.filter((path) => existsSync(resolve(path, "meta.json")))
		.filter((path) => {
			try {
				return resolve(loadRunMeta(path).workDir) === resolve(cwd);
			} catch {
				return false;
			}
		})
		.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
}

function activeRunDirsForWorkDir(root: string, cwd: string): string[] {
	return runDirsFor(root, cwd).filter((runDir) => {
		const status = readRunStatus(runDir);
		return status !== undefined && (isRunLive(status) || ["starting", "running", "stopping"].includes(status.state));
	});
}

function stopRunDirectory(runDir: string, cwd: string): { runId: string; runDir: string; pid?: number } {
	const meta = loadRunMeta(runDir);
	if (resolve(meta.workDir) !== resolve(cwd)) {
		throw new Error(`Run '${basename(runDir)}' belongs to ${meta.workDir}; run from that directory`);
	}
	const status = readRunStatus(runDir);
	patchRunStatus(runDir, { state: "stopping" });
	const pid = status?.pid !== undefined && isPidAlive(status.pid) ? status.pid : undefined;
	if (pid === undefined) patchRunStatus(runDir, { state: "stopped", exitCode: 0, error: "runner was not live" });
	else process.kill(pid, "SIGTERM");
	return { runId: basename(runDir), runDir, ...(pid === undefined ? {} : { pid }) };
}

function canonicalPath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
