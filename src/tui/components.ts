import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	getSelectListTheme,
	ToolExecutionComponent,
	type Theme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	SelectList,
	truncateToWidth,
	visibleWidth,
	type Component,
	type SelectItem,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ChartAst } from "../core/types.js";
import { JsonlLogStore } from "../runtime/generic/log_store.js";
import { isFailureStatePath } from "../runtime/generic/run_outcome.js";
import {
	readSessionProgress,
	sessionProgressPath,
	type HyperchartSessionProgress,
} from "../runtime/pi/session_progress.js";
import { buildRunView, type GraphRow, type RunView } from "./run_view.js";

export type RunComponentOptions = {
	runId: string;
	runDir: string;
	logPath: string;
	ast: ChartAst;
	live?: boolean;
	cwd?: string;
};

export type RunHistoryItem = {
	runId: string;
	runDir: string;
	chartId: string;
	state: string;
	live: boolean;
	final: boolean;
	sessionCount: number;
	createdAt: string;
	updatedAt: string;
};

export type RunHistoryAction =
	| { kind: "resume"; runId: string }
	| { kind: "restart"; runId: string }
	| { kind: "stop"; runId: string }
	| { kind: "delete"; runId: string }
	| { kind: "view"; runId: string }
	| { kind: "close" };

type RunHistoryMode = "runs" | "sessions" | "sessionLog";

type RunHistorySessionItem = {
	key: string;
	label: string;
	fullLabel: string;
	actionName: string;
	status: string;
	model?: string;
	sessionFile?: string;
	toolCount?: number;
	tokenCount?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	startedAt?: number;
	completedAt?: number;
	error?: string;
};

export class RunHistoryOverlay implements Component {
	private mode: RunHistoryMode = "runs";
	private selected = 0;
	private selectedSession = 0;
	private sessionLogScroll = 0;
	private sessionLogExpanded = false;
	private expandedHelp = false;
	private readonly runList: SelectList;
	private sessionList: SelectList | undefined;
	private sessionListRunId: string | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly opts: {
			cwd: string;
			items: readonly RunHistoryItem[];
			done: (action: RunHistoryAction) => void;
		},
	) {
		this.runList = new SelectList(runSelectItems(opts.items), 12, getSelectListTheme(), {
			minPrimaryColumnWidth: 36,
			maxPrimaryColumnWidth: 56,
		});
		this.runList.setSelectedIndex(this.selected);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (data === "?") {
			this.expandedHelp = !this.expandedHelp;
			this.tui.requestRender();
			return;
		}
		if (data === "q" || (data === "\u001b" && this.mode === "runs")) {
			this.opts.done({ kind: "close" });
			return;
		}
		if (this.mode === "sessions") {
			this.handleSessionsInput(data);
			return;
		}
		if (this.mode === "sessionLog") {
			this.handleSessionLogInput(data);
			return;
		}
		this.handleRunsInput(data);
	}

	render(width: number): string[] {
		if (this.mode === "sessions") return this.renderSessions(width);
		if (this.mode === "sessionLog") return this.renderSessionLog(width);
		return this.renderRuns(width);
	}

	private handleRunsInput(data: string): void {
		if (data === "\u001b[A" || data === "k") {
			this.moveRun(-1);
			return;
		}
		if (data === "\u001b[B" || data === "j") {
			this.moveRun(1);
			return;
		}
		const item = this.opts.items[this.selected];
		if (item === undefined) return;
		if (data === "\r" || data === "\n") {
			this.opts.done({ kind: "view", runId: item.runId });
			return;
		}
		if (data === "\u001b[C" || data === "l") {
			this.enterSessions();
			return;
		}
		this.maybeRunAction(data, item);
	}

	private handleSessionsInput(data: string): void {
		const run = this.opts.items[this.selected];
		const sessions = run === undefined ? [] : loadRunHistorySessions(run.runDir);
		if (data === "\u001b" || data === "\u001b[D" || data === "h" || data === "\u007f") {
			this.mode = "runs";
			this.tui.requestRender();
			return;
		}
		if (data === "\u001b[A" || data === "k") {
			this.moveSession(-1, sessions.length);
			return;
		}
		if (data === "\u001b[B" || data === "j") {
			this.moveSession(1, sessions.length);
			return;
		}
		if (
			(data === "\r" || data === "\n" || data === "\u001b[C" || data === "l") &&
			sessions[this.selectedSession] !== undefined
		) {
			this.mode = "sessionLog";
			this.sessionLogScroll = Number.MAX_SAFE_INTEGER;
			this.tui.requestRender();
			return;
		}
		if (run !== undefined) this.maybeRunAction(data, run);
	}

	private handleSessionLogInput(data: string): void {
		if (data === "\u001b" || data === "\u001b[D" || data === "h" || data === "\u007f") {
			this.mode = "sessions";
			this.tui.requestRender();
			return;
		}
		if (data === "\u000f") {
			this.sessionLogExpanded = !this.sessionLogExpanded;
			this.tui.requestRender();
			return;
		}
		if (data === "\u001b[A" || data === "k") {
			this.sessionLogScroll = Math.max(0, this.sessionLogScroll - 1);
			this.tui.requestRender();
			return;
		}
		if (data === "\u001b[B" || data === "j") {
			this.sessionLogScroll += 1;
			this.tui.requestRender();
			return;
		}
		if (data === "\u001b[5~" || data === "u") {
			this.sessionLogScroll = Math.max(0, this.sessionLogScroll - 8);
			this.tui.requestRender();
			return;
		}
		if (data === "\u001b[6~" || data === "d") {
			this.sessionLogScroll += 8;
			this.tui.requestRender();
			return;
		}
		const run = this.opts.items[this.selected];
		if (run !== undefined) this.maybeRunAction(data, run);
	}

	private maybeRunAction(data: string, item: RunHistoryItem): void {
		if (data === "v") this.opts.done({ kind: "view", runId: item.runId });
		if (data === "r") this.opts.done({ kind: "restart", runId: item.runId });
		if (data === "s") this.opts.done({ kind: "stop", runId: item.runId });
		if (data === "d") this.opts.done({ kind: "delete", runId: item.runId });
		if (data === "e") this.opts.done({ kind: "resume", runId: item.runId });
	}

	private moveRun(delta: number): void {
		this.selected = clamp(this.selected + delta, 0, Math.max(0, this.opts.items.length - 1));
		this.runList.setSelectedIndex(this.selected);
		this.selectedSession = 0;
		this.sessionList = undefined;
		this.sessionListRunId = undefined;
		this.tui.requestRender();
	}

	private moveSession(delta: number, sessionCount: number): void {
		this.selectedSession = clamp(this.selectedSession + delta, 0, Math.max(0, sessionCount - 1));
		this.sessionList?.setSelectedIndex(this.selectedSession);
		this.tui.requestRender();
	}

	private enterSessions(): void {
		this.mode = "sessions";
		this.selectedSession = 0;
		this.sessionList = undefined;
		this.sessionListRunId = undefined;
		this.tui.requestRender();
	}

	private getSessionList(run: RunHistoryItem, sessions: readonly RunHistorySessionItem[]): SelectList {
		if (this.sessionList !== undefined && this.sessionListRunId === run.runId) return this.sessionList;
		this.sessionList = new SelectList(sessionSelectItems(sessions), 10, getSelectListTheme(), {
			minPrimaryColumnWidth: 28,
			maxPrimaryColumnWidth: 44,
		});
		this.sessionListRunId = run.runId;
		this.sessionList.setSelectedIndex(this.selectedSession);
		return this.sessionList;
	}

	private renderRuns(width: number): string[] {
		const selected = this.opts.items[this.selected];
		this.runList.setSelectedIndex(this.selected);
		const content = [
			joinParts(this.theme, [this.theme.bold("Hyperchart runs"), dim(this.theme, this.opts.cwd)]),
			...runHistoryHintLines("runs", this.theme, this.expandedHelp),
			"",
			...this.runList.render(width - 8),
			"",
			...(selected === undefined ? [] : renderRunHistoryHelp(selected, this.theme)),
		];
		return box(content, width, this.theme);
	}

	private renderSessions(width: number): string[] {
		const run = this.opts.items[this.selected];
		if (run === undefined) return box([dim(this.theme, "no run selected")], width, this.theme);
		const sessions = loadRunHistorySessions(run.runDir);
		this.selectedSession = Math.min(this.selectedSession, Math.max(0, sessions.length - 1));
		const selected = sessions[this.selectedSession];
		const sessionList = this.getSessionList(run, sessions);
		sessionList.setSelectedIndex(this.selectedSession);
		const content = [
			joinParts(this.theme, [
				this.theme.bold(run.runId),
				dim(this.theme, run.chartId),
				colorHistoryState(this.theme, run),
			]),
			...runHistoryHintLines("sessions", this.theme, this.expandedHelp),
			"",
			heading(this.theme, "sessions"),
			...(sessions.length === 0 ? [dim(this.theme, "  no sessions yet")] : sessionList.render(width - 8)),
			"",
			...(selected === undefined ? [] : [dim(this.theme, `Enter opens ${selected.label} log. Cursor only selects.`)]),
		];
		return box(content, width, this.theme);
	}

	private renderSessionLog(width: number): string[] {
		const run = this.opts.items[this.selected];
		if (run === undefined) return box([dim(this.theme, "no run selected")], width, this.theme);
		const sessions = loadRunHistorySessions(run.runDir);
		this.selectedSession = Math.min(this.selectedSession, Math.max(0, sessions.length - 1));
		const session = sessions[this.selectedSession];
		if (session === undefined) return box([dim(this.theme, "no session selected")], width, this.theme);
		const logLines = historySessionTranscriptLines(
			session,
			this.tui,
			this.opts.cwd,
			width - 8,
			this.theme,
			this.sessionLogExpanded,
		);
		const header = [
			joinParts(this.theme, [
				this.theme.bold(session.label),
				dim(this.theme, run.runId),
				colorHistorySessionStatus(this.theme, session.status),
			]),
			...runHistoryHintLines("sessionLog", this.theme, this.expandedHelp, this.sessionLogExpanded),
			"",
			heading(this.theme, "log"),
			joinParts(this.theme, [
				dim(this.theme, session.fullLabel),
				session.sessionFile === undefined ? undefined : dim(this.theme, basename(session.sessionFile)),
				historySessionStats(session, this.theme),
			]),
			"",
		];
		const visibleLogRows = Math.max(1, (process.stdout.rows ?? 40) - header.length - 5);
		this.sessionLogScroll = Math.min(Math.max(0, this.sessionLogScroll), Math.max(0, logLines.length - visibleLogRows));
		const content = [
			...header,
			...logLines.slice(this.sessionLogScroll, this.sessionLogScroll + visibleLogRows).map((line) => `  ${line}`),
			"",
			dim(
				this.theme,
				`${logLines.length === 0 ? 0 : this.sessionLogScroll + 1}-${Math.min(logLines.length, this.sessionLogScroll + visibleLogRows)} / ${logLines.length}`,
			),
		];
		return box(content, width, this.theme);
	}
}

