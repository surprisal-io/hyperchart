import { useState } from "react";
import { CommandLineIcon } from "@heroicons/react/24/outline";
import type { HyperchartStateInfo, HyperchartVisitInfo } from "../../../types.js";
import { formatHyperchartDateTime } from "../../../hyperchart-display.js";
import { StatusPill } from "../../ui/StatusPill.js";
import { JsonBlock } from "../ui/JsonBlock.js";
import { schemaTypeText } from "../helpers/schema.js";
import { AgentSessionDialog } from "./AgentSessionDialog.js";
import { ArtifactRow } from "./ArtifactRow.js";
import { VisitInvocationDetails } from "./VisitInvocationDetails.js";

export function VisitHistory({
	visits,
	state,
	allStates,
	agentName,
	onSteerSession,
	onHighlightArtifact,
	onReadSession,
	lazyDetails = false,
}: {
	visits: HyperchartVisitInfo[];
	state: HyperchartStateInfo;
	allStates: HyperchartStateInfo[];
	agentName?: string;
	onSteerSession?: (actionKey: string, message: string) => void | Promise<void>;
	onHighlightArtifact?: (stateId: string, artifactName: string) => void;
	onReadSession?: (invokeSeqId: number) => Promise<HyperchartVisitInfo["session"]>;
	lazyDetails?: boolean;
}) {
	const [openSessionIdentity, setOpenSessionIdentity] = useState<string>();
	const [expandedVisits, setExpandedVisits] = useState<Record<number, boolean>>({});
	const [loadedSessions, setLoadedSessions] = useState<Record<number, NonNullable<HyperchartVisitInfo["session"]>>>({});
	const [sessionReads, setSessionReads] = useState<Record<number, { loading: boolean; error?: string }>>({});
	const openVisitSession = (visit: HyperchartVisitInfo) => {
		const identity = visitSessionIdentity(visit);
		if (onReadSession === undefined || loadedSessions[visit.invokeSeqId] !== undefined) {
			setOpenSessionIdentity(identity);
			return;
		}
		setSessionReads((current) => ({ ...current, [visit.invokeSeqId]: { loading: true } }));
		void onReadSession(visit.invokeSeqId).then((session) => {
			if (session === undefined) {
				setSessionReads((current) => ({ ...current, [visit.invokeSeqId]: { loading: false, error: "Transcript is unavailable." } }));
				return;
			}
			setLoadedSessions((current) => ({ ...current, [visit.invokeSeqId]: session }));
			setSessionReads((current) => ({ ...current, [visit.invokeSeqId]: { loading: false } }));
			setOpenSessionIdentity(identity);
		}, (error: unknown) => {
			setSessionReads((current) => ({ ...current, [visit.invokeSeqId]: { loading: false, error: error instanceof Error ? error.message : String(error) } }));
		});
	};
	if (visits.length === 0) return null;
	const openVisit = visits.find((visit) => visitSessionIdentity(visit) === openSessionIdentity);
	const openSession = openVisit === undefined ? undefined : loadedSessions[openVisit.invokeSeqId] ?? openVisit.session;
	return (
		<>
			<div className="space-y-2">
				<div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Visit history</div>
				{visits.map((visit, index) => {
					const sessionRead = sessionReads[visit.invokeSeqId];
					const canReadSession = visit.session !== undefined || onReadSession !== undefined && visit.invocation.kind === "agent";
					const expanded = expandedVisits[visit.invokeSeqId] ?? (index === visits.length - 1 && visit.status === "running");
					return <details
						key={visit.invokeSeqId}
						open={expanded}
						onToggle={(event) => {
							const open = event.currentTarget.open;
							setExpandedVisits((current) => current[visit.invokeSeqId] === open ? current : { ...current, [visit.invokeSeqId]: open });
						}}
						className="group rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-secondary)]"
					>
						<summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-2.5 py-2 text-[11px] marker:hidden">
							<span className="font-semibold text-[var(--text-primary)]">Visit {visit.visit}</span>
							<StatusPill status={visit.status} />
							<span className="text-[var(--text-muted)]">{formatHyperchartDateTime(visit.startedAt)}</span>
							{canReadSession && (
								<button
									type="button"
									aria-label={`View session for visit ${visit.visit}`}
									disabled={sessionRead?.loading === true || sessionRead?.error !== undefined}
									onClick={(event) => {
										event.preventDefault();
										event.stopPropagation();
										openVisitSession(visit);
									}}
									className="ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-cyan-500/35 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--hc-cyan-text)] hover:bg-cyan-500/15"
								>
									<span className={`h-1.5 w-1.5 rounded-full ${visit.session !== undefined && isLiveSession(visit.session.status) ? "animate-pulse bg-emerald-400" : "bg-[var(--text-muted)]"}`} />
									<CommandLineIcon className="h-3 w-3" aria-hidden="true" /> View session
								</button>
							)}
							{sessionRead?.loading === true && <span role="status" className="text-[10px] text-[var(--text-muted)]">Loading transcript…</span>}
							{sessionRead?.error !== undefined && (
								<span className="inline-flex items-center gap-1 text-[10px] text-[var(--danger)]">
									Transcript load failed: {sessionRead.error}
									<button type="button" className="text-[var(--hc-cyan-text)]" onClick={(event) => { event.preventDefault(); event.stopPropagation(); openVisitSession(visit); }}>Retry</button>
								</span>
							)}
							<span className="basis-full text-right text-[10px] text-[var(--text-muted)] group-open:hidden">show</span>
							<span className="hidden basis-full text-right text-[10px] text-[var(--text-muted)] group-open:inline">hide</span>
						</summary>
						{(!lazyDetails || expanded) && <div className="space-y-3 border-t border-[var(--border-primary)] px-2.5 py-2.5">
							{visit.completedEvent !== undefined && (
								<div className="text-[10px] text-[var(--text-muted)]">
									completed event <code className="ml-1 rounded bg-[var(--bg-code)] px-1 py-0.5 font-mono text-[var(--text-secondary)]">{visit.completedEvent}</code>
								</div>
							)}
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
							{visit.artifactPins !== undefined && visit.artifactPins.length > 0 && (
								<div>
									<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">pinned deliverables</div>
									<div className="grid gap-1.5">
										{visit.artifactPins.map((pin) => {
											const artifact = state.artifacts?.find((candidate) => candidate.path === pin.path);
											const typeName = (artifact?.name ?? "artifact").split(/[^A-Za-z0-9_$]+/).filter(Boolean).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("") || "Artifact";
											return (
												<ArtifactRow
													key={pin.path}
													kind="pin"
													label={pin.path}
													detail={`sha256:${pin.hash.slice(0, 12)} · ${formatPinSize(pin.size)}`}
													{...(artifact?.schema === undefined ? {} : { typeText: `type ${typeName} = ${schemaTypeText(artifact.schema)};` })}
													{...(artifact !== undefined && onHighlightArtifact !== undefined ? { onClick: () => onHighlightArtifact(state.id, artifact.name) } : {})}
												/>
											);
										})}
									</div>
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
							<VisitInvocationDetails invocation={visit.invocation} state={state} allStates={allStates} {...(onHighlightArtifact === undefined ? {} : { onHighlightArtifact })} />
						</div>}
					</details>;
				})}
			</div>
			{openVisit !== undefined && openSession !== undefined && (
				<AgentSessionDialog
					key={`visit-session-dialog:${visitSessionIdentity(openVisit)}`}
					agentName={agentName ?? openSession.actionKey}
					session={openSession}
					onClose={() => setOpenSessionIdentity(undefined)}
					{...(onSteerSession === undefined
						? {}
						: { onSteer: (message: string) => onSteerSession(openSession.actionKey, message) })}
				/>
			)}
		</>
	);
}

function visitSessionIdentity(visit: HyperchartVisitInfo): string {
	return String(visit.invokeSeqId);
}

function isLiveSession(status: string): boolean {
	return status === "running" || status === "starting";
}

function formatPinSize(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
