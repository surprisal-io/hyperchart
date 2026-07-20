import { spawn } from "node:child_process";
import {
	closeSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createJiti } from "jiti";
import {
	createBranchProjection,
	explainReplay,
	inspectChartModuleSync,
	parseChartModuleSync,
	projectBranch,
	type BranchProjection,
	type ChartAst,
	type DurableLogRecord,
	type InputRef,
	type StatePath,
	type TemplateAst,
} from "@surprisal/hyperchart";
import { actionUidDirName, actionUidKey } from "@surprisal/hyperchart/internal/core/action_uid";
import { instancePathFor, nearestInstance, nodeAt, stripLastKey } from "@surprisal/hyperchart/internal/core/paths";
import {
	JsonlLogStore,
	assertChartPreflight,
	createRunDir,
	isFailureStatePath,
	loadRunMeta,
	saveRunMeta,
	type RunMeta,
	type RunTerminalState,
} from "@surprisal/hyperchart/runtime";
import {
	getHyperchartRunsRoot,
	getProjectHyperchartsDir,
	listHyperchartFiles,
	listProjectHypercharts,
	resolveHyperchartPath,
	resolveHyperchartRunDir,
} from "../src/runtime/pi/paths.js";
import {
	isPidAlive,
	isRunLive,
	isTerminalRunState,
	patchRunStatus,
	queueSessionSteering,
	readRunStatus,
	readSessionProgress,
	sessionProgressPath,
	type HyperchartRunStatus,
} from "@surprisal/hyperchart/sessions";
import type { HyperchartRunnerConfig } from "../src/runtime/pi/hyperchart_runner.js";
import { createAgentDefaultsResolver } from "../src/runtime/pi/agent_definitions.js";
import {
	RunHistoryOverlay,
	RunWidget,
	type RunHistoryAction,
	type RunHistoryItem,
} from "../src/tui/components.js";
import { buildRunView, type RunView } from "../src/tui/run_view.js";
import { hyperchartRunFromRunDir } from "../src/runtime/pi/run_inspect.js";
import { closeRunInspectorServer, openRunInspector } from "@surprisal/hyperchart/inspect";

const require = createRequire(import.meta.url);
import { HYPERCHART_COMMAND_EVENT, type HyperchartCommandRequest } from "../src/command.js";

type RunSnapshot = {
	runId: string;
	runDir: string;
	ast: ChartAst;
	status?: HyperchartRunStatus;
	live: boolean;
};
type RunHistoryEntry = {
	runId: string;
	runDir: string;
	meta: RunMeta;
	status?: HyperchartRunStatus;
	live: boolean;
	final: boolean;
	terminalState?: RunTerminalState;
	sessionCount: number;
	updatedAt: number;
};
type ActiveRun = RunSnapshot & { done: Promise<HyperchartRunStatus> };
type HyperchartContext = Pick<ExtensionContext, "cwd" | "mode" | "model" | "sessionManager" | "ui">;
type RunStartOptions = {
	chartPath?: string;
	args?: Record<string, unknown>;
	runDir?: string;
	exportName?: string;
	ignoreReplayWarnings?: boolean;
};
type RunStartResult = { runId: string; runDir: string; chartId: string; done: Promise<HyperchartRunStatus> };

class RunManager {
	readonly active = new Map<string, ActiveRun>();
	lastRunId: string | undefined;

	add(run: ActiveRun): void {
		this.active.set(run.runId, run);
		this.lastRunId = run.runId;
	}

	remove(runId: string): void {
		this.active.delete(runId);
	}

	get(runId: string | undefined): ActiveRun | undefined {
		return this.active.get(runId ?? this.lastRunId ?? "");
	}
}

const runs = new RunManager();
const runnerEntry = fileURLToPath(new URL("../src/runtime/pi/hyperchart_runner.mjs", import.meta.url));
const SUBCOMMAND_COMPLETIONS: AutocompleteItem[] = [
	{ value: "run", label: "run", description: "start chart" },
	{ value: "resume", label: "resume", description: "resume run id" },
	{ value: "steer", label: "steer", description: "steer a live agent session" },
	{ value: "restart", label: "restart", description: "restart run as new run" },
	{ value: "stop", label: "stop", description: "stop run id" },
	{ value: "delete", label: "delete", description: "delete old run dir" },
	{ value: "rm", label: "rm", description: "delete old run dir" },
	{ value: "view", label: "view", description: "open run view" },
	{ value: "status", label: "status", description: "show active runs" },
	{ value: "--limit", label: "--limit", description: "limit default run list" },
];
const RUN_OPTION_COMPLETIONS: AutocompleteItem[] = [
	{ value: "--args", label: "--args", description: "JSON args" },
	{ value: "--run-dir", label: "--run-dir", description: "resume/destination run dir" },
	{ value: "--export", label: "--export", description: "named chart export" },
	{ value: "--wait", label: "--wait", description: "wait synchronously for completion" },
	{ value: "--ignore-replay-warnings", label: "--ignore-replay-warnings", description: "explicitly continue despite stale/skipped replay warnings" },
];
const HYPERCHART_USAGE =
	"Usage: /hyperchart [runId|--limit N] | run <name|chart.ts> [--args JSON] [--run-dir RUN_ID|DIR] [--export NAME] [--wait] [--ignore-replay-warnings] | resume <runId> [--ignore-replay-warnings] | steer <runId> <actionKey> <message> | restart <runId> | status | stop <runId> | delete <runId> | view [runId]";

function completeHyperchartArgs(argumentPrefix: string): AutocompleteItem[] | null {
	const parsed = parseCompletionPrefix(argumentPrefix);
	if (parsed.previous.length === 0) return completeTopLevelArgs(parsed.current);
	const command = parsed.previous[0];
	const previous = parsed.previous.slice(1);
	if (command === "run") return prependCompletionPrefix(completeRunArgs(previous, parsed.current), parsed.previous);
	if (command === "resume") return prependCompletionPrefix(completeResumeArgs(previous, parsed.current), parsed.previous);
	if (command === "steer" && previous.length === 0) {
		return prependCompletionPrefix(filterCompletions(runIdCompletions(process.cwd()), parsed.current), parsed.previous);
	}
	if (
		command === "restart" ||
		command === "stop" ||
		command === "view" ||
		command === "delete" ||
		command === "rm"
	) {
		return prependCompletionPrefix(filterCompletions(runIdCompletions(process.cwd()), parsed.current), parsed.previous);
	}
	if (command === "--limit") return null;
	return null;
}

function completeTopLevelArgs(current: string): AutocompleteItem[] | null {
	const commands = filterCompletions(SUBCOMMAND_COMPLETIONS, current) ?? [];
	const runs = filterCompletions(runIdCompletions(process.cwd()), current) ?? [];
	const items = [...commands, ...runs];
	return items.length === 0 ? null : items;
}

function completeResumeArgs(previous: string[], current: string): AutocompleteItem[] | null {
	if (current.startsWith("--")) {
		return filterCompletions(
			[{ value: "--ignore-replay-warnings", label: "--ignore-replay-warnings", description: "explicitly continue despite stale/skipped replay warnings" }],
			current,
		);
	}
	const hasRunId = previous.some((token) => !token.startsWith("--"));
	if (hasRunId) return current.length === 0 ? completeResumeArgs([], "--") : null;
	return filterCompletions(runIdCompletions(process.cwd()), current);
}

function completeRunArgs(previous: string[], current: string): AutocompleteItem[] | null {
	const last = previous.at(-1);
	if (last === "--run-dir") return filterCompletions(runIdCompletions(process.cwd()), current);
	if (last === "--args" || last === "--export") return null;
	if (current.startsWith("--")) return filterCompletions(RUN_OPTION_COMPLETIONS, current);
	const hasChart = previous.some(
		(token, index) =>
			!token.startsWith("--") &&
			previous[index - 1] !== "--run-dir" &&
			previous[index - 1] !== "--args" &&
			previous[index - 1] !== "--export",
	);
	if (hasChart) return current.length === 0 ? filterCompletions(RUN_OPTION_COMPLETIONS, current) : null;
	return filterCompletions(chartCompletions(process.cwd()), current);
}

function prependCompletionPrefix(
	items: AutocompleteItem[] | null,
	previous: readonly string[],
): AutocompleteItem[] | null {
	if (items === null) return null;
	const prefix = previous.length === 0 ? "" : `${previous.join(" ")} `;
	return items.map((item) => ({ ...item, value: `${prefix}${item.value}` }));
}