function runHistoryHintLines(mode: RunHistoryMode, theme: Theme, expanded: boolean, logExpanded = false): string[] {
	if (!expanded) {
		if (mode === "runs") return [dim(theme, "↑↓ choose run · Enter view · → sessions · ? help · q close")];
		if (mode === "sessions") return [dim(theme, "↑↓ choose session · Enter log · ← back · ? help")];
		return [dim(theme, `↑↓ scroll · Ctrl+O ${logExpanded ? "collapse" : "expand"} · ← back · ? help`)];
	}
	const nav =
		mode === "runs"
			? "Enter: open graph view · →/l: open sessions/logs"
			: mode === "sessions"
				? "Enter: open selected session log"
				: `↑↓/PgUp/PgDn: scroll session log · Ctrl+O: ${logExpanded ? "collapse" : "expand"} details`;
	const back = mode === "runs" ? "q: close" : "←/Esc: back · q: close";
	return [
		dim(theme, nav),
		dim(theme, back),
		dim(theme, "Whole run actions from any screen:"),
		dim(theme, "e: resume same run dir · r: restart as new run"),
		dim(theme, "s: stop runner · d: delete run dir"),
		dim(theme, "v: open run view · ?: hide help"),
	];
}

function runSelectItems(items: readonly RunHistoryItem[]): SelectItem[] {
	return items.map((item) => ({
		value: item.runId,
		label: item.runId,
		description: [
			item.chartId,
			runHistoryStateGlyphPlain(item),
			`${item.sessionCount} session${item.sessionCount === 1 ? "" : "s"}`,
			`created ${item.createdAt}`,
			item.updatedAt === item.createdAt ? undefined : `updated ${item.updatedAt}`,
		]
			.filter((part): part is string => part !== undefined && part.length > 0)
			.join(" · "),
	}));
}

function sessionSelectItems(items: readonly RunHistorySessionItem[]): SelectItem[] {
	return items.map((item) => ({
		value: item.key,
		label: item.label,
		description: [
			item.actionName,
			sessionStatusGlyphPlain(item.status),
			shortModel(item.model),
			historySessionStatsPlain(item),
			historySessionActivityPlain(item),
		]
			.filter((part): part is string => part !== undefined && part.length > 0)
			.join(" · "),
	}));
}

