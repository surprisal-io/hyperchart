import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { z } from "zod";
import { inspectChartAst, parseChartModuleSync } from "@surprisal/hyperchart";
import {
	assertChartPreflight,
	createRunDir,
	loadRunMeta,
	saveRunMeta,
	type HyperchartRunnerConfig,
	type RunMeta,
} from "@surprisal/hyperchart/runtime";
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
import { claudeHostPaths, claudeRunsRoot } from "../claude/paths.js";
import { createClaudeAgentDefaultsResolver } from "../claude/agent_definitions.js";
import { spawnDetachedRunner, watchRun } from "./spawn_runner.js";

export type HyperchartMcpDeps = {
	/** Working directory of the Claude session the MCP server belongs to. */
	cwd: string;
	runsRoot?: string;
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
				const charts = paths.listProjectHypercharts(cwd);
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
				return ok({ projectChartsDir: paths.getProjectHyperchartsDir(cwd), charts, runs });
			},
		},
		{
			name: "hyperchart_inspect",
			description: "Statically validate and inspect a chart definition without running it.",
			inputSchema: {
				chartPath: z.string().describe("Chart name or path (resolved against project and user chart dirs)"),
				exportName: z.string().optional(),
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
				return ok(inspected);
			},
		},
		{
			name: "hyperchart_run",
			description:
				"Start a chart as a detached background run, or resume an existing run directory. Returns the run id and directory.",
			inputSchema: {
				chartPath: z.string().optional(),
				runDir: z.string().optional().describe("Existing run id or directory to resume"),
				args: z.record(z.string(), z.unknown()).optional(),
				exportName: z.string().optional(),
				ignoreReplayWarnings: z.boolean().optional(),
				defaultModel: z.string().optional(),
				wait: z.boolean().optional().describe("Block until the run reaches a terminal status"),
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
					});
				}
				mkdirSync(resolve(runDir, "sessions"), { recursive: true });
				const runId = basename(runDir);
				const existingStatus = readRunStatus(runDir);
				if (isRunLive(existingStatus)) {
					if (args.wait === true) return ok({ runId, runDir, chartId: parsed.ast.id, status: await watchRun(runDir) });
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
				};
				const pid = spawnDetachedRunner(config);
				patchRunStatus(runDir, { runId, chartId: parsed.ast.id, state: "running", pid, heartbeatAt: Date.now() });
				if (args.wait === true) {
					const status = await watchRun(runDir);
					return ok({ runId, runDir, chartId: parsed.ast.id, status });
				}
				return ok({ runId, runDir, chartId: parsed.ast.id, pid });
			},
		},
		{
			name: "hyperchart_run_inspect",
			description: "Inspect the durable state of one run: states, transitions, sessions, artifacts, issues.",
			inputSchema: {
				runDir: z.string().describe("Run id or directory"),
				...cwdField,
			},
			handler: async (args) => {
				const cwd = cwdOf(args);
				const runDir = resolveRunDirArg(args.runDir as string, cwd);
				const meta = loadRunMeta(runDir);
				const run = await hyperchartRunFromRunDir(runDir, {
					agentDefaults: createClaudeAgentDefaultsResolver(meta.workDir, meta.chartPath),
				});
				return ok(run);
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
			description: "Open the localhost browser inspector for a run and return its URL.",
			inputSchema: {
				runDir: z.string(),
				open: z.boolean().optional().describe("Set false to return the URL without opening a browser"),
				...cwdField,
			},
			handler: async (args) => {
				const cwd = cwdOf(args);
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
					...(args.open === false
						? { openBrowser: () => undefined }
						: deps.openBrowser === undefined
							? {}
							: { openBrowser: deps.openBrowser }),
				});
				return ok({ url });
			},
		},
	];
}

function ok(value: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): ToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
