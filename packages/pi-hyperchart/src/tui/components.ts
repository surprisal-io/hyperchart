import { statSync } from "node:fs";
import { resolve } from "node:path";
import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, truncateToWidth, visibleWidth, type Component, type SelectItem, type TUI } from "@earendil-works/pi-tui";
import type { ChartAst } from "@surprisal/hyperchart/internal/core/types";
import { JsonlLogStore } from "@surprisal/hyperchart/runtime";
import {
	readSessionProgress,
	sessionProgressPath,
	type HyperchartSessionProgress,
} from "@surprisal/hyperchart/sessions";
import { hyperchartRunFromRunDir } from "../runtime/pi/run_inspect.js";
import { summarizeHyperchartProgress } from "@surprisal/hyperchart/host";
import { buildRunView, type GraphRow, type RunView } from "./run_view.js";

export type RunComponentOptions = {
	runId: string;
	runDir: string;
	logPath: string;
	ast: ChartAst;
	branchId?: string;
	live?: boolean;
	cwd?: string;
};

export type RunHistoryItem = {
	runId: string;
	branchId?: string;
	runDir: string;
	chartId: string;
	state: string;
	live: boolean;
	final: boolean;
	sessionCount: number;
	createdAt: string;
	updatedAt: string;
};

export type RunHistoryAction = { kind: "view"; runId: string } | { kind: "close" };

/** A deliberately small picker. Detailed run information belongs in the browser inspector. */
export class RunHistoryOverlay implements Component {
	private selected = 0;
	private readonly list: SelectList;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly opts: {
			cwd: string;
			items: readonly RunHistoryItem[];
			done: (action: RunHistoryAction) => void;
		},
	) {
		this.list = new SelectList(runSelectItems(opts.items), 12, getSelectListTheme(), {
			minPrimaryColumnWidth: 36,
			maxPrimaryColumnWidth: 56,
		});
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (data === "q" || data === "\u001b") {
			this.opts.done({ kind: "close" });
			return;
		}
		if (data === "\u001b[A" || data === "k") {
			this.move(-1);
			return;
		}
		if (data === "\u001b[B" || data === "j") {
			this.move(1);
			return;
		}
		if (data === "\r" || data === "\n") {
			const item = this.opts.items[this.selected];
			if (item !== undefined) this.opts.done({ kind: "view", runId: item.runId });
		}
	}

	render(width: number): string[] {
		this.list.setSelectedIndex(this.selected);
		return box(
			[
				joinParts([this.theme.bold("Hyperchart runs"), dim(this.theme, this.opts.cwd)]),
				dim(this.theme, "↑↓ choose · Enter open browser inspector · Esc close"),
				"",
				...this.list.render(Math.max(1, width - 8)),
			],
			width,
			this.theme,
		);
	}

	private move(delta: number): void {
		this.selected = clamp(this.selected + delta, 0, Math.max(0, this.opts.items.length - 1));
		this.list.setSelectedIndex(this.selected);
		this.tui.requestRender();
	}
}

function runSelectItems(items: readonly RunHistoryItem[]): SelectItem[] {
	return items.map((item) => ({
		value: item.runId,
		label: item.runId,
		description: [
			item.chartId,
			runStateGlyph(item),
			item.state,
			item.sessionCount > 0 ? `${item.sessionCount} session${item.sessionCount === 1 ? "" : "s"}` : undefined,
			item.updatedAt,
		]
			.filter((part): part is string => part !== undefined && part.length > 0)
			.join(" · "),
	}));
}

function runStateGlyph(item: RunHistoryItem): string {
	if (item.live) return "▶";
	if (item.state === "complete") return "✓";
	if (item.state === "failed") return "✗";
	if (item.state === "stopped") return "■";
	if (item.state === "stale") return "◌";
	return "○";
}