function runHistoryStateGlyphPlain(item: RunHistoryItem): string {
	if (item.live) return "▶";
	if (item.state === "complete") return "✓";
	if (item.state === "failed") return "✗";
	if (item.state === "stopped") return "■";
	if (item.state === "stale") return "◌";
	return "○";
}

function sessionStatusGlyphPlain(status: string): string {
	if (status === "running") return "●";
	if (status === "starting") return "○";
	if (status === "completed" || status === "saved") return "✓";
	if (status === "failed") return "✗";
	if (status === "cancelled") return "■";
	return "?";
}

function historySessionStatsPlain(session: RunHistorySessionItem): string | undefined {
	return session.tokenCount !== undefined && session.tokenCount > 0
		? `${formatTokens(session.tokenCount)} tok`
		: undefined;
}

function historySessionActivityPlain(session: RunHistorySessionItem): string | undefined {
	if (session.currentTool !== undefined) return session.currentTool;
	if (session.status === "running") return "thinking";
	if (session.status === "starting") return "starting";
	if (session.status === "completed") return `done ${historySessionDuration(session)}`;
	if (session.status === "failed") return `failed ${oneLine(session.error ?? "unknown error")}`;
	if (session.status === "cancelled") return undefined;
	return undefined;
}

function loadRunHistorySessions(runDir: string): RunHistorySessionItem[] {
	const sessionsDir = resolve(runDir, "sessions");
	if (!existsSync(sessionsDir)) return [];
	const fromProgress = Object.values(readSessionProgress(sessionsDir).sessions).map(progressSessionItem);
	const seenDirs = new Set(
		fromProgress
			.map((session) => (session.sessionFile === undefined ? undefined : basename(dirname(session.sessionFile))))
			.filter((value): value is string => value !== undefined),
	);
	const fallback = readdirSync(sessionsDir)
		.filter((entry) => entry !== "progress.json")
		.map((entry) => resolve(sessionsDir, entry))
		.filter((path) => existsSync(path) && statSync(path).isDirectory() && !seenDirs.has(basename(path)))
		.map(fallbackSessionItem)
		.filter((item): item is RunHistorySessionItem => item !== undefined);
	return [...fromProgress, ...fallback].sort((left, right) => historySessionRank(left) - historySessionRank(right));
}

function progressSessionItem(session: HyperchartSessionProgress): RunHistorySessionItem {
	return {
		key: session.actionKey,
		label: shortPath(session.actionUid.state),
		fullLabel: session.actionUid.state,
		actionName: shortAgentName(session.actionName),
		status: session.status,
		...(session.model === undefined ? {} : { model: session.model }),
		...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
		...(session.toolCount === undefined ? {} : { toolCount: session.toolCount }),
		...(session.tokenCount === undefined ? {} : { tokenCount: session.tokenCount }),
		...(session.currentTool === undefined ? {} : { currentTool: session.currentTool }),
		...(session.currentToolArgs === undefined ? {} : { currentToolArgs: session.currentToolArgs }),
		...(session.currentToolStartedAt === undefined ? {} : { currentToolStartedAt: session.currentToolStartedAt }),
		startedAt: session.startedAt,
		...(session.completedAt === undefined ? {} : { completedAt: session.completedAt }),
		...(session.error === undefined ? {} : { error: session.error }),
	};
}

function fallbackSessionItem(sessionDir: string): RunHistorySessionItem | undefined {
	const sessionFile = latestSessionFile(sessionDir);
	return {
		key: basename(sessionDir),
		label: compactSessionDirName(basename(sessionDir)),
		fullLabel: basename(sessionDir),
		actionName: "agent",
		status: sessionFile === undefined ? "unknown" : "saved",
		...(sessionFile === undefined ? {} : { sessionFile }),
	};
}

function latestSessionFile(sessionDir: string): string | undefined {
	return readdirSync(sessionDir)
		.filter((entry) => entry.endsWith(".jsonl"))
		.map((entry) => resolve(sessionDir, entry))
		.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

function compactSessionDirName(name: string): string {
	const parts = name.split("_");
	return parts.length >= 3 ? shortPath(parts.slice(1, -1).join(".")) : name;
}

function historySessionTranscriptLines(
	session: RunHistorySessionItem,
	tui: TUI,
	cwd: string,
	width: number,
	theme: Theme,
	expanded: boolean,
): string[] {
	if (session.sessionFile === undefined || !existsSync(session.sessionFile)) return [dim(theme, "no transcript yet")];
	const lines = renderPiSessionLog(session.sessionFile, tui, cwd, width, theme, expanded);
	return lines.length === 0 ? [dim(theme, "no transcript activity yet")] : lines;
}

function historySessionStats(session: RunHistorySessionItem, theme: Theme): string | undefined {
	return session.tokenCount !== undefined && session.tokenCount > 0
		? dim(theme, `${formatTokens(session.tokenCount)} tok`)
		: undefined;
}

function historySessionDuration(session: RunHistorySessionItem): string {
	if (session.startedAt === undefined) return "";
	return formatDuration(Math.max(0, (session.completedAt ?? Date.now()) - session.startedAt));
}

function historySessionRank(session: RunHistorySessionItem): number {
	if (session.status === "running" || session.status === "starting") return 0;
	if (session.status === "failed") return 1;
	if (session.status === "cancelled") return 2;
	return 3;
}

function colorHistorySessionStatus(theme: Theme, status: string): string {
	const glyph = sessionStatusGlyphPlain(status);
	if (status === "running" || status === "starting") return accent(theme, glyph);
	if (status === "completed" || status === "saved") return success(theme, glyph);
	if (status === "failed") return error(theme, glyph);
	if (status === "cancelled") return warning(theme, glyph);
	return dim(theme, glyph);
}

function renderRunHistoryHelp(item: RunHistoryItem, theme: Theme): string[] {
	return [
		heading(theme, "selected"),
		joinParts(theme, [theme.bold(item.runId), colorHistoryState(theme, item), dim(theme, item.runDir)]),
		dim(theme, "Enter opens this run's sessions."),
		joinParts(theme, [
			item.live ? warning(theme, "s stop running process") : accent(theme, "e resume run in same dir"),
			accent(theme, "r restart run as new run"),
			warning(theme, "d delete run dir"),
			dim(theme, "v open run view"),
		]),
	];
}

function colorHistoryState(theme: Theme, item: RunHistoryItem): string {
	const glyph = runHistoryStateGlyphPlain(item);
	if (item.live) return accent(theme, glyph);
	if (item.state === "complete") return success(theme, glyph);
	if (item.state === "failed") return error(theme, glyph);
	if (item.state === "stopped" || item.state === "stale") return warning(theme, glyph);
	return dim(theme, glyph);
}

export class RunWidget implements Component {
	private view: RunView | undefined;
	private progress: Record<string, HyperchartSessionProgress> = {};
	private disposed = false;
	private lastStat = "";
	private readonly timer: NodeJS.Timeout;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly opts: RunComponentOptions,
	) {
		this.timer = setInterval(() => void this.refresh(), 300);
		this.timer.unref();
		void this.refresh();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const view = this.view;
		if (view === undefined) return [truncate(dim(this.theme, `hyperchart ${this.opts.runId} · loading`), width)];
		const actions = actionRows(view);
		const active = activeRows(actions);
		const completed = actions.filter((row) => row.status === "completed" || row.status === "final").length;
		const sessions = activeSessions(this.progress, this.opts.live === true);
		const live = this.opts.live === true;
		const runState = colorRunState(this.theme, runStateLabel(view, live));
		const activeCount = sessions.length > 0 ? sessions.length : active.length;
		const activeLabel = live ? `${activeCount} running` : `${activeCount} stale`;
		const sessionLines = sessions
			.slice(0, 4)
			.map((session) => `  ${compactSessionLine(session, this.theme, false, live)}`);
		const fallbackLines =
			sessions.length > 0
				? []
				: active
						.slice(0, 4)
						.map(
							(row) =>
								`  ${joinParts(this.theme, [
									colorStatusGlyph(this.theme, row.status, live),
									this.theme.bold(shortPath(row.path)),
									row.sinceMs === undefined ? undefined : dim(this.theme, formatDuration(row.sinceMs)),
								])}`,
						);
		const lines = [
			joinParts(this.theme, [
				this.theme.bold(`hyperchart ${view.chartId}`),
				runState,
				accent(this.theme, activeLabel),
				dim(this.theme, `${completed}/${actions.length} actions`),
			]),
			...sessionLines,
			...fallbackLines,
			sessions.length > 4 ? dim(this.theme, `  +${sessions.length - 4} more running sessions`) : undefined,
			sessions.length === 0 && active.length > 4
				? dim(this.theme, `  +${active.length - 4} more active states`)
				: undefined,
		].filter((line): line is string => line !== undefined && line.length > 0);
		return lines.map((line) => truncate(line, width));
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
	}

	private async refresh(): Promise<void> {
		if (this.disposed) return;
		const progressPath = sessionProgressPath(resolve(this.opts.runDir, "sessions"));
		const statKey = `${statKeyFor(this.opts.logPath)}:${statKeyFor(progressPath)}`;
		if (statKey === this.lastStat && this.view !== undefined) return;
		this.lastStat = statKey;
		const store = new JsonlLogStore(this.opts.logPath);
		this.view = buildRunView(this.opts.ast, await store.readAll(), Date.now());
		this.progress = readSessionProgress(resolve(this.opts.runDir, "sessions")).sessions;
		this.tui.requestRender();
	}
}

