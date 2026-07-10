import { ArrowsRightLeftIcon, MapIcon } from "@heroicons/react/24/outline";
import type { HyperchartStateInfo } from "../../../types.js";
import { fanoutStatusSummary, mapItemDotClass } from "../helpers/fanout.js";

export function FanoutStatusCard({ state, compact = false }: { state: HyperchartStateInfo; compact?: boolean }) {
	const summary = fanoutStatusSummary(state);
	if (!summary) return null;
	const isMap = summary.kind === "map";
	const Icon = isMap ? MapIcon : ArrowsRightLeftIcon;
	const colorClass = isMap ? "text-[var(--hc-cyan-text)]" : "text-[var(--hc-blue-text)]";
	const borderClass = isMap ? "border-cyan-500/25 bg-cyan-500/10" : "border-sky-500/25 bg-sky-500/10";
	const progressClass = isMap ? "bg-cyan-500/70" : "bg-blue-400/70";
	const total = summary.total;
	const hasKnownCount = total !== undefined && total > 0;
	const progressPct = hasKnownCount ? Math.round((summary.done / total) * 100) : 0;
	const limit = compact ? 4 : 8;
	const countLabel = hasKnownCount ? `${total} ${summary.label}` : summary.emptyLabel;
	const counts = [
		summary.running > 0 ? `${summary.running} running` : undefined,
		summary.pending > 0 ? `${summary.pending} pending` : undefined,
		summary.failed > 0 ? `${summary.failed} failed` : undefined,
		summary.stale > 0 ? `${summary.stale} stale` : undefined,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<div
			className={`${compact ? "mt-2 rounded-md px-2 py-1 text-[9px]" : "rounded-lg p-2 text-[11px]"} border ${borderClass} ${colorClass}`}
		>
			<div className="flex items-center justify-between gap-2">
				<span className="inline-flex min-w-0 items-center gap-1 font-semibold">
					<Icon className={`${compact ? "h-3 w-3" : "h-3.5 w-3.5"} shrink-0`} aria-hidden="true" />{" "}
					<span className="truncate">{countLabel}</span>
				</span>
				{hasKnownCount && (
					<span className="shrink-0 text-[var(--text-secondary)]">
						{summary.done}/{total}
					</span>
				)}
			</div>
			{hasKnownCount ? (
				<div
					className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]"
					title={`${summary.done}/${total} done`}
				>
					<div className={`h-full rounded-full ${progressClass}`} style={{ width: `${progressPct}%` }} />
				</div>
			) : (
				<div
					className={`mt-1 rounded border border-dashed ${isMap ? "border-cyan-500/25" : "border-sky-500/25"} bg-[var(--bg-secondary)]/70 px-2 py-1 text-[var(--text-secondary)]`}
				>
					{summary.emptyHint}
				</div>
			)}
			{summary.entries.length > 0 && (
				<div className="mt-1 flex min-w-0 items-center gap-1 overflow-hidden">
					{summary.entries.slice(0, limit).map((entry) => (
						<span
							key={entry.key}
							className={`inline-flex min-w-0 ${compact ? "max-w-[70px] text-[9px]" : "max-w-[120px] text-[10px]"} shrink items-center gap-1 rounded border ${isMap ? "border-cyan-500/25" : "border-sky-500/25"} bg-[var(--bg-secondary)] px-1.5 py-0.5 font-mono`}
							title={entry.title ?? entry.label}
						>
							{entry.status !== undefined && (
								<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${mapItemDotClass(entry.status)}`} />
							)}
							<span className="truncate">{entry.label}</span>
							{entry.issueCount !== undefined && entry.issueCount > 0 && (
								<span className="shrink-0 rounded bg-red-500/20 px-1 text-[8px] font-semibold text-[var(--hc-red-text)]">
									{entry.issueCount}
								</span>
							)}
						</span>
					))}
					{summary.entries.length > limit && (
						<span className="shrink-0 text-[var(--text-muted)]">+{summary.entries.length - limit}</span>
					)}
				</div>
			)}
			{counts && (
				<div className={`${compact ? "text-[8px]" : "text-[10px]"} mt-1 truncate text-[var(--text-secondary)]`}>
					{counts}
				</div>
			)}
		</div>
	);
}