function parseCompletionPrefix(prefix: string): { previous: string[]; current: string } {
	const trailingSpace = /\s$/.test(prefix);
	const tokens = safeTokenize(prefix);
	if (trailingSpace) return { previous: tokens, current: "" };
	return { previous: tokens.slice(0, -1), current: tokens.at(-1) ?? "" };
}

function safeTokenize(input: string): string[] {
	try {
		return tokenize(input);
	} catch {
		return input.trim().split(/\s+/).filter(Boolean);
	}
}

function chartCompletions(cwd: string): AutocompleteItem[] {
	return listProjectHypercharts(cwd).map((file) => {
		const name = file.replace(/\.chart\.ts$/, "").replace(/\.ts$/, "");
		return { value: name, label: name, description: file };
	});
}

function runIdCompletions(cwd: string): AutocompleteItem[] {
	const root = getHyperchartRunsRoot();
	if (!existsSync(root)) return [];
	return runDirs(root)
		.map((runDir) => runCompletionItem(runDir, cwd))
		.filter((item): item is AutocompleteItem => item !== undefined);
}

function runCompletionItem(runDir: string, cwd: string): AutocompleteItem | undefined {
	try {
		const meta = loadRunMeta(runDir);
		if (resolve(meta.workDir) !== resolve(cwd)) return undefined;
		const status = readRunStatus(runDir);
		const state = isRunLive(status) ? "running" : (status?.state ?? "stale");
		return { value: basename(runDir), label: basename(runDir), description: `${meta.chartId} · ${state}` };
	} catch {
		return undefined;
	}
}

function filterCompletions(items: readonly AutocompleteItem[], current: string): AutocompleteItem[] | null {
	const needle = current.toLowerCase();
	const filtered = items.filter(
		(item) => item.value.toLowerCase().includes(needle) || item.label.toLowerCase().includes(needle),
	);
	return filtered.length === 0 ? null : filtered;
}

export default function register(pi: ExtensionAPI) {
	registerBundleExtensions(pi, process.cwd());
	let currentCtx: HyperchartContext | undefined;
	pi.registerCommand("hyperchart", {
		description: "Run and inspect hyperchart workflows",
		handler: async (args, ctx) => dispatch(args, ctx),
		getArgumentCompletions: (prefix) => completeHyperchartArgs(prefix),
	});
	pi.registerTool(hyperchartTool);
	pi.events.on(HYPERCHART_COMMAND_EVENT, (payload) => {
		const request = payload as HyperchartCommandRequest;
		request.claim(async () => {
			if (currentCtx === undefined) throw new Error("Hyperchart session context is not ready");
			await dispatch(request.args, currentCtx, false);
		});
	});
	pi.on("session_start", async (event, ctx) => {
		currentCtx = ctx;
		if (event.reason === "reload" || event.reason === "startup" || event.reason === "resume") {
			await restoreRunWidgets(ctx);
		}
	});
	pi.on("session_shutdown", async () => {
		currentCtx = undefined;
		await closeRunInspectorServer();
	});
}

function registerBundleExtensions(pi: ExtensionAPI, cwd: string): void {
	for (const bundleDir of discoverBundleDirs(cwd)) {
		const extensionsDir = join(bundleDir, "extensions");
		for (const entryPath of bundleExtensionEntries(extensionsDir)) {
			try {
				const jiti = createJiti(pathToFileURL(entryPath).href, {
					interopDefault: true,
					moduleCache: false,
					alias: { typebox: require.resolve("typebox") },
				});
				const loaded = jiti(entryPath) as unknown;
				const register = typeof loaded === "function"
					? loaded
					: typeof (loaded as { default?: unknown })?.default === "function"
						? (loaded as { default: (api: ExtensionAPI) => void }).default
						: undefined;
				if (register === undefined) throw new Error("default export must be an extension registration function");
				register(pi);
			} catch (error) {
				console.warn(`[pi-hyperchart] Failed to load bundle extension ${entryPath}:`, error);
			}
		}
	}
}

function discoverBundleDirs(cwd: string): string[] {
	const projectRoot = getProjectHyperchartsDir(cwd);
	const userRoot = resolve(getAgentDir(), "hypercharts");
	const byName = new Map<string, string>();
	for (const root of [userRoot, projectRoot]) {
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "runs" || entry.name === "node_modules") continue;
			const bundleDir = join(root, entry.name);
			if (!(entry.isDirectory() || (entry.isSymbolicLink() && existsSync(bundleDir) && statSync(bundleDir).isDirectory()))) continue;
			if (existsSync(join(bundleDir, "chart.ts"))) byName.set(entry.name, bundleDir);
		}
	}
	return [...byName.values()];
}

function bundleExtensionEntries(extensionsDir: string): string[] {
	if (!existsSync(extensionsDir)) return [];
	const entries: string[] = [];
	if (existsSync(join(extensionsDir, "index.ts"))) entries.push(join(extensionsDir, "index.ts"));
	for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
		if (entry.isDirectory() && !entry.name.startsWith(".") && existsSync(join(extensionsDir, entry.name, "index.ts"))) {
			entries.push(join(extensionsDir, entry.name, "index.ts"));
		}
	}
	return entries.sort();
}