export class RunOverlay implements Component {
	private view: RunView | undefined;
	private progress: Record<string, HyperchartSessionProgress> = {};
	private disposed = false;
	private mode: "view" | "sessionLog" = "view";
	private scroll = 0;
	private sessionLogScroll = 0;
	private sessionLogExpanded = false;
	private selectedSession = 0;
	private readonly timer: NodeJS.Timeout;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly opts: RunComponentOptions,
		private readonly done: () => void,
	) {
		this.timer = setInterval(() => void this.refresh(), 300);
		this.timer.unref();
		void this.refresh();
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (data === "q") {
			this.done();
			return;
		}
		if (this.mode === "sessionLog") {
			this.handleSessionLogInput(data);
			return;
		}
		if (data === "\u001b") {
			this.done();
			return;
		}
		const sessions = sortedSessions(this.progress);
		if (data === "\u001b[A" || data === "k") {
			this.selectedSession = Math.max(0, this.selectedSession - 1);
			this.tui.requestRender();
			return;
		}
		if (data === "\u001b[B" || data === "j") {
			this.selectedSession = Math.min(Math.max(0, sessions.length - 1), this.selectedSession + 1);
			this.tui.requestRender();
			return;
		}
		if (
			(data === "\r" || data === "\n" || data === "\u001b[C" || data === "l") &&
			sessions[this.selectedSession] !== undefined
		) {
			this.mode = "sessionLog";
			this.sessionLogScroll = Number.MAX_SAFE_INTEGER;
			this.tui.requestRender();
			return;
		}
		if (data === "\u001b[5~" || data === "u") this.scroll = Math.max(0, this.scroll - 5);
		if (data === "\u001b[6~" || data === "d") this.scroll += 5;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.mode === "sessionLog") return this.renderSessionLog(width);
		return this.renderView(width);
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
	}

	private handleSessionLogInput(data: string): void {
		if (data === "\u001b" || data === "\u001b[D" || data === "h" || data === "\u007f") {
			this.mode = "view";
			this.tui.requestRender();
			return;
		}
		if (data === "\u000f") {
			this.sessionLogExpanded = !this.sessionLogExpanded;
			this.tui.requestRender();
			return;
		}
		if (data === "\u001b[A" || data === "k") {
			this.sessionLogScroll = Math.max(0, this.sessionLogScroll - 1);
			this.tui.requestRender();
			return;
		}
		if (data === "\u001b[B" || data === "j") {
			this.sessionLogScroll += 1;
			this.tui.requestRender();
			return;
		}
		if (data === "\u001b[5~" || data === "u") {
			this.sessionLogScroll = Math.max(0, this.sessionLogScroll - 8);
			this.tui.requestRender();
			return;
		}
		if (data === "\u001b[6~" || data === "d") {
			this.sessionLogScroll += 8;
			this.tui.requestRender();
		}
	}

	private renderView(width: number): string[] {
		const view = this.view;
		if (view === undefined) {
			return box([this.theme.bold(`hyperchart ${this.opts.runId}`), dim(this.theme, "loading…")], width, this.theme);
		}
		const live = this.opts.live === true;
		const sessions = sortedSessions(this.progress);
		this.selectedSession = Math.min(this.selectedSession, Math.max(0, sessions.length - 1));
		const selected = sessions[this.selectedSession];
		const content = [
			joinParts(this.theme, [
				this.theme.bold(view.chartId),
				dim(this.theme, `run ${this.opts.runId}`),
				colorRunState(this.theme, runStateLabel(view, live)),
			]),
			statusSummary(view, this.theme, live),
			"",
			heading(this.theme, "graph"),
			...renderGraph(view.graph, this.progress, width - 8, this.theme, live),
			"",
			heading(this.theme, "sessions"),
			...renderSessions(sessions, width - 8, this.theme, live, this.selectedSession),
			"",
			...renderSelectedSession(selected, width - 8, this.theme),
			"",
			dim(this.theme, "↑↓ session · Enter log · PgUp/PgDn scroll · q close"),
		];
		this.scroll = clampScroll(this.scroll, content.length);
		return box(content.slice(this.scroll), width, this.theme);
	}

	private renderSessionLog(width: number): string[] {
		const sessions = sortedSessions(this.progress);
		this.selectedSession = Math.min(this.selectedSession, Math.max(0, sessions.length - 1));
		const session = sessions[this.selectedSession];
		if (session === undefined) return box([dim(this.theme, "no session selected")], width, this.theme);
		const item = progressSessionItem(session);
		const logLines = historySessionTranscriptLines(
			item,
			this.tui,
			this.opts.cwd ?? process.cwd(),
			width - 8,
			this.theme,
			this.sessionLogExpanded,
		);
		const header = [
			joinParts(this.theme, [
				this.theme.bold(item.label),
				dim(this.theme, this.opts.runId),
				colorHistorySessionStatus(this.theme, item.status),
			]),
			dim(this.theme, `↑↓ scroll · Ctrl+O ${this.sessionLogExpanded ? "collapse" : "expand"} · ← back · q close`),
			"",
			heading(this.theme, "log"),
			joinParts(this.theme, [
				dim(this.theme, item.fullLabel),
				item.sessionFile === undefined ? undefined : dim(this.theme, basename(item.sessionFile)),
				historySessionStats(item, this.theme),
			]),
			"",
		];
		const visibleLogRows = Math.max(1, (process.stdout.rows ?? 40) - header.length - 5);
		this.sessionLogScroll = Math.min(Math.max(0, this.sessionLogScroll), Math.max(0, logLines.length - visibleLogRows));
		const content = [
			...header,
			...logLines.slice(this.sessionLogScroll, this.sessionLogScroll + visibleLogRows).map((line) => `  ${line}`),
			"",
			dim(
				this.theme,
				`${logLines.length === 0 ? 0 : this.sessionLogScroll + 1}-${Math.min(logLines.length, this.sessionLogScroll + visibleLogRows)} / ${logLines.length}`,
			),
		];
		return box(content, width, this.theme);
	}

	private async refresh(): Promise<void> {
		if (this.disposed) return;
		const store = new JsonlLogStore(this.opts.logPath);
		this.view = buildRunView(this.opts.ast, await store.readAll(), Date.now());
		this.progress = readSessionProgress(resolve(this.opts.runDir, "sessions")).sessions;
		this.tui.requestRender();
	}
}

