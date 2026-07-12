import { useMemo, useState } from "react";
import {
	ArrowPathIcon,
	CircleStackIcon,
	EllipsisHorizontalIcon,
	FolderIcon,
	PlayIcon,
	ArrowTopRightOnSquareIcon,
} from "@heroicons/react/24/outline";
import { StatusPill } from "./components/ui/StatusPill.js";
import { useHyperchartTheme } from "./support/theme-context.js";
import { MoreHyperchartsDialog } from "./components/run-strip/MoreHyperchartsDialog.js";
import { runSortTime } from "./components/run-strip/runSortTime.js";
import type { HyperchartInfo, HyperchartRunInfo } from "./types.js";
import {
	formatHyperchartTime,
	formatHyperchartUsage,
	runningHyperchartStates,
	summarizeHyperchartProgress,
	hyperchartChartName,
	hyperchartRunLabel,
} from "./hyperchart-display.js";

export interface HyperchartRunStripProps {
	hypercharts: HyperchartInfo[];
	runs: HyperchartRunInfo[];
	selectedRunId?: string | null;
	onSelectRun?: (runId: string | null) => void;
	onRun?: (chartName: string) => void;
	onOpenDefinition?: (flow: HyperchartInfo) => void;
	onResume?: (runId: string) => void;
	onAbort?: () => void;
	onOpenInspector?: (runId?: string | null) => void;
}

const RUN_STRIP_VISIBLE_RUNS = 5;