const hyperchartTool = defineTool({
	name: "hyperchart",
	label: "Hyperchart",
	description: "List, inspect, run, inspect runs, and rewind durable Hyperchart workflows.",
	parameters: Type.Object({
		action: Type.Union([
			Type.Literal("list"),
			Type.Literal("inspect"),
			Type.Literal("run"),
			Type.Literal("run_inspect"),
			Type.Literal("rewind"),
			Type.Literal("stop"),
		]),
		chartPath: Type.Optional(Type.String()),
		args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		runDir: Type.Optional(Type.String()),
		exportName: Type.Optional(Type.String()),
		wait: Type.Optional(Type.Boolean()),
		ignoreReplayWarnings: Type.Optional(Type.Boolean()),
		state: Type.Optional(Type.String()),
		seqId: Type.Optional(Type.Number()),
		to: Type.Optional(Type.Literal("compatible")),
		mode: Type.Optional(Type.Union([Type.Literal("before"), Type.Literal("after")])),
		cleanupSessions: Type.Optional(Type.Boolean()),
		cleanupArtifacts: Type.Optional(Type.Boolean()),
		start: Type.Optional(Type.Boolean()),
		all: Type.Optional(Type.Boolean()),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		if (params.action === "list") return listHypercharts(ctx.cwd);
		if (params.action === "inspect") {
			if (params.chartPath === undefined) throw new Error("hyperchart action=inspect requires chartPath");
			return hyperchartInspectTool.execute(toolCallId, { chartPath: params.chartPath, exportName: params.exportName }, signal, onUpdate, ctx);
		}
		if (params.action === "run") {
			if (params.chartPath === undefined && params.runDir === undefined) throw new Error("hyperchart action=run requires chartPath or runDir");
			return hyperchartRunTool.execute(toolCallId, params, signal, onUpdate, ctx);
		}
		if (params.action === "run_inspect") {
			if (params.runDir === undefined) throw new Error("hyperchart action=run_inspect requires runDir");
			return hyperchartRunInspectTool.execute(toolCallId, { runDir: params.runDir }, signal, onUpdate, ctx);
		}
		if (params.action === "stop") return stopHyperchartRuns(params, ctx);
		if (params.runDir === undefined) throw new Error("hyperchart action=rewind requires runDir");
		return hyperchartRewindTool.execute(toolCallId, params, signal, onUpdate, ctx);
	},
});

function listHypercharts(cwd: string) {
	const projectRoot = getProjectHyperchartsDir(cwd);
	const userRoot = resolve(getAgentDir(), "hypercharts");
	const byName = new Map<string, { name: string; scope: "user" | "project"; path: string }>();
	for (const [scope, root, files] of [
		["user", userRoot, listHyperchartFiles(userRoot)],
		["project", projectRoot, listProjectHypercharts(cwd).map((file) => resolve(projectRoot, file))],
	] as const) {
		for (const path of files) {
			const rel = relative(root, path).replaceAll("\\", "/");
			const name = rel.endsWith("/chart.ts")
				? rel.slice(0, -"/chart.ts".length)
				: rel.replace(/\.chart\.ts$/, "").replace(/\.ts$/, "");
			byName.set(name, { name, scope, path: resolve(path) });
		}
	}
	const charts = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
	const text = charts.length === 0
		? "No Hyperchart definitions found"
		: [
			`Found ${charts.length} Hyperchart definition${charts.length === 1 ? "" : "s"}:`,
			...charts.map((chart) => `- ${chart.name} [${chart.scope}] ${chart.path}`),
		].join("\n");
	return {
		content: [{ type: "text" as const, text }],
		details: { charts },
	};
}

const hyperchartRunTool = defineTool({
	name: "hyperchart_run",
	label: "Run Hyperchart",
	description: "Start or resume a pi-hyperchart workflow run from a chart module.",
	parameters: Type.Object({
		chartPath: Type.Optional(
			Type.String({ description: "Hyperchart name in .pi/hypercharts, or a chart module path" }),
		),
		args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Run arguments JSON object" })),
		runDir: Type.Optional(
			Type.String({ description: "Existing run directory to resume, or destination run directory" }),
		),
		exportName: Type.Optional(Type.String({ description: "Named export to load from the chart module" })),
		wait: Type.Optional(Type.Boolean({ description: "Wait for the run to finish before returning" })),
		ignoreReplayWarnings: Type.Optional(Type.Boolean({ description: "Explicitly continue despite stale/skipped replay warnings. Default: false" })),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const result = await startHyperchartRun(
			{
				...(params.chartPath === undefined ? {} : { chartPath: params.chartPath }),
				...(params.args === undefined ? {} : { args: params.args as Record<string, unknown> }),
				...(params.runDir === undefined ? {} : { runDir: params.runDir }),
				...(params.exportName === undefined ? {} : { exportName: params.exportName }),
				...(params.ignoreReplayWarnings === true ? { ignoreReplayWarnings: true } : {}),
			},
			ctx,
		);
		if (params.wait === true) {
			const status = await result.done;
			const inspector = await inspectRunForCurrentWorkDir(result.runDir, ctx);
			return {
				content: [{ type: "text", text: `Hyperchart run ${result.runId} ${status.state} (${result.runDir})` }],
				details: { runId: result.runId, runDir: result.runDir, chartId: result.chartId, status, inspector },
			};
		}
		const inspector = await inspectRunForCurrentWorkDir(result.runDir, ctx);
		return {
			content: [{ type: "text", text: `Started hyperchart run ${result.runId} (${result.runDir})` }],
			details: { runId: result.runId, runDir: result.runDir, chartId: result.chartId, final: false, inspector },
		};
	},
});

async function inspectRunForCurrentWorkDir(runDir: string, ctx: HyperchartContext, ast?: ChartAst) {
	const meta = loadRunMetaForCurrentWorkDir(runDir, ctx.cwd);
	if (meta === undefined) throw new Error(`Run '${basename(runDir)}' belongs to another working directory or is missing metadata`);
	return hyperchartRunFromRunDir(runDir, {
		meta,
		...(ast === undefined ? {} : { ast }),
		agentDefaults: createAgentDefaultsResolver(ctx.cwd, getAgentDir(), meta.chartPath),
	});
}

const hyperchartInspectTool = defineTool({
	name: "hyperchart_inspect",
	label: "Inspect Hyperchart",
	description: "Parse a Hyperchart chart module and return its static state graph without starting a run.",
	parameters: Type.Object({
		chartPath: Type.String({ description: "Hyperchart name in .pi/hypercharts, or a chart module path" }),
		exportName: Type.Optional(Type.String({ description: "Named export to inspect" })),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const chartPath = resolveHyperchartPath(params.chartPath, ctx.cwd);
		const agentDefaults = createAgentDefaultsResolver(ctx.cwd, getAgentDir(), chartPath);
		const result = inspectChartModuleSync(
			chartPath,
			{
				...(params.exportName === undefined ? {} : { exportName: params.exportName }),
				agentDefaults,
			},
		);
		return {
			content: [
				{
					type: "text",
					text: `Inspected hyperchart ${result.chartId}: ${result.states.length} states (${result.chartPath}). No run was started.`,
				},
			],
			details: result,
		};
	},
});

const hyperchartRunInspectTool = defineTool({
	name: "hyperchart_run_inspect",
	label: "Inspect Hyperchart Run",
	description: "Load a concrete Hyperchart run directory and return the runtime-enriched inspector model.",
	parameters: Type.Object({
		runDir: Type.String({ description: "Run id or run directory to inspect" }),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const runDir = resolveHyperchartRunDir(params.runDir, ctx.cwd);
		const inspector = await inspectRunForCurrentWorkDir(runDir, ctx);
		const issueCount = (inspector.issues?.length ?? 0) + inspector.states.reduce((count, state) => count + (state.issues?.length ?? 0), 0);
		return {
			content: [
				{
					type: "text",
					text: `Inspected hyperchart run ${inspector.runId}: ${inspector.stateCount} states, ${issueCount} issue${issueCount === 1 ? "" : "s"} (${runDir}).`,
				},
			],
			details: inspector,
		};
	},
});

const hyperchartRewindTool = defineTool({
	name: "hyperchart_rewind",
	label: "Rewind Hyperchart Run",
	description: "Back up and truncate a stopped Hyperchart run log so replay can continue from a specific state or seqId.",
	parameters: Type.Object({
		runDir: Type.String({ description: "Existing run directory or run id to rewind" }),
		state: Type.Optional(Type.String({ description: "State path to rewind to, e.g. chapter-production or chapter-production#key.write-copy" })),
		seqId: Type.Optional(Type.Number({ description: "Durable log seqId to rewind to" })),
		to: Type.Optional(Type.Literal("compatible", { description: "Cut to the first prefix compatible with the current chart" })),
		mode: Type.Optional(Type.Union([Type.Literal("before"), Type.Literal("after")], { description: "Cut before or after the matching record. Default: before" })),
		cleanupSessions: Type.Optional(Type.Boolean({ description: "Remove downstream session progress and move downstream session dirs into the backup. Default: true" })),
		cleanupArtifacts: Type.Optional(Type.Boolean({ description: "Best-effort backup+remove artifact files declared by downstream actions. Default: false" })),
		start: Type.Optional(Type.Boolean({ description: "Start/resume the rewound run immediately after truncating. Default: false" })),
		ignoreReplayWarnings: Type.Optional(Type.Boolean({ description: "When start=true, explicitly continue despite stale/skipped replay warnings. Default: false" })),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const runDir = resolveHyperchartRunDir(params.runDir, ctx.cwd);
		const result = await rewindHyperchartRun(
			{
				runDir,
				...(params.state === undefined ? {} : { state: params.state }),
				...(params.seqId === undefined ? {} : { seqId: params.seqId }),
				...(params.to === undefined ? {} : { to: params.to }),
				mode: params.mode === "after" ? "after" : "before",
				cleanupSessions: params.cleanupSessions !== false,
				cleanupArtifacts: params.cleanupArtifacts === true,
			},
			ctx,
		);
		if (params.start === true) {
			const started = await startHyperchartRun(
				{ runDir, ...(params.ignoreReplayWarnings === true ? { ignoreReplayWarnings: true } : {}) },
				ctx,
			);
			return {
				content: [{ type: "text", text: `Rewound ${result.runId} to ${result.targetLabel} and started replay (${started.runDir})` }],
				details: { ...result, started: { runId: started.runId, runDir: started.runDir, chartId: started.chartId } },
			};
		}
		return {
			content: [{ type: "text", text: `Rewound ${result.runId} to ${result.targetLabel}. Resume with hyperchart action=run runDir=${result.runDir}` }],
			details: result,
		};
	},
});

type RewindMode = "before" | "after";
type RewindOptions = {
	runDir: string;
	state?: string;
	seqId?: number;
	to?: "compatible";
	mode: RewindMode;
	cleanupSessions: boolean;
	cleanupArtifacts: boolean;
};
type RewindResult = {
	runId: string;
	runDir: string;
	chartId: string;
	targetLabel: string;
	backupDir: string;
	keptRecords: number;
	removedRecords: number;
	removedByState: Array<{ state: string; records: number }>;
	cutSeqId?: number;
	cleanup: { sessionsRemoved: number; artifactFilesRemoved: number; artifactWarnings: string[] };
};

async function rewindHyperchartRun(opts: RewindOptions, ctx: HyperchartContext): Promise<RewindResult> {
	const targetCount = [opts.state, opts.seqId, opts.to].filter((target) => target !== undefined).length;
	if (targetCount !== 1) {
		throw new Error("hyperchart action=rewind requires exactly one of state, seqId, or to=compatible");
	}
	const status = readRunStatus(opts.runDir);
	if (isRunLive(status)) throw new Error(`Run '${basename(opts.runDir)}' is live; stop it before rewinding`);
	const meta = loadRunMeta(opts.runDir);
	if (resolve(meta.workDir) !== resolve(ctx.cwd)) {
		throw new Error(`Run '${basename(opts.runDir)}' belongs to ${meta.workDir}; open that directory first`);
	}
	const parsed = parseChartModuleSync(meta.chartPath, meta.exportName === undefined ? {} : { exportName: meta.exportName });
	if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	const logPath = resolve(opts.runDir, "log.jsonl");
	const records = readDurableLogSync(logPath);
	const match = findRewindMatch(records, opts, parsed.ast);
	const cutMode = opts.to === "compatible" ? "before" : opts.mode;
	const cutIndex = cutMode === "before" ? match.index : match.index + 1;
	const kept = records.slice(0, cutIndex);
	const removed = records.slice(cutIndex);
	if (removed.length === 0) throw new Error("Rewind would remove zero records; choose an earlier target or mode=before");

	const backupDir = resolve(opts.runDir, "rewind-backups", `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeBackupLabel(match.label)}`);
	mkdirSync(backupDir, { recursive: true });
	backupIfExists(logPath, backupDir, "log.jsonl");
	backupIfExists(resolve(opts.runDir, "status.json"), backupDir, "status.json");
	backupIfExists(sessionProgressPath(resolve(opts.runDir, "sessions")), backupDir, "sessions-progress.json");

	const artifactCleanup = opts.cleanupArtifacts
		? cleanupDownstreamArtifacts({ ast: parsed.ast, records, cutIndex, workDir: meta.workDir, backupDir })
		: { removed: 0, warnings: [] as string[] };
	const sessionsRemoved = opts.cleanupSessions ? cleanupDownstreamSessions(opts.runDir, removed, backupDir) : 0;

	writeDurableLogSync(logPath, kept);
	patchRunStatus(opts.runDir, {
		runId: basename(opts.runDir),
		chartId: parsed.ast.id,
		state: "stopped",
		pid: undefined,
		heartbeatAt: undefined,
		exitCode: 0,
		error: undefined,
	});

	return {
		runId: basename(opts.runDir),
		runDir: opts.runDir,
		chartId: parsed.ast.id,
		targetLabel: match.label,
		backupDir,
		keptRecords: kept.length,
		removedRecords: removed.length,
		removedByState: summarizeRemovedRecordsByState(removed),
		...(match.recordSeqId === undefined ? {} : { cutSeqId: match.recordSeqId }),
		cleanup: {
			sessionsRemoved,
			artifactFilesRemoved: artifactCleanup.removed,
			artifactWarnings: artifactCleanup.warnings,
		},
	};
}

function findRewindMatch(
	records: readonly DurableLogRecord[],
	opts: RewindOptions,
	ast: ChartAst,
): { index: number; label: string; recordSeqId?: number } {
	if (opts.to === "compatible") {
		const explanation = explainReplay(ast, records);
		const broken = explanation.broken;
		if (broken === undefined) {
			const warnings = explanation.skipped.length + explanation.stale.length;
			throw new Error(
				warnings === 0
					? "Durable log is already compatible with the current chart; no rewind needed"
					: `Durable log has no structural incompatibility (${warnings} warning record(s)); choose state or seqId if you still want to rewind`,
			);
		}
		const targetSeqId = broken.record.type === "state_action" ? (broken.invokeSeqId ?? broken.seqId) : broken.seqId;
		const index = records.findIndex((record) => record.seqId === targetSeqId);
		if (index === -1) throw new Error(`Cannot find compatible cut record seqId ${targetSeqId}`);
		return {
			index,
			label: `compatible before seqId ${targetSeqId}`,
			recordSeqId: targetSeqId,
		};
	}
	if (opts.seqId !== undefined) {
		const index = records.findIndex((record) => record.seqId === opts.seqId);
		if (index === -1) throw new Error(`No durable log record with seqId ${opts.seqId}`);
		return { index, label: `${opts.mode} seqId ${opts.seqId}`, recordSeqId: opts.seqId };
	}
	const state = opts.state ?? "";
	const index = records.findIndex((record) => recordMatchesState(record, state));
	if (index === -1) throw new Error(`No durable log record matched state '${state}'`);
	const recordSeqId = records[index]?.seqId;
	return { index, label: `${opts.mode} state ${state}`, ...(recordSeqId === undefined ? {} : { recordSeqId }) };
}

function summarizeRemovedRecordsByState(records: readonly DurableLogRecord[]): Array<{ state: string; records: number }> {
	const counts = new Map<string, number>();
	for (const record of records) {
		const state = record.type === "spawned" ? record.path : record.type === "state_action" ? record.actionUid.state : "<run>";
		counts.set(state, (counts.get(state) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([state, count]) => ({ state, records: count }))
		.sort((left, right) => right.records - left.records || left.state.localeCompare(right.state));
}

function recordMatchesState(record: DurableLogRecord, state: string): boolean {
	if (record.type === "spawned") return record.path === state || templatePathLocal(record.path) === state || isUnderState(record.path, state);
	if (record.type !== "state_action") return false;
	return record.actionUid.state === state || templatePathLocal(record.actionUid.state) === state || isUnderState(record.actionUid.state, state);
}

function isUnderState(path: string, state: string): boolean {
	return path === state || path.startsWith(`${state}.`) || path.startsWith(`${state}#`) || templatePathLocal(path).startsWith(`${state}.`);
}

function readDurableLogSync(logPath: string): DurableLogRecord[] {
	if (!existsSync(logPath)) return [];
	return readFileSync(logPath, "utf8")
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as DurableLogRecord);
}

function writeDurableLogSync(logPath: string, records: readonly DurableLogRecord[]): void {
	writeFileSync(logPath, records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function backupIfExists(path: string, backupDir: string, name: string): void {
	if (!existsSync(path)) return;
	copyFileSync(path, resolve(backupDir, name));
}

function cleanupDownstreamSessions(runDir: string, removed: readonly DurableLogRecord[], backupDir: string): number {
	const sessionsDir = resolve(runDir, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	const progress = readSessionProgress(sessionsDir);
	const keys = new Set(
		removed.flatMap((record) => (record.type === "state_action" ? [actionUidKey(record.actionUid)] : [])),
	);
	let removedEntries = 0;
	for (const key of keys) {
		if (progress.sessions[key] !== undefined) {
			delete progress.sessions[key];
			removedEntries++;
		}
	}
	progress.updatedAt = Date.now();
	writeFileSync(sessionProgressPath(sessionsDir), `${JSON.stringify(progress, null, 2)}\n`, "utf8");
	const backupSessionsDir = resolve(backupDir, "sessions");
	for (const record of removed) {
		if (record.type !== "state_action") continue;
		const actionDir = resolve(sessionsDir, actionUidDirName(record.actionUid));
		if (!existsSync(actionDir)) continue;
		mkdirSync(backupSessionsDir, { recursive: true });
		movePath(actionDir, resolve(backupSessionsDir, basename(actionDir)));
	}
	return removedEntries;
}

function cleanupDownstreamArtifacts(opts: {
	ast: ChartAst;
	records: readonly DurableLogRecord[];
	cutIndex: number;
	workDir: string;
	backupDir: string;
}): { removed: number; warnings: string[] } {
	const collected = collectDownstreamArtifactPaths(opts.ast, opts.records, opts.cutIndex, opts.workDir);
	const warnings = [...collected.warnings];
	let removed = 0;
	let index = 0;
	const backupArtifactsDir = resolve(opts.backupDir, "artifacts");
	for (const path of collected.paths) {
		if (!existsSync(path)) continue;
		const stat = statSync(path);
		if (!stat.isFile()) {
			warnings.push(`Skipped non-file artifact ${path}`);
			continue;
		}
		mkdirSync(backupArtifactsDir, { recursive: true });
		const backupPath = resolve(backupArtifactsDir, `${String(index++).padStart(4, "0")}-${basename(path)}`);
		copyFileSync(path, backupPath);
		rmSync(path, { force: true });
		removed++;
	}
	return { removed, warnings };
}

function collectDownstreamArtifactPaths(
	ast: ChartAst,
	records: readonly DurableLogRecord[],
	cutIndex: number,
	workDir: string,
): { paths: string[]; warnings: string[] } {
	const paths = new Set<string>();
	const warnings: string[] = [];
	for (let index = cutIndex; index < records.length; index++) {
		const record = records[index];
		if (record?.type !== "state_action" || record.kind !== "invoke") continue;
		try {
			const projection = projectBranch(createBranchProjection(ast), ast, records.slice(0, index + 1));
			const node = nodeAt(ast, record.actionUid.state);
			if (node?.kind !== "state") continue;
			const action = node.action;
			if (action.kind === "user" || action.artifacts === undefined) continue;
			for (const artifact of Object.values(action.artifacts)) {
				const rendered = renderTemplateForProjection(projection, ast, artifact.path, record.actionUid.state);
				paths.add(resolveArtifactPath(workDir, rendered));
			}
		} catch (error) {
			warnings.push(error instanceof Error ? error.message : String(error));
		}
	}
	return { paths: [...paths], warnings };
}

function renderTemplateForProjection(
	projection: BranchProjection,
	ast: ChartAst,
	template: TemplateAst,
	stateId: StatePath,
): string {
	let out = "";
	for (let index = 0; index < template.strings.length; index++) {
		out += template.strings[index] ?? "";
		const ref = template.refs[index];
		if (ref === undefined) continue;
		const value = resolveRefForProjection(projection, ast, ref, stateId);
		out += typeof value === "string" ? value : JSON.stringify(value);
	}
	return out;
}

function resolveRefForProjection(projection: BranchProjection, ast: ChartAst, ref: InputRef, stateId: StatePath): unknown {
	if (ref.kind === "arg") return projection.args?.[ref.name];
	if (ref.kind === "visit") {
		const target = ref.state === undefined ? stateId : instancePathFor(ref.state, stateId);
		const node = nodeAt(ast, target);
		if (node?.kind !== "state") throw new Error(`Cannot resolve visit(${ref.state ?? ""}) for ${stateId}`);
		return projection.stateVisits[actionUidKey({ ...node.action.uid, state: target })];
	}
	if (ref.kind === "input") {
		const slot = inputSlotForProjection(projection, ast, ref.name, stateId);
		return selectPathForProjection(slot?.values[ref.name], ref.path);
	}
	if (ref.kind === "key" || ref.kind === "item") {
		const instance = nearestInstance(stateId, ref.map);
		if (instance === undefined) throw new Error(`Cannot resolve map ref for ${stateId}`);
		const instances = projection.spawns[instance.container];
		if (instances === undefined || !(instance.key in instances)) throw new Error(`No spawned instance ${instance.key} in ${instance.container}`);
		return ref.kind === "key" ? instance.key : selectPathForProjection(instances[instance.key], ref.path);
	}
	const resultKey = instancePathFor(ref.state, stateId);
	return selectPathForProjection(projection.results[resultKey], ref.path);
}

function inputSlotForProjection(
	projection: BranchProjection,
	ast: ChartAst,
	name: string,
	stateId: StatePath,
): { values: Record<string, unknown> } | undefined {
	let current: StatePath | undefined = stateId;
	while (current !== undefined) {
		const node = nodeAt(ast, current);
		if ((node?.kind === "state" || node?.kind === "map") && node.input !== undefined && name in node.input) {
			return { values: projection.inputs[node.kind === "map" ? stripLastKey(current) : current] ?? {} };
		}
		const dot = current.lastIndexOf(".");
		current = dot === -1 ? undefined : current.slice(0, dot);
	}
	return undefined;
}

function selectPathForProjection(value: unknown, path: string | undefined): unknown {
	if (path === undefined) return value;
	let current = value;
	for (const segment of path.split(".")) {
		if (typeof current !== "object" || current === null || !(segment in current)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function resolveArtifactPath(workDir: string, path: string): string {
	return isAbsolute(path) ? path : resolve(workDir, path);
}

function movePath(from: string, to: string): void {
	let target = to;
	let suffix = 1;
	while (existsSync(target)) {
		target = `${to}.${suffix++}`;
	}
	mkdirSync(dirname(target), { recursive: true });
	renameSync(from, target);
}

function templatePathLocal(path: StatePath): StatePath {
	return path
		.split(".")
		.map((segment) => {
			const hash = segment.indexOf("#");
			return hash === -1 ? segment : segment.slice(0, hash);
		})
		.join(".");
}

function safeBackupLabel(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
}

async function dispatch(args: string, ctx: HyperchartContext, notifyErrors = true): Promise<void> {
	const tokens = tokenize(args);
	const command = tokens.shift();
	try {
		if (command === undefined || command.startsWith("-")) {
			if (command !== undefined) tokens.unshift(command);
			await runsCommand(tokens, ctx);
			return;
		}
		switch (command) {
			case "run":
				await runCommand(tokens, ctx);
				break;
			case "restart":
				await restartCommand(tokens, ctx);
				break;
			case "resume":
				await resumeCommand(tokens, ctx);
				break;
			case "steer":
				await steerCommand(tokens, ctx);
				break;
			case "status":
				await statusCommand(ctx);
				break;
			case "stop":
				await stopCommand(tokens, ctx);
				break;
			case "delete":
			case "rm":
				await deleteCommand(tokens, ctx);
				break;
			case "view":
				await viewCommand(tokens, ctx);
				break;
			default:
				if (isBareRunIdSpec(command)) {
					const run = lookupBareRunIdForView(command, ctx.cwd);
					if (run.kind === "match") {
						await viewCommand([command], ctx);
						break;
					}
					if (run.kind === "foreign") {
						ctx.ui.notify(`Run '${command}' belongs to ${run.workDir}; open that directory first`, "warning");
						break;
					}
				}
				ctx.ui.notify(`Unknown hyperchart command '${command}'. ${HYPERCHART_USAGE}`, "info");
		}
	} catch (error) {
		if (!notifyErrors) throw error;
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

async function runCommand(tokens: string[], ctx: HyperchartContext): Promise<void> {
	const { wait, ...options } = parseRunOptions(tokens);
	const result = await startHyperchartRun(options, ctx);
	if (wait === true) await result.done;
}

async function runsCommand(tokens: string[], ctx: HyperchartContext): Promise<void> {
	const options = parseRunsOptions(tokens);
	const entries = await loadRunHistory({ cwd: ctx.cwd, limit: options.limit });
	if (entries.length === 0) {
		ctx.ui.notify(`No hyperchart runs for ${ctx.cwd}`, "info");
		return;
	}
	if (ctx.mode !== "tui") {
		ctx.ui.notify(formatRunHistory(entries, ctx.cwd), "info");
		return;
	}
	const action = await ctx.ui.custom<RunHistoryAction>(
		(tui, theme, _keybindings, done) =>
			new RunHistoryOverlay(tui, theme, {
				cwd: ctx.cwd,
				items: entries.map(runHistoryItem),
				done,
			}),
		{ overlay: true },
	);
	await executeRunHistoryAction(action, ctx);
}

async function resumeCommand(tokens: string[], ctx: HyperchartContext): Promise<void> {
	const options = parseResumeOptions(tokens);
	await resumeRun(
		options.runId,
		ctx,
		options.ignoreReplayWarnings === true ? { ignoreReplayWarnings: true } : {},
	);
}

async function steerCommand(tokens: string[], ctx: HyperchartContext): Promise<void> {
	const runId = tokens.shift();
	const actionKey = tokens.shift();
	const message = tokens.join(" ").trim();
	if (runId === undefined || actionKey === undefined || message.length === 0) {
		throw new Error("steer requires a runId, actionKey, and message");
	}
	const runDir = resolveHyperchartRunDir(runId, ctx.cwd);
	const meta = loadRunMeta(runDir);
	if (resolve(meta.workDir) !== resolve(ctx.cwd)) {
		throw new Error(`Run '${runId}' belongs to ${meta.workDir}; open that directory first`);
	}
	const sessionsDir = resolve(runDir, "sessions");
	const session = readSessionProgress(sessionsDir).sessions[actionKey];
	if (session === undefined) throw new Error(`Agent session '${actionKey}' was not found in run '${runId}'`);
	if (session.status !== "starting" && session.status !== "running") {
		throw new Error(`Agent session '${session.actionName}' is ${session.status} and cannot be steered`);
	}
	queueSessionSteering(sessionsDir, actionKey, message);
	ctx.ui.notify(`Steering queued for @${session.actionName}`, "info");
}

async function restartCommand(tokens: string[], ctx: HyperchartContext): Promise<void> {
	const runId = tokens[0];
	if (runId === undefined) throw new Error("restart requires a runId");
	await restartRun(runId, ctx);
}

async function deleteCommand(tokens: string[], ctx: HyperchartContext): Promise<void> {
	const runId = tokens[0];
	if (runId === undefined) throw new Error("delete requires a runId");
	await deleteRun(runId, ctx);
}

async function resumeRun(
	runId: string,
	ctx: HyperchartContext,
	opts: { ignoreReplayWarnings?: boolean } = {},
): Promise<RunStartResult> {
	return startHyperchartRun({ runDir: runId, ...(opts.ignoreReplayWarnings === true ? { ignoreReplayWarnings: true } : {}) }, ctx);
}

async function restartRun(runId: string, ctx: HyperchartContext): Promise<RunStartResult> {
	const runDir = resolveHyperchartRunDir(runId, ctx.cwd);
	const meta = loadRunMeta(runDir);
	if (resolve(meta.workDir) !== resolve(ctx.cwd)) {
		throw new Error(`Run '${runId}' belongs to ${meta.workDir}; open that directory first`);
	}
	const args = await loadRunArgs(runDir);
	const result = await startHyperchartRun(
		{
			chartPath: meta.chartPath,
			...(meta.exportName === undefined ? {} : { exportName: meta.exportName }),
			...(args === undefined ? {} : { args }),
		},
		ctx,
	);
	ctx.ui.notify(`Restarted hyperchart run ${runId} as ${result.runId}`, "info");
	return result;
}

async function executeRunHistoryAction(action: RunHistoryAction, ctx: HyperchartContext): Promise<void> {
	if (action.kind === "view") await viewCommand([action.runId], ctx);
}

async function startHyperchartRun(opts: RunStartOptions, ctx: HyperchartContext): Promise<RunStartResult> {
	const requestedRunDir = opts.runDir === undefined ? undefined : resolveHyperchartRunDir(opts.runDir, ctx.cwd);
	let meta: RunMeta | undefined;
	let chartPath: string;
	let exportName = opts.exportName;
	let workDir = ctx.cwd;
	if (requestedRunDir !== undefined && opts.chartPath === undefined) {
		meta = loadRunMeta(requestedRunDir);
		if (resolve(meta.workDir) !== resolve(ctx.cwd)) {
			throw new Error(
				`Run '${opts.runDir ?? basename(requestedRunDir)}' belongs to ${meta.workDir}; open that directory first`,
			);
		}
		chartPath = meta.chartPath;
		exportName = meta.exportName;
		workDir = meta.workDir;
	} else if (opts.chartPath !== undefined) {
		chartPath = resolveHyperchartPath(opts.chartPath, ctx.cwd);
	} else {
		throw new Error("hyperchart action=run requires chartPath unless runDir points at an existing run");
	}

	await assertChartPreflight(chartPath);
	const parsed = parseChartModuleSync(chartPath, exportName === undefined ? {} : { exportName });
	if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	warnOnUserActions(parsed.ast, ctx);

	const actualRunDir = requestedRunDir ?? createRunDir(workDir, parsed.ast.id, { rootDir: getHyperchartRunsRoot() });
	if (meta === undefined) {
		saveRunMeta(actualRunDir, {
			chartPath,
			...(exportName === undefined ? {} : { exportName }),
			workDir,
			chartId: parsed.ast.id,
			createdAt: new Date().toISOString(),
			originSessionId: ctx.sessionManager.getSessionId(),
		});
	}
	mkdirSync(resolve(actualRunDir, "sessions"), { recursive: true });
	const runId = basename(actualRunDir);
	const existingStatus = readRunStatus(actualRunDir);
	if (isRunLive(existingStatus)) {
		const done = watchRun(actualRunDir);
		const active: ActiveRun = {
			runId,
			runDir: actualRunDir,
			ast: parsed.ast,
			...(existingStatus === undefined ? {} : { status: existingStatus }),
			live: true,
			done,
		};
		runs.add(active);
		setRunWidget(ctx, active);
		ctx.ui.notify(`Attached to live hyperchart run ${runId}`, "info");
		void done.finally(() => {
			runs.remove(runId);
			ctx.ui.setWidget(`hyperchart:${runId}`, undefined);
			ctx.ui.setStatus("hyperchart", runs.active.size === 0 ? undefined : `▶ ${runs.active.size} runs`);
		});
		return { runId, runDir: actualRunDir, chartId: parsed.ast.id, done };
	}

	patchRunStatus(actualRunDir, {
		runId,
		chartId: parsed.ast.id,
		state: "starting",
		heartbeatAt: Date.now(),
		error: undefined,
		exitCode: undefined,
	});
	const config: HyperchartRunnerConfig = {
		runId,
		runDir: actualRunDir,
		chartPath,
		chartId: parsed.ast.id,
		workDir,
		agentDir: getAgentDir(),
		...(exportName === undefined ? {} : { exportName }),
		...(opts.args === undefined ? {} : { args: opts.args }),
		...(opts.ignoreReplayWarnings === true ? { ignoreReplayWarnings: true } : {}),
		...(ctx.model === undefined ? {} : { defaultModel: `${ctx.model.provider}/${ctx.model.id}` }),
	};
	const pid = spawnRunner(config);
	patchRunStatus(actualRunDir, { runId, chartId: parsed.ast.id, state: "running", pid, heartbeatAt: Date.now() });
	const done = watchRun(actualRunDir);
	const status = readRunStatus(actualRunDir);
	const active: ActiveRun = {
		runId,
		runDir: actualRunDir,
		ast: parsed.ast,
		...(status === undefined ? {} : { status }),
		live: true,
		done,
	};
	runs.add(active);
	setRunWidget(ctx, active);
	ctx.ui.setStatus("hyperchart", `▶ ${runs.active.size} run${runs.active.size === 1 ? "" : "s"}`);
	ctx.ui.notify(`Started hyperchart run ${runId} (pid ${pid})`, "info");
	void done
		.then((status) => {
			if (status.state === "complete") ctx.ui.notify(`Hyperchart run ${runId} finished`, "info");
			else if (status.state === "failed")
				ctx.ui.notify(`Hyperchart run ${runId} failed: ${status.error ?? "unknown"}`, "error");
		})
		.finally(() => {
			runs.remove(runId);
			ctx.ui.setWidget(`hyperchart:${runId}`, undefined);
			ctx.ui.setStatus("hyperchart", runs.active.size === 0 ? undefined : `▶ ${runs.active.size} runs`);
		});
	return { runId, runDir: actualRunDir, chartId: parsed.ast.id, done };
}

function spawnRunner(config: HyperchartRunnerConfig): number {
	const configPath = resolve(config.runDir, "runner.config.json");
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	const stdoutFd = openSync(resolve(config.runDir, "runner.stdout.log"), "a");
	const stderrFd = openSync(resolve(config.runDir, "runner.stderr.log"), "a");
	try {
		const child = spawn(process.execPath, [runnerEntry, configPath], {
			cwd: config.workDir,
			detached: true,
			stdio: ["ignore", stdoutFd, stderrFd],
			env: process.env,
		});
		child.unref();
		if (child.pid === undefined) throw new Error("hyperchart runner did not produce a pid");
		return child.pid;
	} finally {
		closeSync(stdoutFd);
		closeSync(stderrFd);
	}
}

function watchRun(runDir: string): Promise<HyperchartRunStatus> {
	return new Promise((resolveDone) => {
		const timer = setInterval(() => {
			const status = readRunStatus(runDir);
			if (status === undefined) return;
			if (isTerminalRunState(status.state)) {
				clearInterval(timer);
				resolveDone(status);
				return;
			}
			if (!isRunLive(status) && Date.now() - status.updatedAt > 20_000) {
				const failed = patchRunStatus(runDir, {
					state: "failed",
					error: "runner heartbeat lost",
					exitCode: 1,
				});
				clearInterval(timer);
				resolveDone(failed);
			}
		}, 1_000);
		timer.unref();
	});
}

async function statusCommand(ctx: HyperchartContext): Promise<void> {
	const snapshots = await recentRunSnapshots(8);
	const activeIds = new Set(runs.active.keys());
	if (runs.active.size === 0 && snapshots.length === 0) {
		ctx.ui.notify("No hyperchart runs", "info");
		return;
	}
	ctx.ui.notify(
		[
			...[...runs.active.values()].map((run) => formatSnapshot(run, activeIds)),
			...snapshots.filter((run) => !activeIds.has(run.runId)).map((run) => formatSnapshot(run, activeIds)),
		].join("\n"),
		"info",
	);
}

function stopHyperchartRuns(
	params: { runDir?: string; all?: boolean },
	ctx: HyperchartContext,
) {
	if ((params.runDir === undefined) === (params.all !== true)) {
		throw new Error("hyperchart action=stop requires exactly one of runDir or all=true");
	}
	const targets = params.all === true
		? activeRunDirsForWorkDir(ctx.cwd)
		: [resolveHyperchartRunDir(params.runDir as string, ctx.cwd)];
	const stopped = targets.map((runDir) => stopRunDirectory(runDir, ctx));
	return {
		content: [{
			type: "text" as const,
			text: stopped.length === 0
				? "No active Hyperchart runs found"
				: `Stopping ${stopped.length} Hyperchart run${stopped.length === 1 ? "" : "s"}:\n${stopped.map((run) => `- ${run.runId}${run.pid === undefined ? " (marked stopped)" : ` (pid ${run.pid})`}`).join("\n")}`,
		}],
		details: { stopped },
	};
}

function activeRunDirsForWorkDir(cwd: string): string[] {
	const root = getHyperchartRunsRoot();
	if (!existsSync(root)) return [];
	return runDirs(root).filter((runDir) => {
		const meta = loadRunMetaIfPresent(runDir);
		if (meta === undefined || resolve(meta.workDir) !== resolve(cwd)) return false;
		const status = readRunStatus(runDir);
		return status !== undefined && (isRunLive(status) || ["starting", "running", "stopping"].includes(status.state));
	});
}

function stopRunDirectory(runDir: string, ctx: HyperchartContext): { runId: string; runDir: string; pid?: number } {
	const meta = loadRunMeta(runDir);
	if (resolve(meta.workDir) !== resolve(ctx.cwd)) {
		throw new Error(`Run '${basename(runDir)}' belongs to ${meta.workDir}; open that directory first`);
	}
	const status = readRunStatus(runDir);
	patchRunStatus(runDir, { state: "stopping" });
	const pid = status?.pid !== undefined && isPidAlive(status.pid) ? status.pid : undefined;
	if (pid === undefined) patchRunStatus(runDir, { state: "stopped", exitCode: 0, error: "runner was not live" });
	else process.kill(pid, "SIGTERM");
	const runId = basename(runDir);
	runs.remove(runId);
	ctx.ui.setWidget(`hyperchart:${runId}`, undefined);
	ctx.ui.setStatus("hyperchart", runs.active.size === 0 ? undefined : `▶ ${runs.active.size} runs`);
	return { runId, runDir, ...(pid === undefined ? {} : { pid }) };
}

async function stopCommand(tokens: string[], ctx: HyperchartContext): Promise<void> {
	await stopRun(tokens[0], ctx);
}

async function stopRun(runId: string | undefined, ctx: HyperchartContext): Promise<void> {
	const target = runs.get(runId) ?? (await resolveRunForView(runId, ctx.cwd));
	if (target === undefined) throw new Error(`Run '${runId ?? "<last>"}' was not found`);
	const result = stopRunDirectory(target.runDir, ctx);
	ctx.ui.notify(
		result.pid === undefined
			? `Marked hyperchart run ${target.runId} stopped`
			: `Stopping hyperchart run ${target.runId} (pid ${result.pid})`,
		"warning",
	);
}

async function deleteRun(runId: string, ctx: HyperchartContext): Promise<void> {
	const runDir = resolveHyperchartRunDir(runId, ctx.cwd);
	const meta = loadRunMeta(runDir);
	if (resolve(meta.workDir) !== resolve(ctx.cwd)) {
		throw new Error(`Run '${runId}' belongs to ${meta.workDir}; open that directory first`);
	}
	const status = readRunStatus(runDir);
	const live = isRunLive(status);
	const confirmed = await ctx.ui.confirm(
		`Delete hyperchart run ${runId}?`,
		`${meta.chartId}${live ? " is running and will be stopped. " : ". "}This removes ${runDir}`,
	);
	if (!confirmed) return;
	if (status?.pid !== undefined && isPidAlive(status.pid)) process.kill(status.pid, "SIGTERM");
	runs.remove(runId);
	ctx.ui.setWidget(`hyperchart:${runId}`, undefined);
	ctx.ui.setStatus("hyperchart", runs.active.size === 0 ? undefined : `▶ ${runs.active.size} runs`);
	rmSync(runDir, { recursive: true, force: true });
	ctx.ui.notify(`Deleted hyperchart run ${runId}`, "info");
}

async function viewCommand(tokens: string[], ctx: HyperchartContext): Promise<void> {
	const activeRun = runs.get(tokens[0]);
	const run = activeRun ?? (await resolveRunForView(tokens[0], ctx.cwd));
	if (run === undefined) {
		ctx.ui.notify("No hyperchart run to view", "warning");
		return;
	}
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`Run ${run.runId}: ${run.runDir}`, "info");
		return;
	}
	const { url } = await openRunInspector({
		runId: run.runId,
		// The snapshot's parsed AST avoids a synchronous chart-module re-parse on every poll.
		loadRun: () => inspectRunForCurrentWorkDir(run.runDir, ctx, run.ast),
		steerSession: (actionKey, message) => {
			queueSessionSteering(join(run.runDir, "sessions"), actionKey, message);
		},
	});
	ctx.ui.notify(`Opened Hyperchart inspector for ${run.runId}: ${url}`, "info");
}

function setRunWidget(ctx: HyperchartContext, run: RunSnapshot): void {
	ctx.ui.setWidget(
		`hyperchart:${run.runId}`,
		(tui, theme) =>
			new RunWidget(tui, theme, {
				runId: run.runId,
				runDir: run.runDir,
				logPath: resolve(run.runDir, "log.jsonl"),
				ast: run.ast,
				live: run.live,
				cwd: ctx.cwd,
			}),
		{ placement: "aboveEditor" },
	);
}

async function restoreRunWidgets(ctx: HyperchartContext): Promise<void> {
	const snapshots = await recentRunSnapshots(5, ctx.cwd, ctx.sessionManager.getSessionId());
	for (const run of snapshots) {
		if (runs.active.has(run.runId)) continue;
		setRunWidget(ctx, run);
	}
	if (snapshots.length > 0 && runs.active.size === 0) {
		runs.lastRunId = snapshots[0]?.runId;
		const liveCount = snapshots.filter((snapshot) => snapshot.live).length;
		ctx.ui.setStatus(
			"hyperchart",
			`${liveCount > 0 ? "▶" : "↻"} ${snapshots.length} run${snapshots.length === 1 ? "" : "s"}`,
		);
	}
}

type BareRunIdLookup = { kind: "match" } | { kind: "foreign"; workDir: string } | { kind: "missing" };

function lookupBareRunIdForView(runId: string, cwd: string): BareRunIdLookup {
	const meta = loadRunMetaIfPresent(resolveHyperchartRunDir(runId, cwd));
	if (meta === undefined) return { kind: "missing" };
	return resolve(meta.workDir) === resolve(cwd) ? { kind: "match" } : { kind: "foreign", workDir: meta.workDir };
}

function isBareRunIdSpec(spec: string): boolean {
	return spec.length > 0 && !isAbsolute(spec) && !spec.startsWith(".") && !spec.includes("/") && !spec.includes("\\");
}

async function resolveRunForView(runId: string | undefined, cwd: string): Promise<RunSnapshot | undefined> {
	if (runId !== undefined) {
		const runDir = resolveHyperchartRunDir(runId, cwd);
		const meta = loadRunMetaForCurrentWorkDir(runDir, cwd);
		return meta === undefined ? undefined : loadRunSnapshot(runDir, meta);
	}
	return (await recentRunSnapshots(5, cwd))[0];
}

async function recentRunSnapshots(limit = 5, cwd?: string, originSessionId?: string): Promise<RunSnapshot[]> {
	const root = getHyperchartRunsRoot();
	if (!existsSync(root)) return [];
	const dirs = runDirs(root);
	const snapshots: RunSnapshot[] = [];
	for (const dir of dirs) {
		try {
			const meta = loadRunMeta(dir);
			if (cwd !== undefined && resolve(meta.workDir) !== resolve(cwd)) continue;
			if (originSessionId !== undefined && meta.originSessionId !== originSessionId) continue;
			const snapshot = await loadRunSnapshot(dir, meta);
			if (snapshot.status !== undefined && isTerminalRunState(snapshot.status.state)) continue;
			const store = new JsonlLogStore(resolve(dir, "log.jsonl"));
			const view = buildRunView(snapshot.ast, await store.readAll(), Date.now());
			if (!view.final) snapshots.push(snapshot);
		} catch {
			continue;
		}
		if (snapshots.length >= limit) break;
	}
	return snapshots;
}

async function loadRunHistory(options: { cwd: string; limit: number }): Promise<RunHistoryEntry[]> {
	const root = getHyperchartRunsRoot();
	if (!existsSync(root)) return [];
	const entries: RunHistoryEntry[] = [];
	for (const dir of runDirs(root)) {
		const entry = await loadRunHistoryEntry(dir, options.cwd).catch(() => undefined);
		if (entry === undefined) continue;
		entries.push(entry);
		if (entries.length >= options.limit) break;
	}
	return entries;
}

async function loadRunHistoryEntry(runDir: string, cwd: string): Promise<RunHistoryEntry | undefined> {
	const meta = loadRunMeta(runDir);
	if (resolve(meta.workDir) !== resolve(cwd)) return undefined;
	const status = readRunStatus(runDir);
	let final = status?.state === "complete" || status?.state === "failed";
	let terminalState: RunTerminalState | undefined =
		status?.state === "complete" || status?.state === "failed" ? status.state : undefined;
	try {
		const snapshot = await loadRunSnapshot(runDir);
		const store = new JsonlLogStore(resolve(runDir, "log.jsonl"));
		const view = buildRunView(snapshot.ast, await store.readAll(), Date.now());
		final = view.final;
		terminalState = view.final ? (isFailedRunView(view) ? "failed" : "complete") : undefined;
	} catch {
		// Keep status-derived state when old chart code no longer parses.
	}
	return {
		runId: basename(runDir),
		runDir,
		meta,
		...(status === undefined ? {} : { status }),
		live: isRunLive(status),
		final,
		...(terminalState === undefined ? {} : { terminalState }),
		sessionCount: countSessionDirs(runDir),
		updatedAt: status?.updatedAt ?? statSync(runDir).mtimeMs,
	};
}

function isFailedRunView(view: RunView): boolean {
	return view.graph.some((row) => row.status === "failed" || (row.status === "final" && isFailureStatePath(row.path)));
}

function runDirs(root: string): string[] {
	return readdirSync(root)
		.map((entry) => resolve(root, entry))
		.filter((path) => existsSync(resolve(path, "meta.json")))
		.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
}

function loadRunMetaForCurrentWorkDir(runDir: string, cwd: string): RunMeta | undefined {
	const meta = loadRunMetaIfPresent(runDir);
	return meta !== undefined && resolve(meta.workDir) === resolve(cwd) ? meta : undefined;
}

function loadRunMetaIfPresent(runDir: string): RunMeta | undefined {
	try {
		return loadRunMeta(runDir);
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw error;
	}
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function loadRunSnapshot(runDir: string, meta: RunMeta = loadRunMeta(runDir)): Promise<RunSnapshot> {
	const parsed = parseChartModuleSync(
		meta.chartPath,
		meta.exportName === undefined ? {} : { exportName: meta.exportName },
	);
	if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	const status = readRunStatus(runDir);
	return {
		runId: basename(runDir),
		runDir,
		ast: parsed.ast,
		...(status === undefined ? {} : { status }),
		live: isRunLive(status),
	};
}

function formatSnapshot(run: RunSnapshot, activeIds: ReadonlySet<string>): string {
	const status = run.status;
	const state = activeIds.has(run.runId)
		? "attached"
		: run.live
			? `live pid ${status?.pid ?? "?"}`
			: (status?.state ?? "detached");
	return `${run.runId} · ${run.ast.id} · ${state} · ${run.runDir}`;
}

function formatRunHistory(entries: readonly RunHistoryEntry[], cwd: string): string {
	return [
		`Hyperchart runs in ${cwd}`,
		`Use /hyperchart runs in TUI for interactive selection.`,
		"",
		...entries.map(formatRunHistoryEntry),
	].join("\n");
}

function runHistoryItem(entry: RunHistoryEntry): RunHistoryItem {
	return {
		runId: entry.runId,
		runDir: entry.runDir,
		chartId: entry.meta.chartId,
		state: historyState(entry),
		live: entry.live,
		final: entry.final,
		sessionCount: entry.sessionCount,
		createdAt: shortDate(entry.meta.createdAt),
		updatedAt: shortDate(entry.updatedAt),
	};
}

function formatRunHistoryEntry(entry: RunHistoryEntry): string {
	const state = historyState(entry);
	const created = shortDate(entry.meta.createdAt);
	const updated = shortDate(entry.updatedAt);
	return [
		`- ${entry.runId} · ${entry.meta.chartId} · ${state} · ${entry.sessionCount} session${entry.sessionCount === 1 ? "" : "s"} · ${created}`,
		`  view /hyperchart view ${entry.runId} · resume /hyperchart resume ${entry.runId} · stop /hyperchart stop ${entry.runId} · restart /hyperchart restart ${entry.runId}`,
		updated === created ? undefined : `  updated ${updated}`,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function historyState(entry: RunHistoryEntry): string {
	if (entry.live) return `live pid ${entry.status?.pid ?? "?"}`;
	if (entry.terminalState !== undefined) return entry.terminalState;
	if (entry.status?.state !== undefined) return entry.status.state;
	return entry.final ? "complete" : "stale";
}

async function loadRunArgs(runDir: string): Promise<Record<string, unknown> | undefined> {
	const store = new JsonlLogStore(resolve(runDir, "log.jsonl"));
	const argsRecord = (await store.readAll()).find((record) => record.type === "args");
	return argsRecord?.type === "args" ? { ...argsRecord.args } : undefined;
}

function countSessionDirs(runDir: string): number {
	const sessionsDir = resolve(runDir, "sessions");
	if (!existsSync(sessionsDir)) return 0;
	return readdirSync(sessionsDir).filter((entry) => {
		const path = resolve(sessionsDir, entry);
		return entry !== "progress.json" && existsSync(path) && statSync(path).isDirectory();
	}).length;
}

function shortDate(value: string | number): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return String(value);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseRunsOptions(tokens: string[]): { limit: number } {
	let limit = 20;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--limit" || token === "-n") {
			const value = tokens[++index];
			if (value === undefined) throw new Error(`${token} requires a number`);
			limit = Number(value);
			if (!Number.isInteger(limit) || limit <= 0) throw new Error(`${token} must be a positive integer`);
		} else {
			throw new Error(`Unexpected argument '${token}'`);
		}
	}
	return { limit };
}

function parseRunOptions(tokens: string[]): {
	chartPath?: string;
	args?: Record<string, unknown>;
	runDir?: string;
	exportName?: string;
	wait?: boolean;
	ignoreReplayWarnings?: boolean;
} {
	let chartPath: string | undefined;
	let args: Record<string, unknown> | undefined;
	let runDir: string | undefined;
	let exportName: string | undefined;
	let wait = false;
	let ignoreReplayWarnings = false;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--args") {
			const value = tokens[++index];
			if (value === undefined) throw new Error("--args requires a JSON object");
			const parsed = JSON.parse(value) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				throw new Error("--args must be a JSON object");
			}
			args = parsed as Record<string, unknown>;
		} else if (token === "--run-dir") {
			runDir = tokens[++index];
			if (runDir === undefined) throw new Error("--run-dir requires a directory");
		} else if (token === "--export") {
			exportName = tokens[++index];
			if (exportName === undefined) throw new Error("--export requires a name");
		} else if (token === "--wait") {
			wait = true;
		} else if (token === "--ignore-replay-warnings") {
			ignoreReplayWarnings = true;
		} else if (chartPath === undefined) {
			chartPath = token;
		} else {
			throw new Error(`Unexpected argument '${token}'`);
		}
	}
	return {
		...(chartPath === undefined ? {} : { chartPath }),
		...(args === undefined ? {} : { args }),
		...(runDir === undefined ? {} : { runDir }),
		...(exportName === undefined ? {} : { exportName }),
		...(wait ? { wait: true } : {}),
		...(ignoreReplayWarnings ? { ignoreReplayWarnings: true } : {}),
	};
}

function parseResumeOptions(tokens: string[]): { runId: string; ignoreReplayWarnings?: boolean } {
	let runId: string | undefined;
	let ignoreReplayWarnings = false;
	for (const token of tokens) {
		if (token === "--ignore-replay-warnings") {
			ignoreReplayWarnings = true;
		} else if (runId === undefined) {
			runId = token;
		} else {
			throw new Error(`Unexpected argument '${token}'`);
		}
	}
	if (runId === undefined) throw new Error("resume requires a runId");
	return { runId, ...(ignoreReplayWarnings ? { ignoreReplayWarnings: true } : {}) };
}

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;
	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\") {
			escaping = true;
			continue;
		}
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (quote !== undefined) throw new Error("Unterminated quote in command arguments");
	if (escaping) current += "\\";
	if (current.length > 0) tokens.push(current);
	return tokens;
}

function warnOnUserActions(ast: ChartAst, ctx: HyperchartContext): void {
	if (Object.values(ast.states).some((state) => state.kind === "state" && state.action.kind === "user")) {
		ctx.ui.notify("This chart contains user actions; user actions are not supported by the pi runtime yet", "warning");
	}
}