function runStateLabel(view: RunView, live: boolean): string {
	if (view.final) return isFailedRunView(view) ? "FAILED" : "DONE";
	return live ? "RUNNING" : "DETACHED";
}

function isFailedRunView(view: RunView): boolean {
	return view.graph.some((row) => row.status === "failed" || (row.status === "final" && isFailureStatePath(row.path)));
}

function statusSummary(view: RunView, theme: Theme, live = true): string {
	const actions = actionRows(view);
	const counts = new Map<string, number>();
	for (const row of actions) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
	const activeLabel = live ? "running" : "stale in log";
	return joinParts(theme, [
		counts.get("running") ? accent(theme, `${counts.get("running")} ${activeLabel}`) : undefined,
		counts.get("validating") ? accent(theme, `${counts.get("validating")} validating`) : undefined,
		counts.get("rejected") ? warning(theme, `${counts.get("rejected")} rejected`) : undefined,
		counts.get("failed") ? error(theme, `${counts.get("failed")} failed`) : undefined,
		dim(theme, `${(counts.get("completed") ?? 0) + (counts.get("final") ?? 0)}/${actions.length} actions done`),
	]);
}

function renderGraph(
	rows: readonly GraphRow[],
	progress: Record<string, HyperchartSessionProgress>,
	width: number,
	theme: Theme,
	live: boolean,
): string[] {
	return rows.map((row, index) => {
		const session = sessionFor(row.path, progress);
		const prefix = dim(theme, treePrefix(rows, index));
		const name = row.status === "pending" ? dim(theme, row.label) : theme.bold(row.label);
		const parts = [
			`${prefix}${colorStatusGlyph(theme, row.status, live)} ${name}`,
			shortAction(row, session) === undefined ? undefined : dim(theme, shortAction(row, session) ?? ""),
			formatGraphStatus(row, theme, live),
			row.event === undefined ? undefined : success(theme, `→ ${row.event}`),
			row.durationMs === undefined ? undefined : dim(theme, formatDuration(row.durationMs)),
		].filter((part): part is string => part !== undefined && part.length > 0);
		return truncate(joinParts(theme, parts), width);
	});
}

function renderSessions(
	sessions: readonly HyperchartSessionProgress[],
	width: number,
	theme: Theme,
	live: boolean,
	selectedIndex: number,
): string[] {
	if (sessions.length === 0) return [dim(theme, "- none yet")];
	return sessions.flatMap((session, index) => renderSession(session, width, theme, live, index === selectedIndex));
}

function sortedSessions(progress: Record<string, HyperchartSessionProgress>): HyperchartSessionProgress[] {
	return Object.values(progress).sort((left, right) => sessionRank(left) - sessionRank(right));
}

function renderSession(
	session: HyperchartSessionProgress,
	width: number,
	theme: Theme,
	live: boolean,
	selected: boolean,
): string[] {
	const line1 = joinParts(theme, [
		`${colorSessionGlyph(theme, session.status, live)} ${theme.bold(shortPath(session.actionUid.state))}`,
		dim(theme, shortAgentName(session.actionName)),
		formatSessionStatus(session, theme, live),
		shortModel(session.model) === undefined ? undefined : dim(theme, shortModel(session.model) ?? ""),
	]);
	const line2 = `${selected ? accent(theme, "│") : dim(theme, "│")} ${currentActivityLine(session, theme, live)}`;
	return [truncate(`${selected ? accent(theme, "›") : dim(theme, "-")} ${line1}`, width), truncate(line2, width)];
}

