import { useState } from "react";
import type { HyperchartMapVisitInfo, HyperchartOnReenterInfo } from "../../../types.js";
import { formatHyperchartDateTime } from "../../../hyperchart-display.js";
import { JsonBlock } from "../ui/JsonBlock.js";

export function MapVisitHistory({
	visits,
	onReenter,
}: {
	visits: HyperchartMapVisitInfo[];
	onReenter?: HyperchartOnReenterInfo;
}) {
	const [expandedVisits, setExpandedVisits] = useState<Record<number, boolean>>({});
	if (visits.length === 0) return null;
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-2">
				<div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Map visit history</div>
				{onReenter !== undefined && (
					<span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--hc-amber-text)]">
						on re-enter: {onReenter.mode}
					</span>
				)}
			</div>
			{onReenter?.messagePreview !== undefined && (
				<div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-2">
					<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--hc-amber-text)]">re-entry message</div>
					<div className="whitespace-pre-wrap break-words text-[11px] text-[var(--text-secondary)]">
						{onReenter.messagePreview}
					</div>
				</div>
			)}
			{visits.map((visit) => {
				const itemCount = Object.keys(visit.instances).length;
				const expanded = expandedVisits[visit.spawnSeqId] === true;
				return (
					<details
						key={visit.spawnSeqId}
						open={expanded}
						onToggle={(event) => {
							const open = event.currentTarget.open;
							setExpandedVisits((current) => current[visit.spawnSeqId] === open ? current : { ...current, [visit.spawnSeqId]: open });
						}}
						className="group rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-secondary)]"
					>
						<summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-2.5 py-2 text-[11px] marker:hidden">
							<span className="font-semibold text-[var(--text-primary)]">Visit {visit.visit}</span>
							{visit.visit > 1 && onReenter !== undefined && (
								<span className="rounded border border-amber-500/25 bg-amber-500/10 px-1 py-0.5 text-[10px] text-[var(--hc-amber-text)]">
									{onReenter.mode} re-entry
								</span>
							)}
							<span className="text-[var(--text-secondary)]">
								{itemCount} item{itemCount === 1 ? "" : "s"}
							</span>
							<span className="text-[var(--text-muted)]">{formatHyperchartDateTime(visit.startedAt)}</span>
							<span className="ml-auto text-[10px] text-[var(--text-muted)] group-open:hidden">show</span>
							<span className="ml-auto hidden text-[10px] text-[var(--text-muted)] group-open:inline">hide</span>
						</summary>
						{expanded && <div className="space-y-2 border-t border-[var(--border-primary)] px-2.5 py-2.5">
							<div className="text-[10px] text-[var(--text-muted)]">spawn seq {visit.spawnSeqId}</div>
							<JsonBlock value={visit.instances} previewLines={8} />
						</div>}
					</details>
				);
			})}
		</div>
	);
}