export function HyperchartRunStrip({
	hypercharts,
	runs,
	selectedRunId,
	onSelectRun,
	onRun,
	onOpenDefinition,
	onResume,
	onAbort,
	onOpenInspector,
}: HyperchartRunStripProps) {
	const { resolved } = useHyperchartTheme();
	const [moreOpen, setMoreOpen] = useState(false);
	const sortedRuns = useMemo(
		() =>
			runs
				.map((candidate, index) => ({ candidate, index }))
				.sort((left, right) => {
					const byTime = runSortTime(right.candidate) - runSortTime(left.candidate);
					return byTime !== 0 ? byTime : left.index - right.index;
				})
				.map(({ candidate }) => candidate),
		[runs],
	);
	const visibleRuns = sortedRuns.slice(0, RUN_STRIP_VISIBLE_RUNS);
	const moreRuns = sortedRuns.slice(RUN_STRIP_VISIBLE_RUNS);
	const moreCount = moreRuns.length;
	const hasChartActions = hypercharts.length > 0;
	const canOpenMore = moreCount > 0 || hasChartActions;
	const run = useMemo(() => {
		if (selectedRunId) return runs.find((candidate) => candidate.runId === selectedRunId) ?? sortedRuns[0];
		return runs.find((candidate) => candidate.status === "running") ?? sortedRuns[0];
	}, [runs, selectedRunId, sortedRuns]);

	if (!run) return null;

	const progress = summarizeHyperchartProgress(run);
	const running = runningHyperchartStates(run);
	const usage = formatHyperchartUsage(run.totalUsage);
	const selectRun = (runId: string) => {
		onSelectRun?.(runId);
		onOpenInspector?.(runId);
		setMoreOpen(false);
	};

	return (
		<div
			data-hyperchart-root
			data-theme={resolved}
			className="border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] backdrop-blur"
		>
			<div className="px-3 py-2 space-y-2">
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={() => run && onOpenInspector?.(run.runId)}
						className="min-w-0 flex-1 text-left group"
					>
						<div className="flex items-center gap-2 min-w-0">
							<FolderIcon className="h-4 w-4 shrink-0 text-[var(--hc-blue-text)]" aria-hidden="true" />
							<span className="text-xs font-semibold text-[var(--text-primary)]">Hyperchart</span>
							{run && <StatusPill status={run.status} />}
							{run && (
								<span className="font-mono text-xs text-[var(--text-secondary)] truncate">
									{hyperchartChartName(run)}
								</span>
							)}

							{usage && (
								<span className="hidden sm:inline-flex items-center gap-1 text-[10px] text-[var(--text-tertiary)] shrink-0">
									<CircleStackIcon className="h-3 w-3" aria-hidden="true" /> {usage}
								</span>
							)}
						</div>
						{run && (
							<div className="mt-1 h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
								<div
									className="h-full bg-[var(--accent-blue)] rounded-full transition-all"
									style={{ width: `${progress.pct}%` }}
								/>
							</div>
						)}
					</button>
					{run?.status === "running" && onAbort && (
						<button
							type="button"
							onClick={onAbort}
							className="px-2 py-1 text-[10px] rounded border border-red-500/30 text-[var(--hc-red-text)] hover:bg-red-500/10"
						>
							Abort
						</button>
					)}
					{run && (run.status === "failed" || run.status === "paused" || run.status === "blocked") && onResume && (
						<button
							type="button"
							onClick={() => onResume(run.runId)}
							className="px-2 py-1 text-[10px] rounded border border-green-500/30 text-[var(--hc-green-text)] hover:bg-green-500/10"
						>
							Resume
						</button>
					)}
					{run && (
						<button
							type="button"
							onClick={() => onOpenInspector?.(run.runId)}
							className="inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-blue-500/30 text-[var(--hc-blue-text)] hover:bg-blue-500/10"
							title="Open realtime hyperchart graph"
						>
							<ArrowTopRightOnSquareIcon className="h-3 w-3" aria-hidden="true" /> Graph
						</button>
					)}
				</div>

				{run && (
					<div className="flex flex-wrap items-center gap-2 text-[10px] text-[var(--text-tertiary)]">
						{running.length > 0 ? (
							<span className="inline-flex items-center gap-1 text-[var(--hc-blue-text)]">
								<ArrowPathIcon className="h-3 w-3 animate-spin" aria-hidden="true" /> running:{" "}
								{running
									.slice(0, 3)
									.map((state) => state.id)
									.join(", ")}
								{running.length > 3 ? ` +${running.length - 3}` : ""}
							</span>
						) : (
							<span>last update: {formatHyperchartTime(run.updatedAt)}</span>
						)}
						<span>
							run: <span className="font-mono">{run.runId}</span>
						</span>
					</div>
				)}

				{(runs.length > 1 || hypercharts.length > 0) && (
					<div className="relative flex min-w-0 items-center gap-1 pb-1">
						<div className="flex min-w-0 flex-1 gap-1 overflow-hidden">
							{visibleRuns.map((candidate) => (
								<button
									type="button"
									key={candidate.runId}
									onClick={() => selectRun(candidate.runId)}
									className={`min-w-0 max-w-[180px] shrink truncate px-2 py-1 rounded border text-[10px] ${candidate.runId === run?.runId ? "border-blue-500/60 text-[var(--hc-blue-text)] bg-blue-500/10" : "border-[var(--border-secondary)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"}`}
									title={candidate.runId}
								>
									{hyperchartRunLabel(candidate)}
								</button>
							))}
						</div>

						{canOpenMore && (
							<button
								type="button"
								onClick={() => setMoreOpen((value) => !value)}
								className={`inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-[10px] ${moreOpen ? "border-blue-500/60 bg-blue-500/10 text-[var(--hc-blue-text)]" : "border-[var(--border-secondary)] text-[var(--text-secondary)] hover:border-blue-500/40 hover:text-[var(--hc-blue-text)]"}`}
								aria-expanded={moreOpen}
								title={moreCount > 0 ? "Show older runs and chart actions" : "Run a hyperchart"}
							>
								{moreCount > 0 ? (
									<>
										<EllipsisHorizontalIcon className="h-3 w-3" aria-hidden="true" /> More ({moreCount})
									</>
								) : (
									<>
										<PlayIcon className="h-3 w-3" aria-hidden="true" /> Run…
									</>
								)}
							</button>
						)}

						{moreOpen && canOpenMore && (
							<MoreHyperchartsDialog
								hypercharts={hypercharts}
								runs={moreRuns}
								{...(run === undefined ? {} : { selectedRunId: run.runId })}
								onSelectRun={selectRun}
								{...(onRun === undefined ? {} : { onRun })}
								{...(onOpenDefinition === undefined ? {} : { onOpenDefinition })}
								onClose={() => setMoreOpen(false)}
							/>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