function sessionActivityStats(session: HyperchartSessionProgress, theme: Theme): string | undefined {
	const parts = [
		session.toolCount > 0 ? `${session.toolCount} tools` : undefined,
		session.tokenCount !== undefined && session.tokenCount > 0 ? `${formatTokens(session.tokenCount)} tok` : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(" · ");
	return parts.length === 0 ? undefined : dim(theme, parts);
}

function currentActivityLine(session: HyperchartSessionProgress, theme: Theme, live: boolean): string {
	const stats = sessionActivityStats(session, theme);
	if (!live && (session.status === "running" || session.status === "starting")) {
		return joinParts(theme, [dim(theme, "detached; live activity unknown"), stats]);
	}
	if (session.status === "starting") return joinParts(theme, [accent(theme, "starting"), stats]);
	if (session.status === "running") {
		if (session.currentTool !== undefined) {
			return joinParts(theme, [
				accent(theme, session.currentTool),
				toolArgsSummary(session.currentTool, session.currentToolArgs, theme),
				currentToolAge(session, theme),
				stats,
			]);
		}
		return joinParts(theme, [accent(theme, "thinking"), stats]);
	}
	if (session.status === "completed")
		return joinParts(theme, [success(theme, `done ${formatDuration(sessionDuration(session))}`), stats]);
	if (session.status === "failed")
		return joinParts(theme, [error(theme, `failed ${oneLine(session.error ?? "unknown error")}`), stats]);
	return joinParts(theme, [warning(theme, sessionStatusGlyph(session.status)), stats]);
}

function renderSelectedSession(session: HyperchartSessionProgress | undefined, width: number, theme: Theme): string[] {
	if (session === undefined) return [];
	return [
		heading(theme, `session · ${shortPath(session.actionUid.state)}`),
		...sessionTranscriptTail(session, theme).map((line) => truncate(`  ${line}`, width)),
	];
}

function sessionTranscriptTail(session: HyperchartSessionProgress, theme: Theme): string[] {
	if (session.sessionFile === undefined || !existsSync(session.sessionFile)) return [dim(theme, "no transcript yet")];
	const lines = readSessionActivityLines(session.sessionFile, theme).slice(-8);
	return lines.length === 0 ? [dim(theme, "no transcript activity yet")] : lines;
}

function renderPiSessionLog(
	path: string,
	tui: TUI,
	cwd: string,
	width: number,
	theme: Theme,
	expanded: boolean,
): string[] {
	const records = readSessionRecords(path);
	const calls = new Map<string, { name: string; args: unknown }>();
	const lines: string[] = [];
	for (const record of records) {
		if (!isRecord(record)) continue;
		if (record.type === "model_change") {
			const provider = typeof record.provider === "string" ? record.provider : undefined;
			const modelId = typeof record.modelId === "string" ? record.modelId : undefined;
			lines.push(dim(theme, `model ${[provider, modelId].filter(Boolean).join("/")}`), "");
			continue;
		}
		if (record.type === "thinking_level_change" && typeof record.thinkingLevel === "string") {
			lines.push(dim(theme, `thinking ${record.thinkingLevel}`), "");
			continue;
		}
		if (record.type === "session_info" && typeof record.name === "string") {
			lines.push(heading(theme, record.name), "");
			continue;
		}
		if (record.type !== "message" || !isRecord(record.message)) continue;
		const message = record.message;
		rememberToolCalls(message, calls);
		const rendered = renderPiMessage(message, calls, tui, cwd, width, theme, expanded);
		if (rendered.length > 0) lines.push(...rendered, "");
	}
	while (lines.at(-1) === "") lines.pop();
	return lines;
}

function renderPiMessage(
	message: Record<string, unknown>,
	calls: ReadonlyMap<string, { name: string; args: unknown }>,
	tui: TUI,
	cwd: string,
	width: number,
	theme: Theme,
	expanded: boolean,
): string[] {
	try {
		if (message.role === "user") {
			const text = textContent(message.content);
			return text === undefined ? [] : new UserMessageComponent(text, getMarkdownTheme(), 0).render(width);
		}
		if (message.role === "assistant") {
			return new AssistantMessageComponent(message as never, !expanded, getMarkdownTheme(), "thinking", 0).render(
				width,
			);
		}
		if (message.role === "toolResult") {
			return renderPiToolResult(message, calls, tui, cwd, width, expanded);
		}
	} catch {
		return activityLinesFromRecord({ type: "message", message }, theme);
	}
	return [];
}

function renderPiToolResult(
	message: Record<string, unknown>,
	calls: ReadonlyMap<string, { name: string; args: unknown }>,
	tui: TUI,
	cwd: string,
	width: number,
	expanded: boolean,
): string[] {
	const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "unknown";
	const call = calls.get(toolCallId);
	const toolName = typeof message.toolName === "string" ? message.toolName : (call?.name ?? "tool");
	const component = new ToolExecutionComponent(toolName, toolCallId, call?.args ?? {}, undefined, undefined, tui, cwd);
	component.setExpanded(expanded);
	component.markExecutionStarted();
	component.setArgsComplete();
	component.updateResult({
		content: normalizeToolResultContent(message.content),
		...(message.details === undefined ? {} : { details: message.details }),
		isError: message.isError === true,
	});
	return component.render(width);
}

function rememberToolCalls(
	message: Record<string, unknown>,
	calls: Map<string, { name: string; args: unknown }>,
): void {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return;
	for (const item of message.content) {
		if (!isRecord(item) || item.type !== "toolCall" || typeof item.id !== "string" || typeof item.name !== "string") {
			continue;
		}
		calls.set(item.id, { name: item.name, args: item.arguments });
	}
}

function normalizeToolResultContent(
	content: unknown,
): Array<{ type: string; text?: string; data?: string; mimeType?: string }> {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	return content
		.map((item) => {
			if (!isRecord(item) || typeof item.type !== "string") return undefined;
			return {
				type: item.type,
				...(typeof item.text === "string" ? { text: item.text } : {}),
				...(typeof item.data === "string" ? { data: item.data } : {}),
				...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
			};
		})
		.filter((item): item is { type: string; text?: string; data?: string; mimeType?: string } => item !== undefined);
}

function readSessionRecords(path: string): unknown[] {
	try {
		return readFileSync(path, "utf8")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map(parseJson);
	} catch {
		return [];
	}
}

function readSessionActivityLines(path: string, theme: Theme): string[] {
	try {
		return readFileSync(path, "utf8")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.flatMap((line) => activityLinesFromRecord(parseJson(line), theme));
	} catch {
		return [dim(theme, "cannot read transcript")];
	}
}

function activityLinesFromRecord(record: unknown, theme: Theme): string[] {
	if (!isRecord(record)) return [];
	if (record.type === "session_info" && typeof record.name === "string") return [dim(theme, `title: ${record.name}`)];
	if (record.type !== "message" || !isRecord(record.message)) return [];
	const message = record.message;
	if (message.role === "assistant") return assistantActivityLines(message.content, theme);
	if (message.role === "toolResult") {
		const name = typeof message.toolName === "string" ? message.toolName : "tool";
		const result = summarizeToolResult(message.content);
		return [dim(theme, `result ${name}${result === undefined ? "" : `: ${result}`}`)];
	}
	return [];
}

function assistantActivityLines(content: unknown, theme: Theme): string[] {
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const item of content) {
		if (!isRecord(item)) continue;
		if (item.type === "toolCall" && typeof item.name === "string") {
			out.push(accent(theme, `tool ${item.name}${formatToolCallArgs(item.name, item.arguments)}`));
		} else if (item.type === "text" && typeof item.text === "string") {
			out.push(dim(theme, `assistant: ${oneLine(item.text)}`));
		} else if (item.type === "thinking" && typeof item.thinking === "string") {
			out.push(dim(theme, `thinking: ${oneLine(item.thinking)}`));
		}
	}
	return out;
}