/** Compact live progress only. All graph, transcript, and session details live in the browser inspector. */
export class RunWidget implements Component {
	private view: RunView | undefined;
	private progress: Record<string, HyperchartSessionProgress> = {};
	private progressPercent = 0;
	private refreshError: string | undefined;
	private disposed = false;
	private lastStat = "";
	private readonly timer: NodeJS.Timeout;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly opts: RunComponentOptions,
	) {
		this.timer = setInterval(() => void this.refresh().catch((cause) => this.handleRefreshError(cause)), 300);
		this.timer.unref();
		void this.refresh().catch((cause) => this.handleRefreshError(cause));
	}

	invalidate(): void {}

	render(width: number): string[] {
		const view = this.view;
		if (view === undefined) {
			const status =
				this.refreshError === undefined
					? dim(this.theme, `hyperchart ${this.opts.runId} · loading`)
					: error(this.theme, `hyperchart ${this.opts.runId} · inspect failed: ${this.refreshError}`);
			return [truncate(status, width)];
		}

		const active = actionRows(view).filter((row) => activeStatus(row.status));
		const sessions = activeSessions(this.progress);
		const live = this.opts.live === true;
		const activeCount = Math.max(active.length, sessions.length);
		const header = joinParts([
			`${colorRunGlyph(this.theme, view, live)} ${this.theme.bold(view.chartId)}`,
			colorRunState(this.theme, runStateLabel(view, live)),
			accent(this.theme, `branch:${view.branchId}`),
			view.branches.length > 1 ? dim(this.theme, `${view.branches.length} heads`) : undefined,
			dim(this.theme, `tree:${view.recordCount}`),
			view.runnerBranchId !== undefined && view.runnerBranchId !== view.branchId ? dim(this.theme, `runner:${view.runnerBranchId}`) : undefined,
			accent(this.theme, `${this.progressPercent}%`),
			activeCount > 0 ? accent(this.theme, `${activeCount} active`) : undefined,
		]);

		const activeLines = active
			.slice(0, 3)
			.map((row) => compactActiveLine(row, sessionFor(row.path, sessions), this.theme, live));
		if (activeLines.length === 0 && sessions.length > 0) {
			activeLines.push(...sessions.slice(0, 3).map((session) => compactSessionLine(session, this.theme, live)));
		}
		const hidden = Math.max(active.length, sessions.length) - activeLines.length;
		const heads = view.branches.length === 0 ? undefined : dim(this.theme, `  heads ${view.branches.map((branch) => `${branch.branchId}@${branch.headSeqId ?? "empty"}`).join(" · ")}`);
		return [
			header,
			heads,
			this.refreshError === undefined ? undefined : error(this.theme, `  inspect failed: ${this.refreshError}`),
			...activeLines,
			hidden > 0 ? dim(this.theme, `  +${hidden} more`) : undefined,
		]
			.filter((line): line is string => line !== undefined)
			.map((line) => truncate(line, width));
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
	}

	private async refresh(): Promise<void> {
		if (this.disposed) return;
		const progressPath = sessionProgressPath(resolve(this.opts.runDir, "sessions"));
		const stat = `${statKeyFor(this.opts.logPath)}:${statKeyFor(progressPath)}`;
		if (stat === this.lastStat && this.view !== undefined) return;
		this.lastStat = stat;
		const branchId = this.opts.branchId ?? "main";
		const store = new JsonlLogStore(this.opts.logPath, () => {}, branchId);
		const normalized = await store.read();
		const records = normalized.ancestry(branchId);
		const run = await hyperchartRunFromRunDir(this.opts.runDir, { ast: this.opts.ast, branchId, records });
		this.view = buildRunView(this.opts.ast, records, Date.now(), {
			branchId,
			...(run.runnerBranchId === undefined ? {} : { runnerBranchId: run.runnerBranchId }),
			branches: [...normalized.branches.values()].map((branch) => ({ branchId: branch.branchId, headSeqId: branch.headSeqId })),
			recordCount: normalized.records.length,
		});
		this.progress = readSessionProgress(resolve(this.opts.runDir, "sessions")).sessions;
		this.progressPercent = summarizeHyperchartProgress(run).pct;
		this.refreshError = undefined;
		this.tui.requestRender();
	}

	private handleRefreshError(cause: unknown): void {
		if (this.disposed) return;
		this.refreshError = cause instanceof Error ? cause.message : String(cause);
		this.tui.requestRender();
	}
}

