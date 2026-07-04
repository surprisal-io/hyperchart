import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parseChartModule, type ChartAst } from "../src/index.js";
import { JsonlLogStore } from "../src/runtime/generic/log_store.js";
import { createRunDir, loadRunMeta, saveRunMeta, type RunMeta } from "../src/runtime/generic/run_dir.js";
import { isFailureStatePath, type RunTerminalState } from "../src/runtime/generic/run_outcome.js";
import {
	getHyperchartRunsRoot,
	listProjectHypercharts,
	resolveHyperchartPath,
	resolveHyperchartRunDir,
} from "../src/runtime/pi/paths.js";
import {
	isPidAlive,
	isRunLive,
	isTerminalRunState,
	patchRunStatus,
	readRunStatus,
	type HyperchartRunStatus,
} from "../src/runtime/pi/run_status.js";
import type { HyperchartRunnerConfig } from "../src/runtime/pi/hyperchart_runner.js";
import {
	RunHistoryOverlay,
	RunOverlay,
	RunWidget,
	type RunHistoryAction,
	type RunHistoryItem,
} from "../src/tui/components.js";
import { buildRunView, type RunView } from "../src/tui/run_view.js";

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
type HyperchartContext = Pick<ExtensionContext, "cwd" | "mode" | "model" | "ui">;
type RunStartOptions = { chartPath?: string; args?: Record<string, unknown>; runDir?: string; exportName?: string };
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
];
const HYPERCHART_USAGE =
	"Usage: /hyperchart [runId|--limit N] | run <name|chart.ts> [--args JSON] [--run-dir RUN_ID|DIR] [--export NAME] | resume <runId> | restart <runId> | status | stop <runId> | delete <runId> | view [runId]";

function completeHyperchartArgs(argumentPrefix: string): AutocompleteItem[] | null {
	const parsed = parseCompletionPrefix(argumentPrefix);
	if (parsed.previous.length === 0) return completeTopLevelArgs(parsed.current);
	const command = parsed.previous[0];
	const previous = parsed.previous.slice(1);
	if (command === "run") return prependCompletionPrefix(completeRunArgs(previous, parsed.current), parsed.previous);
	if (
		command === "resume" ||
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
	pi.registerCommand("hyperchart", {
		description: "Run and inspect hyperchart workflows",
		handler: async (args, ctx) => dispatch(args, ctx),
		getArgumentCompletions: (prefix) => completeHyperchartArgs(prefix),
	});
	pi.registerTool(hyperchartRunTool);
	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "reload" || event.reason === "startup" || event.reason === "resume") {
			await restoreRunWidgets(ctx);
		}
	});
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
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const result = await startHyperchartRun(
			{
				...(params.chartPath === undefined ? {} : { chartPath: params.chartPath }),
				...(params.args === undefined ? {} : { args: params.args as Record<string, unknown> }),
				...(params.runDir === undefined ? {} : { runDir: params.runDir }),
				...(params.exportName === undefined ? {} : { exportName: params.exportName }),
			},
			ctx,
		);
		if (params.wait === true) {
			const status = await result.done;
			return {
				content: [{ type: "text", text: `Hyperchart run ${result.runId} ${status.state} (${result.runDir})` }],
				details: { runId: result.runId, runDir: result.runDir, chartId: result.chartId, status },
			};
		}
		return {
			content: [{ type: "text", text: `Started hyperchart run ${result.runId} (${result.runDir})` }],
			details: { runId: result.runId, runDir: result.runDir, chartId: result.chartId, final: false },
		};
	},
});