function formatToolCallArgs(name: string, args: unknown): string {
	const summary = summarizeToolArgs(name, typeof args === "string" ? args : JSON.stringify(args));
	return summary === undefined ? "" : ` · ${summary}`;
}

function summarizeToolResult(content: unknown): string | undefined {
	const text = textContent(content);
	if (text === undefined) return undefined;
	const lineCount = text.split(/\r?\n/).length;
	if (text.length > 240 || lineCount > 4) return `${lineCount} lines · ${formatChars(text.length)}`;
	return oneLine(text);
}

function textContent(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts = content
		.map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : undefined))
		.filter((item): item is string => item !== undefined);
	return parts.length === 0 ? undefined : parts.join("\n");
}

function treePrefix(rows: readonly GraphRow[], index: number): string {
	const row = rows[index];
	if (row === undefined || row.depth === 0) return "";
	let prefix = "";
	for (let depth = 1; depth < row.depth; depth++) {
		prefix += hasLaterSibling(rows, index, depth) ? "│  " : "   ";
	}
	return `${prefix}${hasLaterSibling(rows, index, row.depth) ? "├─" : "└─"}`;
}

function hasLaterSibling(rows: readonly GraphRow[], index: number, depth: number): boolean {
	for (let cursor = index + 1; cursor < rows.length; cursor++) {
		const candidate = rows[cursor];
		if (candidate === undefined) return false;
		if (candidate.depth < depth) return false;
		if (candidate.depth === depth) return true;
	}
	return false;
}

function statusGlyph(status: GraphRow["status"], live = true): string {
	if (!live && (status === "running" || status === "validating")) return "◌";
	switch (status) {
		case "running":
			return "●";
		case "validating":
			return "◆";
		case "rejected":
			return "↺";
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "final":
			return "★";
		case "pending":
			return "○";
	}
}

function formatGraphStatus(row: GraphRow, theme: Theme, live = true): string {
	const status = !live && (row.status === "running" || row.status === "validating") ? "stale" : row.status;
	const base = [
		status,
		row.sinceMs === undefined ? undefined : formatDuration(row.sinceMs),
		row.rejections === undefined ? undefined : `${row.rejections} reject${row.rejections === 1 ? "" : "s"}`,
		row.reason,
	]
		.filter((part): part is string => part !== undefined && part.length > 0)
		.join(" · ");
	return colorStatusText(theme, row.status, live, base);
}

function sessionFor(
	path: string,
	progress: Record<string, HyperchartSessionProgress>,
): HyperchartSessionProgress | undefined {
	return Object.values(progress).find((session) => session.actionUid.state === path);
}

function actionRows(view: RunView): GraphRow[] {
	return view.graph.filter((row) => row.kind === "state");
}

function activeRows(rows: readonly GraphRow[]): GraphRow[] {
	return rows.filter((row) => row.status === "running" || row.status === "validating" || row.status === "rejected");
}

function activeSessions(
	progress: Record<string, HyperchartSessionProgress>,
	live: boolean,
): HyperchartSessionProgress[] {
	return Object.values(progress)
		.filter((session) =>
			live ? session.status === "running" || session.status === "starting" : session.status !== "completed",
		)
		.sort((left, right) => sessionRank(left) - sessionRank(right));
}

function compactSessionLine(
	session: HyperchartSessionProgress,
	theme: Theme,
	includeFile = false,
	live = true,
): string {
	const activity = compactSessionActivity(session, live);
	const parts = [
		`${colorSessionGlyph(theme, session.status, live)} ${theme.bold(shortPath(session.actionUid.state))}`,
		dim(theme, shortAgentName(session.actionName)),
		shortModel(session.model) === undefined ? undefined : dim(theme, shortModel(session.model) ?? ""),
		activity === undefined ? undefined : accent(theme, activity),
		session.tokenCount !== undefined && session.tokenCount > 0
			? dim(theme, `${formatTokens(session.tokenCount)} tok`)
			: undefined,
		session.error === undefined ? undefined : error(theme, `err:${session.error}`),
		includeFile && session.sessionFile !== undefined ? dim(theme, basename(session.sessionFile)) : undefined,
	].filter((part): part is string => typeof part === "string" && part.length > 0);
	return joinParts(theme, parts);
}

function compactSessionActivity(session: HyperchartSessionProgress, live: boolean): string | undefined {
	if (!live && (session.status === "running" || session.status === "starting")) return "stale";
	if (session.currentTool !== undefined) return session.currentTool;
	if (session.status === "running") return "thinking";
	if (session.status === "starting") return "starting";
	if (session.status === "failed") return "failed";
	if (session.status === "cancelled") return undefined;
	return undefined;
}

function shortAction(row: GraphRow, session: HyperchartSessionProgress | undefined): string | undefined {
	if (row.kind !== "state") return undefined;
	if (session !== undefined) return shortAgentName(session.actionName);
	if (row.action === undefined) return undefined;
	if (row.action.startsWith("agent:")) return shortAgentName(row.action.slice("agent:".length));
	if (row.action.startsWith("script:"))
		return `script:${basename(row.action.slice("script:".length).split(/\s+/)[0] ?? "")}`;
	return row.action;
}

function shortPath(path: string): string {
	const parts = path.split(".");
	return parts.length <= 2 ? path : parts.slice(-2).join(".");
}

function shortAgentName(name: string): string {
	return name.replace(/^hyperchart-code-/, "");
}

function shortModel(model: string | undefined): string | undefined {
	if (model === undefined) return undefined;
	const parts = model.split("/");
	return parts.at(-1) ?? model;
}

function sessionStatusGlyph(status: HyperchartSessionProgress["status"], live = true): string {
	if (!live && (status === "running" || status === "starting")) return "◌";
	if (status === "completed") return "✓";
	if (status === "failed") return "✗";
	if (status === "cancelled") return "■";
	if (status === "starting") return "○";
	return "●";
}

function sessionRank(session: HyperchartSessionProgress): number {
	if (session.status === "running" || session.status === "starting") return 0;
	if (session.status === "failed") return 1;
	if (session.status === "cancelled") return 2;
	return 3;
}

function statKeyFor(path: string): string {
	if (!existsSync(path)) return "missing";
	const stat = statSync(path);
	return `${stat.size}:${stat.mtimeMs}`;
}

