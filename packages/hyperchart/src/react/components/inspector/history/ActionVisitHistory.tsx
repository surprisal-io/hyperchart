import { useEffect, useMemo, useRef } from "react";
import {
	ChatBubbleLeftRightIcon,
	CodeBracketSquareIcon,
	CommandLineIcon,
	UserCircleIcon,
} from "@heroicons/react/24/outline";
import type { HyperchartInspectorDataSource, HyperchartRunInfo, HyperchartVisitInfo } from "../../../types.js";
import { formatHyperchartDateTime } from "../../../hyperchart-display.js";
import { actionStateContexts, actionVisitStatusLabel, type ActionVisitRow } from "../helpers/actionVisits.js";
import type { HeroIcon } from "../types.js";
import { useActionVisitHistory } from "./useActionVisitHistory.js";

export function ActionVisitHistory({
	run,
	dataSource,
	selectedInvokeSeqId,
	onSelectVisit,
	mobile = false,
}: {
	run: HyperchartRunInfo;
	dataSource?: HyperchartInspectorDataSource;
	selectedInvokeSeqId?: number;
	onSelectVisit: (row: ActionVisitRow) => void;
	mobile?: boolean;
}) {
	const history = useActionVisitHistory(run, dataSource);
	const context = useMemo(() => actionStateContexts(run.states), [run.states]);
	const listRef = useRef<HTMLDivElement>(null);
	const initialScroll = useRef<string | undefined>(undefined);
	const snapshotKey = `${run.runId}:${history.snapshot.branchId}:${history.snapshot.headSeqId ?? "root"}`;
	useEffect(() => {
		if (history.rows.length === 0 || initialScroll.current === snapshotKey) return;
		initialScroll.current = snapshotKey;
		listRef.current?.scrollTo?.({ top: listRef.current.scrollHeight });
	}, [history.rows.length, snapshotKey]);

	const content = (
		<div className="flex min-h-0 flex-1 flex-col gap-2">
			<div className="sr-only" role="status" aria-live="polite">
				{history.loading
					? "Loading action visits"
					: history.initialError === undefined
						? `${history.rows.length} action visits loaded`
						: "Action visit history failed to load"}
			</div>
			<div className="flex items-center justify-between gap-2 text-[9px] text-[var(--text-muted)]">
				<span className="truncate" title={history.snapshot.branchId}>
					{history.snapshot.branchId} · snapshot #{history.snapshot.headSeqId ?? "empty"}
				</span>
				<span className="shrink-0">Latest window</span>
			</div>
			<details className="mx-auto w-full max-w-2xl rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-1">
				<summary
					className={`cursor-pointer font-semibold text-[var(--text-secondary)] ${mobile ? "flex min-h-11 items-center text-xs" : "text-[9px]"}`}
				>
					State context—not visit history
				</summary>
				<div className="mt-1 max-h-24 space-y-1 overflow-y-auto pr-1">
					{context.length === 0 ? (
						<div className="text-[9px] text-[var(--text-muted)]">
							No active, waiting, pending, skipped, or unvisited action states.
						</div>
					) : (
						context.map((item) => (
							<div key={item.stateId} className="flex items-start justify-between gap-2 text-[9px]">
								<code className="min-w-0 truncate text-[var(--text-secondary)]" title={item.stateId}>
									{item.stateId}
								</code>
								<span className="shrink-0 text-right text-[var(--text-muted)]">{item.label}</span>
							</div>
						))
					)}
				</div>
			</details>
			<p className="text-center text-[10px] leading-tight text-[var(--text-muted)]">
				Every cycle is unfolded · arrows show durable action-start order, not dependency.
			</p>
			{history.hasOlder && (
				<button
					type="button"
					className={`justify-self-center rounded px-3 text-[var(--hc-cyan-text)] disabled:text-[var(--text-muted)] ${mobile ? "min-h-11 text-xs" : "text-[9px]"}`}
					disabled={history.older.loading}
					onClick={() => void history.loadOlder()}
				>
					{history.older.loading ? "Loading older…" : "Older"}
				</button>
			)}
			{history.older.error !== undefined && (
				<HistoryFailure label="Older visits failed" error={history.older.error} onRetry={history.loadOlder} />
			)}
			<div
				ref={listRef}
				className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2"
				data-testid="action-visit-history-list"
			>
				{history.initialError !== undefined ? (
					<HistoryFailure
						label="Visit history unavailable"
						error={history.initialError}
						onRetry={history.retryInitial}
					/>
				) : history.rows.length === 0 ? (
					<div className="rounded border border-dashed border-[var(--border-secondary)] p-2 text-[9px] text-[var(--text-muted)]">
						{history.loading
							? "Loading action visits…"
							: history.historyAvailable
								? "No action visits in this loaded record range."
								: "Visit history unavailable for this overview."}
					</div>
				) : (
					<div className="mx-auto w-full max-w-2xl">
						{history.rows.map((row, index) => (
							<div key={row.invokeSeqId} className="relative pb-8 last:pb-0">
								{index < history.rows.length - 1 && (
									<div
										aria-hidden="true"
										className="absolute left-1/2 top-full z-0 h-8 -translate-x-1/2 -translate-y-8"
									>
										<div className="h-6 w-px bg-[var(--border-primary)]" />
										<div className="-ml-[3px] h-0 w-0 border-x-4 border-t-[6px] border-x-transparent border-t-[var(--border-primary)]" />
									</div>
								)}
								<ActionVisitHistoryRow
									row={row}
									selected={row.invokeSeqId === selectedInvokeSeqId}
									onSelect={onSelectVisit}
								/>
							</div>
						))}
					</div>
				)}
			</div>
			{history.hasNewer && (
				<button
					type="button"
					className={`justify-self-center rounded px-3 text-[var(--hc-cyan-text)] disabled:text-[var(--text-muted)] ${mobile ? "min-h-11 text-xs" : "text-[9px]"}`}
					disabled={history.newer.loading}
					onClick={() => void history.loadNewer()}
				>
					{history.newer.loading ? "Loading newer…" : "Newer"}
				</button>
			)}
			{history.newer.error !== undefined && (
				<HistoryFailure label="Newer visits failed" error={history.newer.error} onRetry={history.loadNewer} />
			)}
		</div>
	);

	return (
		<section className="flex min-h-0 flex-1 flex-col bg-[var(--bg-primary)] p-3" aria-label="Action visit history">
			<div className="mb-1 text-center">
				<h2 className="text-sm font-semibold text-[var(--text-primary)]">Execution path</h2>
				<p className="text-[10px] text-[var(--text-muted)]">Action visit history</p>
			</div>
			{content}
		</section>
	);
}

