import { useState } from "react";
import { CommandLineIcon } from "@heroicons/react/24/outline";
import type { HyperchartVisitInfo } from "../../../types.js";
import { formatHyperchartDateTime } from "../../../hyperchart-display.js";
import { StatusPill } from "../../ui/StatusPill.js";
import { JsonBlock } from "../ui/JsonBlock.js";
import { AgentSessionDialog } from "./AgentSessionDialog.js";
import { VisitInvocationDetails } from "./VisitInvocationDetails.js";

export function VisitHistory({
	visits,
	agentName,
	onSteerSession,
}: {
	visits: HyperchartVisitInfo[];
	agentName?: string;
	onSteerSession?: (actionKey: string, message: string) => void | Promise<void>;
}) {
	const [openSessionIdentity, setOpenSessionIdentity] = useState<string>();
	if (visits.length === 0) return null;
	const openVisit = visits.find((visit) => visitSessionIdentity(visit) === openSessionIdentity);
	return (
		<>
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
							{visit.session !== undefined && (
								<button
									type="button"
									aria-label={`View session for visit ${visit.visit}`}
									onClick={(event) => {
										event.preventDefault();
										event.stopPropagation();
										setOpenSessionIdentity(visitSessionIdentity(visit));
									}}
									className="ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-cyan-500/35 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--hc-cyan-text)] hover:bg-cyan-500/15"
								>
									<span className={`h-1.5 w-1.5 rounded-full ${isLiveSession(visit.session.status) ? "animate-pulse bg-emerald-400" : "bg-[var(--text-muted)]"}`} />
									<CommandLineIcon className="h-3 w-3" aria-hidden="true" /> View session
								</button>
							)}
							<span className={`${visit.session === undefined ? "ml-auto " : ""}text-[10px] text-[var(--text-muted)] group-open:hidden`}>show</span>
							<span className={`${visit.session === undefined ? "ml-auto " : ""}hidden text-[10px] text-[var(--text-muted)] group-open:inline`}>hide</span>
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
			{openVisit?.session !== undefined && (
				<AgentSessionDialog
					key={`visit-session-dialog:${visitSessionIdentity(openVisit)}`}
					agentName={agentName ?? openVisit.session.actionKey}
					session={openVisit.session}
					onClose={() => setOpenSessionIdentity(undefined)}
					{...(onSteerSession === undefined
						? {}
						: { onSteer: (message: string) => onSteerSession(openVisit.session!.actionKey, message) })}
				/>
			)}
		</>
	);
}

function visitSessionIdentity(visit: HyperchartVisitInfo): string | undefined {
	if (visit.session === undefined) return undefined;
	return `${visit.invokeSeqId}:${visit.session.actionKey}:${visit.session.startedAt ?? "unknown"}`;
}

function isLiveSession(status: string): boolean {
	return status === "running" || status === "starting";
}