async function dispatch(args: string, ctx: ExtensionCommandContext): Promise<void> {
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
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

async function runCommand(tokens: string[], ctx: ExtensionCommandContext): Promise<void> {
	await startHyperchartRun(parseRunOptions(tokens), ctx);
}

async function runsCommand(tokens: string[], ctx: ExtensionCommandContext): Promise<void> {
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

async function resumeCommand(tokens: string[], ctx: ExtensionCommandContext): Promise<void> {
	const runId = tokens[0];
	if (runId === undefined) throw new Error("resume requires a runId");
	await resumeRun(runId, ctx);
}

async function restartCommand(tokens: string[], ctx: ExtensionCommandContext): Promise<void> {
	const runId = tokens[0];
	if (runId === undefined) throw new Error("restart requires a runId");
	await restartRun(runId, ctx);
}

async function deleteCommand(tokens: string[], ctx: ExtensionCommandContext): Promise<void> {
	const runId = tokens[0];
	if (runId === undefined) throw new Error("delete requires a runId");
	await deleteRun(runId, ctx);
}

async function resumeRun(runId: string, ctx: HyperchartContext): Promise<RunStartResult> {
	return startHyperchartRun({ runDir: runId }, ctx);
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

async function executeRunHistoryAction(action: RunHistoryAction, ctx: ExtensionCommandContext): Promise<void> {
	if (action.kind === "close") return;
	if (action.kind === "view") return viewCommand([action.runId], ctx);
	if (action.kind === "resume") {
		await resumeRun(action.runId, ctx);
		return;
	}
	if (action.kind === "restart") {
		await restartRun(action.runId, ctx);
		return;
	}
	if (action.kind === "delete") {
		await deleteRun(action.runId, ctx);
		return;
	}
	await stopRun(action.runId, ctx);
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
		throw new Error("hyperchart_run requires chartPath unless runDir points at an existing run");
	}

	const parsed = await parseChartModule(chartPath, exportName === undefined ? {} : { exportName });
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

async function statusCommand(ctx: ExtensionCommandContext): Promise<void> {
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

async function stopCommand(tokens: string[], ctx: ExtensionCommandContext): Promise<void> {
	await stopRun(tokens[0], ctx);
}

async function stopRun(runId: string | undefined, ctx: HyperchartContext): Promise<void> {
	const target = runs.get(runId) ?? (await resolveRunForView(runId, ctx.cwd));
	if (target === undefined) throw new Error(`Run '${runId ?? "<last>"}' was not found`);
	const status = readRunStatus(target.runDir);
	patchRunStatus(target.runDir, { state: "stopping" });
	if (status?.pid !== undefined && isPidAlive(status.pid)) {
		process.kill(status.pid, "SIGTERM");
		ctx.ui.notify(`Stopping hyperchart run ${target.runId} (pid ${status.pid})`, "warning");
	} else {
		patchRunStatus(target.runDir, { state: "stopped", exitCode: 0, error: "runner was not live" });
		ctx.ui.notify(`Marked hyperchart run ${target.runId} stopped`, "warning");
	}
	runs.remove(target.runId);
	ctx.ui.setWidget(`hyperchart:${target.runId}`, undefined);
	ctx.ui.setStatus("hyperchart", runs.active.size === 0 ? undefined : `▶ ${runs.active.size} runs`);
}

async function deleteRun(runId: string, ctx: ExtensionCommandContext): Promise<void> {
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

async function viewCommand(tokens: string[], ctx: ExtensionCommandContext): Promise<void> {
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
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) =>
			new RunOverlay(
				tui,
				theme,
				{
					runId: run.runId,
					runDir: run.runDir,
					logPath: resolve(run.runDir, "log.jsonl"),
					ast: run.ast,
					live: run.live,
					cwd: ctx.cwd,
				},
				() => done(),
			),
		{ overlay: true },
	);
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
	const snapshots = await recentRunSnapshots();
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

async function recentRunSnapshots(limit = 5, cwd?: string): Promise<RunSnapshot[]> {
	const root = getHyperchartRunsRoot();
	if (!existsSync(root)) return [];
	const dirs = runDirs(root);
	const snapshots: RunSnapshot[] = [];
	for (const dir of dirs) {
		let meta: RunMeta | undefined;
		try {
			if (cwd !== undefined) {
				meta = loadRunMetaForCurrentWorkDir(dir, cwd);
				if (meta === undefined) continue;
			}
			const snapshot = await loadRunSnapshot(dir, meta);
			const store = new JsonlLogStore(resolve(dir, "log.jsonl"));
			const view = buildRunView(snapshot.ast, await store.readAll(), Date.now());
			if (!view.final && snapshot.status?.state !== "stopped") snapshots.push(snapshot);
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
	const parsed = await parseChartModule(
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
} {
	let chartPath: string | undefined;
	let args: Record<string, unknown> | undefined;
	let runDir: string | undefined;
	let exportName: string | undefined;
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
	};
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