function ActionVisitHistoryRow({
	row,
	selected,
	onSelect,
}: {
	row: ActionVisitRow;
	selected: boolean;
	onSelect: (row: ActionVisitRow) => void;
}) {
	const visit = row.visit;
	const Icon = visit === undefined ? CommandLineIcon : invocationIcon(visit);
	return (
		<button
			type="button"
			aria-pressed={selected}
			aria-label={`${row.statePath}, ${visit === undefined ? "visit details unavailable" : `Visit ${visit.visit}, ${actionVisitStatusLabel(visit)}`}`}
			onClick={() => onSelect(row)}
			className={`relative z-10 w-full rounded-xl border px-4 py-3 text-left shadow-sm transition-[border-color,background-color,transform] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${selected ? "scale-[1.01] border-blue-500/70 bg-blue-500/10 shadow-md" : "border-[var(--border-secondary)] bg-[var(--bg-secondary)] hover:-translate-y-px hover:border-[var(--text-muted)] hover:bg-[var(--bg-hover)]"}`}
		>
			<div className="flex min-w-0 items-center gap-2 text-xs">
				<span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-[var(--border-secondary)] bg-[var(--bg-primary)]">
					<Icon className="h-4 w-4 text-[var(--text-muted)]" aria-hidden="true" />
				</span>
				<code className="min-w-0 flex-1 truncate font-semibold text-[var(--text-primary)]" title={row.statePath}>
					{row.statePath}
				</code>
				<span className="shrink-0 font-mono text-[10px] text-[var(--text-muted)]">#{row.invokeSeqId}</span>
				{visit !== undefined && (
					<span className="shrink-0 rounded-full bg-[var(--bg-primary)] px-2 py-1 text-[10px] text-[var(--text-secondary)]">
						cycle {visit.visit}
					</span>
				)}
			</div>
			<div className="mt-2 flex min-w-0 items-center gap-1.5 pl-9 text-[10px] text-[var(--text-muted)]">
				<span
					className={
						visit?.status === "failed"
							? "text-[var(--danger)]"
							: visit?.status === "running"
								? "text-[var(--hc-cyan-text)]"
								: ""
					}
				>
					{visit === undefined
						? row.error === undefined
							? "Loading details…"
							: "Visit history unavailable"
						: actionVisitStatusLabel(visit)}
				</span>
				{visit !== undefined && (
					<>
						<span>·</span>
						<span>{formatHyperchartDateTime(visit.startedAt)}</span>
						{formatDuration(visit) !== undefined && (
							<>
								<span>·</span>
								<span>{formatDuration(visit)}</span>
							</>
						)}
					</>
				)}
			</div>
			{row.graphStateId === undefined && (
				<div className="mt-1 text-[9px] text-[var(--text-muted)]">Not represented in current graph.</div>
			)}
			{row.error !== undefined && (
				<div className="mt-1 truncate text-[9px] text-[var(--danger)]" title={row.error}>
					{row.error}
				</div>
			)}
		</button>
	);
}

function invocationIcon(visit: HyperchartVisitInfo): HeroIcon {
	switch (visit.invocation.kind) {
		case "agent":
			return UserCircleIcon;
		case "script":
			return CommandLineIcon;
		case "tsImport":
			return CodeBracketSquareIcon;
		case "user":
			return ChatBubbleLeftRightIcon;
		case "actor":
			return CommandLineIcon;
	}
}

function formatDuration(visit: HyperchartVisitInfo): string | undefined {
	if (visit.endedAt === undefined) return undefined;
	const milliseconds = Math.max(0, visit.endedAt - visit.startedAt);
	if (milliseconds < 1_000) return `${milliseconds}ms`;
	const seconds = Math.round(milliseconds / 1_000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function HistoryFailure({
	label,
	error,
	onRetry,
}: {
	label: string;
	error: string;
	onRetry: () => void | Promise<void>;
}) {
	return (
		<div className="rounded border border-red-500/30 bg-red-500/5 p-2 text-[9px] text-[var(--danger)]">
			<div>
				{label}: {error}
			</div>
			<button
				type="button"
				className="mt-1 min-h-11 rounded px-3 text-[var(--hc-cyan-text)] md:min-h-0 md:px-0"
				onClick={() => void onRetry()}
			>
				Retry
			</button>
		</div>
	);
}