function box(lines: string[], width: number, theme: Theme): string[] {
	const innerWidth = Math.max(20, width - 4);
	const border = (value: string) => theme.fg("borderMuted", value);
	const top = border(`┌${"─".repeat(innerWidth + 2)}┐`);
	const bottom = border(`└${"─".repeat(innerWidth + 2)}┘`);
	return [
		top,
		...lines.map((line) => {
			const content = truncate(line, innerWidth);
			return `${border("│")} ${padVisible(content, innerWidth)} ${border("│")}`;
		}),
		bottom,
	];
}

function truncate(value: string, width: number): string {
	return truncateToWidth(value, Math.max(0, width), "…");
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

function clampScroll(scroll: number, contentLines: number): number {
	const terminalRows = process.stdout.rows ?? 40;
	const visibleContentLines = Math.max(1, terminalRows - 6);
	return Math.min(Math.max(0, scroll), Math.max(0, contentLines - visibleContentLines));
}

function padVisible(value: string, width: number): string {
	return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

function heading(theme: Theme, text: string): string {
	return theme.bold(accent(theme, text));
}

function joinParts(theme: Theme, parts: Array<string | undefined>): string {
	return parts.filter((part): part is string => part !== undefined && part.length > 0).join(dim(theme, " · "));
}

function colorStatusGlyph(theme: Theme, status: GraphRow["status"], live = true): string {
	return colorStatusText(theme, status, live, statusGlyph(status, live));
}

function colorSessionGlyph(theme: Theme, status: HyperchartSessionProgress["status"], live = true): string {
	if (!live && (status === "running" || status === "starting")) return dim(theme, sessionStatusGlyph(status, live));
	if (status === "completed") return success(theme, sessionStatusGlyph(status, live));
	if (status === "failed") return error(theme, sessionStatusGlyph(status, live));
	if (status === "cancelled") return warning(theme, sessionStatusGlyph(status, live));
	if (status === "starting") return accent(theme, sessionStatusGlyph(status, live));
	return accent(theme, sessionStatusGlyph(status, live));
}

function colorStatusText(theme: Theme, status: GraphRow["status"], live: boolean, text: string): string {
	if (!live && (status === "running" || status === "validating")) return dim(theme, text);
	switch (status) {
		case "running":
		case "validating":
			return accent(theme, text);
		case "rejected":
			return warning(theme, text);
		case "completed":
		case "final":
			return success(theme, text);
		case "failed":
			return error(theme, text);
		case "pending":
			return dim(theme, text);
	}
}

function formatSessionStatus(session: HyperchartSessionProgress, theme: Theme, live: boolean): string {
	const status = !live && (session.status === "running" || session.status === "starting") ? "stale" : session.status;
	if (!live && (session.status === "running" || session.status === "starting")) return dim(theme, status);
	if (session.status === "completed") return success(theme, status);
	if (session.status === "failed") return error(theme, status);
	if (session.status === "cancelled") return "";
	return accent(theme, status);
}

function colorRunState(theme: Theme, state: string): string {
	if (state === "DONE") return success(theme, state);
	if (state === "FAILED") return error(theme, state);
	if (state === "DETACHED") return warning(theme, state);
	return accent(theme, state);
}

function currentToolAge(session: HyperchartSessionProgress, theme: Theme): string | undefined {
	if (session.currentToolStartedAt === undefined) return undefined;
	return dim(theme, formatDuration(Math.max(0, Date.now() - session.currentToolStartedAt)));
}

function sessionDuration(session: HyperchartSessionProgress): number {
	return Math.max(0, (session.completedAt ?? Date.now()) - session.startedAt);
}

function toolArgsSummary(toolName: string, args: string | undefined, theme: Theme): string | undefined {
	const summary = summarizeToolArgs(toolName, args);
	return summary === undefined ? undefined : dim(theme, summary);
}

function summarizeToolArgs(toolName: string, args: string | undefined): string | undefined {
	if (args === undefined || args.trim().length === 0) return undefined;
	const parsed = parseJson(args);
	if (isRecord(parsed)) {
		const direct = summarizeKnownTool(toolName, parsed);
		if (direct !== undefined) return direct;
		for (const key of ["path", "file", "url", "query", "pattern", "command", "title", "task"] as const) {
			const value = parsed[key];
			if (typeof value === "string" && value.trim().length > 0) return `${key} ${oneLine(value)}`;
		}
		const pairs = Object.entries(parsed)
			.filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
			.slice(0, 2)
			.map(([key, value]) => `${key} ${oneLine(String(value))}`);
		if (pairs.length > 0) return pairs.join(" · ");
	}
	const compact = oneLine(args);
	return compact.length === 0 ? undefined : compact;
}

function summarizeKnownTool(toolName: string, args: Record<string, unknown>): string | undefined {
	switch (toolName) {
		case "read":
		case "show_image":
		case "show_file":
			return stringField(args, "path");
		case "write":
			return stringField(args, "path") ?? stringField(args, "file");
		case "edit":
			return labelWithPath("editing", stringField(args, "path"));
		case "grep":
			return joinPlain([stringField(args, "pattern"), stringField(args, "path"), stringField(args, "glob")]);
		case "find":
			return joinPlain([stringField(args, "pattern"), stringField(args, "path")]);
		case "bash":
			return stringField(args, "command");
		case "browser":
			return stringField(args, "command");
		case "web_search_brave":
		case "web_search_grok":
		case "web_search_codex":
			return stringField(args, "query");
		case "web_search": {
			const queries = args.queries;
			return Array.isArray(queries)
				? queries
						.filter((query) => typeof query === "string")
						.slice(0, 2)
						.join(" · ")
				: undefined;
		}
		case "ask_user":
			return stringField(args, "title") ?? stringField(args, "message");
		case "finish":
			return stringField(args, "event") ?? "submitting result";
		default:
			return undefined;
	}
}

function stringField(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.trim().length > 0 ? oneLine(value) : undefined;
}

function labelWithPath(label: string, path: string | undefined): string | undefined {
	return path === undefined ? undefined : `${label} ${path}`;
}

function joinPlain(parts: Array<string | undefined>): string | undefined {
	const filtered = parts.filter((part): part is string => part !== undefined && part.length > 0);
	return filtered.length === 0 ? undefined : filtered.join(" · ");
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function accent(theme: Theme, text: string): string {
	return theme.fg("accent", text);
}

function success(theme: Theme, text: string): string {
	return theme.fg("success", text);
}

function warning(theme: Theme, text: string): string {
	return theme.fg("warning", text);
}

function error(theme: Theme, text: string): string {
	return theme.fg("error", text);
}

function dim(theme: Theme, text: string): string {
	return theme.fg("dim", text);
}

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function formatChars(chars: number): string {
	if (chars < 1000) return `${chars} chars`;
	return `${(chars / 1000).toFixed(chars < 10_000 ? 1 : 0)}k chars`;
}
