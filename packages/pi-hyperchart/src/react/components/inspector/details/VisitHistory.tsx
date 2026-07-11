import type { HyperchartVisitInfo } from "../../../types.js";
import { formatHyperchartDateTime } from "../../../hyperchart-display.js";
import { StatusPill } from "../../ui/StatusPill.js";
import { JsonBlock } from "../ui/JsonBlock.js";
import { VisitInvocationDetails } from "./VisitInvocationDetails.js";

export function VisitHistory({ visits }: { visits: HyperchartVisitInfo[] }) {
	if (visits.length === 0) return null;
	return (
		<div className="space-y-2">
			<div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Visit history</div>
			{visits.map((visit, index) => (
				<details
					key={visit.invokeSeqId}
					open={index === visits.length - 1}
					className="group rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-secondary)]"
				>
					<summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-2.5 py-2 text-[11px] marker:hidden">
						<span className="font-semibold text-[var(--text-primary)]">Visit {visit.visit}</span>
						<StatusPill status={visit.status} />
						<span className="text-[var(--text-muted)]">{formatHyperchartDateTime(visit.startedAt)}</span>
						{visit.completedEvent !== undefined && (
							<code className="rounded bg-[var(--bg-code)] px-1 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">
								{visit.completedEvent}
							</code>
						)}
						<span className="ml-auto text-[10px] text-[var(--text-muted)] group-open:hidden">show</span>
						<span className="ml-auto hidden text-[10px] text-[var(--text-muted)] group-open:inline">hide</span>
					</summary>
					<div className="space-y-3 border-t border-[var(--border-primary)] px-2.5 py-2.5">
						{visit.endedAt !== undefined && (
							<div className="text-[10px] text-[var(--text-muted)]">
								ended {formatHyperchartDateTime(visit.endedAt)}
							</div>
						)}
						{visit.endedReason !== undefined && (
							<div className="text-[10px] text-[var(--text-muted)]">
								ended because{" "}
								{visit.endedReason === "timed_out" ? "the deadline fired" : "another transition exited the scope"}
							</div>
						)}
						{visit.validationAttempts !== undefined && (
							<div className="text-[10px] text-[var(--text-muted)]">
								validation attempts: {visit.validationAttempts}
							</div>
						)}
						{visit.inputs !== undefined && (
							<div>
								<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">resolved inputs</div>
								<JsonBlock value={visit.inputs} previewLines={9} />
							</div>
						)}
						{visit.mapItem !== undefined && (
							<div>
								<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
									map item · {visit.mapItem.key}
								</div>
								<JsonBlock value={visit.mapItem.value} previewLines={9} />
							</div>
						)}
						<VisitInvocationDetails invocation={visit.invocation} />
					</div>
				</details>
			))}
		</div>
	);
}