function compactActiveLine(
	row: GraphRow,
	session: HyperchartSessionProgress | undefined,
	theme: Theme,
	live: boolean,
): string {
	const activity = session === undefined ? activeStatusLabel(row, live) : sessionActivity(session, live);
	const age = session?.currentToolStartedAt ?? session?.startedAt;
	return `  ${joinParts([
		`${colorActionGlyph(theme, row, live)} ${theme.bold(shortPath(row.path))}`,
		accent(theme, activity),
		age === undefined ? undefined : dim(theme, formatDuration(Date.now() - age)),
	])}`;
}

function compactSessionLine(session: HyperchartSessionProgress, theme: Theme, live: boolean): string {
	return `  ${joinParts([
		`${accent(theme, live ? "●" : "○")} ${theme.bold(shortPath(session.actionUid.state))}`,
		accent(theme, sessionActivity(session, live)),
	])}`;
}

function sessionActivity(session: HyperchartSessionProgress, live: boolean): string {
	if (!live) return "detached";
	if (session.status === "starting") return "starting";
	if (session.status === "running") return session.currentTool ?? "thinking";
	return session.status;
}

function activeStatusLabel(row: GraphRow, live: boolean): string {
	if (!live) return "detached";
	if (row.status === "validating") return "validating";
	if (row.status === "rejected") return "retrying";
	return row.action ?? "running";
}

function activeSessions(progress: Record<string, HyperchartSessionProgress>): HyperchartSessionProgress[] {
	return Object.values(progress).filter((session) => session.status === "starting" || session.status === "running");
}

function sessionFor(
	path: string,
	sessions: readonly HyperchartSessionProgress[],
): HyperchartSessionProgress | undefined {
	return sessions.find((session) => session.actionUid.state === path);
}

function actionRows(view: RunView): GraphRow[] {
	return view.graph.filter((row) => row.action !== undefined);
}

function activeStatus(status: GraphRow["status"]): boolean {
	return status === "running" || status === "validating" || status === "rejected";
}

function runStateLabel(view: RunView, live: boolean): string {
	if (view.final) return view.failedTerminal ? "FAILED" : "DONE";
	return live ? "RUNNING" : "DETACHED";
}

function colorRunGlyph(theme: Theme, view: RunView, live: boolean): string {
	if (view.final) return runStateLabel(view, live) === "FAILED" ? error(theme, "✗") : success(theme, "✓");
	return live ? accent(theme, "◐") : warning(theme, "○");
}

function colorActionGlyph(theme: Theme, row: GraphRow, live: boolean): string {
	if (!live) return warning(theme, "○");
	if (row.status === "rejected") return warning(theme, "↻");
	return accent(theme, "●");
}

function colorRunState(theme: Theme, state: string): string {
	if (state === "DONE") return success(theme, state);
	if (state === "FAILED") return error(theme, state);
	if (state === "DETACHED") return warning(theme, state);
	return accent(theme, state);
}

function shortPath(path: string): string {
	const parts = path.split(".");
	return parts.length <= 2 ? path : parts.slice(-2).join(".");
}

function formatDuration(ms: number): string {
	if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
	if (ms < 60_000) return `${Math.floor(ms / 1_000)}s`;
	return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1_000)}s`;
}

function statKeyFor(path: string): string {
	try {
		const stat = statSync(path);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return "missing";
	}
}

function joinParts(parts: Array<string | undefined>): string {
	return parts.filter((part): part is string => part !== undefined && part.length > 0).join(dimSeparator());
}

function dimSeparator(): string {
	return " · ";
}

function box(content: string[], width: number, theme: Theme): string[] {
	const inner = Math.max(1, width - 4);
	const border = dim(theme, `+${"-".repeat(Math.max(1, inner + 2))}+`);
	return [
		border,
		...content.map((line) => `${dim(theme, "|")} ${pad(truncate(line, inner), inner)} ${dim(theme, "|")}`),
		border,
	];
}

function pad(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function truncate(value: string, width: number): string {
	return truncateToWidth(value, Math.max(1, width));
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function dim(theme: Theme, value: string): string {
	return theme.fg("dim", value);
}

function accent(theme: Theme, value: string): string {
	return theme.fg("accent", value);
}

function success(theme: Theme, value: string): string {
	return theme.fg("success", value);
}

function warning(theme: Theme, value: string): string {
	return theme.fg("warning", value);
}

function error(theme: Theme, value: string): string {
	return theme.fg("error", value);
}
