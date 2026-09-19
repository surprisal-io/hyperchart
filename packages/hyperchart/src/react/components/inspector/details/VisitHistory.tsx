import { useEffect, useRef, useState } from "react";
import { ChevronRightIcon, CommandLineIcon } from "@heroicons/react/24/outline";
import type { HyperchartStateInfo, HyperchartVisitInfo } from "../../../types.js";
import { formatHyperchartDateTime, hyperchartStatusClasses } from "../../../hyperchart-display.js";
import { StatusPill } from "../../ui/StatusPill.js";
import { ExpandablePre } from "../ui/ExpandablePre.js";
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
	selectedInvokeSeqId,
	currentBranchId = "main",
}: {
	visits: HyperchartVisitInfo[];
	state: HyperchartStateInfo;
	allStates: HyperchartStateInfo[];
	agentName?: string;
	onSteerSession?: (actionKey: string, message: string) => void | Promise<void>;
	onHighlightArtifact?: (stateId: string, artifactName: string) => void;
	onReadSession?: (invokeSeqId: number, originBranchId?: string) => Promise<HyperchartVisitInfo["session"]>;
	lazyDetails?: boolean;
	selectedInvokeSeqId?: number;
	currentBranchId?: string;
}) {
	const [openSessionIdentity, setOpenSessionIdentity] = useState<string>();
	const [expandedVisits, setExpandedVisits] = useState<Record<number, boolean>>({});
	const [loadedSessions, setLoadedSessions] = useState<Record<number, NonNullable<HyperchartVisitInfo["session"]>>>({});
	const [sessionReads, setSessionReads] = useState<Record<number, { loading: boolean; error?: string }>>({});
	const readerRef = useRef(onReadSession);
	readerRef.current = onReadSession;
	useEffect(() => {
		void onReadSession;
		setOpenSessionIdentity(undefined);
		setLoadedSessions({});
		setSessionReads({});
	}, [onReadSession]);
	const openVisitSession = (visit: HyperchartVisitInfo) => {
		const identity = visitSessionIdentity(visit);
		if (onReadSession === undefined || loadedSessions[visit.invokeSeqId] !== undefined) {
			setOpenSessionIdentity(identity);
			return;
		}
		setSessionReads((current) => ({ ...current, [visit.invokeSeqId]: { loading: true } }));
		const reader = onReadSession;
		void reader(visit.invokeSeqId, visit.originBranchId).then(
			(session) => {
				if (readerRef.current !== reader) {
					return;
				}
				if (session === undefined) {
					setSessionReads((current) => ({
						...current,
						[visit.invokeSeqId]: { loading: false, error: "Transcript is unavailable." },
					}));
					return;
				}
				setLoadedSessions((current) => ({ ...current, [visit.invokeSeqId]: session }));
				setSessionReads((current) => ({ ...current, [visit.invokeSeqId]: { loading: false } }));
				setOpenSessionIdentity(identity);
			},
			(error: unknown) => {
				if (readerRef.current !== reader) {
					return;
				}
				setSessionReads((current) => ({
					...current,
					[visit.invokeSeqId]: { loading: false, error: error instanceof Error ? error.message : String(error) },
				}));
			},
		);
	};
	if (visits.length === 0) {
		return null;
	}
	const openVisit = visits.find((visit) => visitSessionIdentity(visit) === openSessionIdentity);
	const openSession =
		openVisit === undefined ? undefined : (loadedSessions[openVisit.invokeSeqId] ?? openVisit.session);
	return (
		<>
			<div className="space-y-2">
				<div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Visit history</div>
				{visits.map((visit, index) => {
					const sessionRead = sessionReads[visit.invokeSeqId];
					const canReadSession =
						visit.invocation.kind === "agent" && (visit.session !== undefined || onReadSession !== undefined);
					const selected = visit.invokeSeqId === selectedInvokeSeqId;
					const hasCompletionDetails = visit.completedOutput !== undefined || (visit.emits?.length ?? 0) > 0;
					const expanded =
						selected ||
						(expandedVisits[visit.invokeSeqId] ??
							(!lazyDetails && index === visits.length - 1 && (visit.status === "running" || hasCompletionDetails)));
					const duration = formatVisitDuration(visit);
					const showBranch = visit.originBranchId !== undefined && visit.originBranchId !== currentBranchId;
					const showValidation = (visit.validationAttempts ?? 0) > 0 || state.validationPolicy !== undefined;
					const pinCount = visit.artifactPins?.length ?? 0;
					const emitCount = visit.emits?.length ?? 0;
					const hasFacts =
						visit.completedEvent !== undefined || visit.endedReason !== undefined || showValidation || pinCount > 0;
					return (
						<details
							key={visit.invokeSeqId}
							open={expanded}
							aria-current={selected ? "true" : undefined}
							onToggle={(event) => {
								const open = event.currentTarget.open;
								setExpandedVisits((current) =>
									current[visit.invokeSeqId] === open ? current : { ...current, [visit.invokeSeqId]: open },
								);
							}}
							className={`group min-w-0 rounded-lg border bg-[var(--bg-secondary)] ${selected ? "border-blue-500/60 ring-1 ring-blue-500/25" : "border-[var(--border-secondary)]"}`}
						>
							<summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 overflow-hidden px-2.5 py-2 text-[11px] marker:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500">
								<span className="shrink-0 font-semibold text-[var(--text-primary)]">Visit {visit.visit}</span>
								<span className="shrink-0 text-[var(--text-muted)]">·</span>
								<StatusPill status={visit.status} />
								{visit.completedEvent !== undefined && (
									<>
										<span className="shrink-0 text-[var(--text-muted)]">·</span>
										<code
											className="min-w-0 truncate font-mono text-[10px] text-[var(--text-secondary)]"
											title={visit.completedEvent}
										>
											{visit.completedEvent}
										</code>
									</>
								)}
								<span className="shrink-0 text-[var(--text-muted)]">·</span>
								<span className="shrink-0 font-mono text-[10px] text-[var(--text-muted)]" title={durationTitle(visit)}>
									{duration}
								</span>
								{emitCount > 0 && (
									<>
										<span className="shrink-0 text-[var(--text-muted)]">·</span>
										<span className="shrink-0 text-[10px] text-[var(--hc-pink-text)]">
											{emitCount} emit{emitCount === 1 ? "" : "s"}
										</span>
									</>
								)}
								{showBranch && (
									<span
										className="min-w-0 truncate rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] text-[var(--hc-amber-text)]"
										title={`Origin branch: ${visit.originBranchId}`}
									>
										branch:{visit.originBranchId}
									</span>
								)}
								<span
									className="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded text-[var(--text-muted)] group-hover:bg-[var(--bg-hover)] group-focus-visible:bg-[var(--bg-hover)]"
									title={expanded ? "Collapse visit" : "Expand visit"}
								>
									<ChevronRightIcon className="h-3.5 w-3.5 group-open:rotate-90" aria-hidden="true" />
								</span>
							</summary>
							{(!lazyDetails || expanded) && (
								<div className="space-y-3 border-t border-[var(--border-primary)] px-2.5 py-2.5">
									{visit.replayWarning !== undefined && (
										<div role="note" className="text-[11px] text-[var(--hc-amber-text)]">
											{visit.replayWarning}
										</div>
									)}
									{hasFacts && (
										<dl className="flex flex-wrap gap-x-4 gap-y-1.5 text-[10px]">
											{visit.completedEvent !== undefined && (
												<div className="flex items-center gap-1.5">
													<dt className="text-[var(--text-muted)]">completed event</dt>
													<dd>
														<code
															className={`rounded border px-1.5 py-0.5 font-mono ${hyperchartStatusClasses(visit.status)}`}
														>
															{visit.completedEvent}
														</code>
													</dd>
												</div>
											)}
											{visit.endedReason !== undefined && (
												<div className="flex items-baseline gap-1.5">
													<dt className="text-[var(--text-muted)]">ended reason</dt>
													<dd className="text-[var(--text-secondary)]">
														{visit.endedReason === "timed_out" ? "deadline fired" : "scope exited"}
													</dd>
												</div>
											)}
											{showValidation && (
												<div className="flex items-baseline gap-1.5">
													<dt className="text-[var(--text-muted)]">validation</dt>
													<dd className="font-mono text-[var(--text-secondary)]">
														{visit.validationAttempts ?? 0} attempt{visit.validationAttempts === 1 ? "" : "s"}
													</dd>
												</div>
											)}
											{pinCount > 0 && (
												<div className="flex items-baseline gap-1.5">
													<dt className="text-[var(--text-muted)]">artifact pins</dt>
													<dd className="font-mono text-[var(--text-secondary)]">{pinCount}</dd>
												</div>
											)}
										</dl>
									)}
									{visit.completedOutput !== undefined && (
										<div>
											<div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
												<span className="font-mono text-[var(--text-secondary)]">
													{visit.completedEvent ?? "completion"}
												</span>
												<span>· reply</span>
											</div>
											<ExpandablePre collapsedLines={6} language="json" wrapLongLines>
												{prettyJson(visit.completedOutput)}
											</ExpandablePre>
										</div>
									)}
									{visit.emits !== undefined && visit.emits.length > 0 && (
										<div>
											<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--hc-pink-text)]">Emitted</div>
											<div className="grid gap-2 border-l-2 border-pink-500/30 pl-2">
												{visit.emits.map((emitted) => (
													<div key={emitted.seqId} className="min-w-0 space-y-1">
														<div className="flex min-w-0 items-center gap-1.5">
															<code
																className="min-w-0 truncate rounded border border-pink-500/30 bg-pink-500/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--hc-pink-text)]"
																title={emitted.event}
															>
																{emitted.event}
															</code>
															<span className="shrink-0 font-mono text-[9px] text-[var(--text-muted)]">
																seq {emitted.seqId}
															</span>
														</div>
														<ExpandablePre collapsedLines={5} language="json" wrapLongLines>
															{prettyJson(emitted.payload)}
														</ExpandablePre>
													</div>
												))}
											</div>
										</div>
									)}
									{visit.inputs !== undefined && (
										<div>
											<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
												resolved inputs
											</div>
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
									{visit.artifactPins !== undefined && visit.artifactPins.length > 0 && (
										<div>
											<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
												pinned deliverables
											</div>
											<div className="grid gap-1.5">
												{visit.artifactPins.map((pin) => {
													const artifact = state.artifacts?.find((candidate) => candidate.path === pin.path);
													const typeName =
														(artifact?.name ?? "artifact")
															.split(/[^A-Za-z0-9_$]+/)
															.filter(Boolean)
															.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
															.join("") || "Artifact";
													return (
														<ArtifactRow
															key={pin.path}
															kind="pin"
															label={pin.path}
															detail={`sha256:${pin.hash.slice(0, 12)} · ${formatPinSize(pin.size)}`}
															{...(artifact?.schema === undefined
																? {}
																: { typeText: `type ${typeName} = ${schemaTypeText(artifact.schema)};` })}
															{...(artifact !== undefined && onHighlightArtifact !== undefined
																? { onClick: () => onHighlightArtifact(state.id, artifact.name) }
																: {})}
														/>
													);
												})}
											</div>
										</div>
									)}
									<VisitInvocationDetails
										recordOnly={visit.replayWarning !== undefined}
										invocation={visit.invocation}
										state={state}
										allStates={allStates}
										{...(onHighlightArtifact === undefined ? {} : { onHighlightArtifact })}
									/>
									{canReadSession && (
										<div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-primary)] pt-2">
											<button
												type="button"
												aria-label={`View session for visit ${visit.visit}`}
												disabled={sessionRead?.loading === true || sessionRead?.error !== undefined}
												onClick={(event) => {
													event.preventDefault();
													event.stopPropagation();
													openVisitSession(visit);
												}}
												className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-cyan-500/35 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--hc-cyan-text)] hover:bg-cyan-500/15 active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
											>
												<span
													className={`h-1.5 w-1.5 rounded-full ${visit.session !== undefined && isLiveSession(visit.session.status) ? "animate-pulse bg-emerald-400" : "bg-[var(--text-muted)]"}`}
												/>
												<CommandLineIcon className="h-3 w-3" aria-hidden="true" /> View session
											</button>
											{sessionRead?.loading === true && (
												<span role="status" className="text-[10px] text-[var(--text-muted)]">
													Loading transcript…
												</span>
											)}
											{sessionRead?.error !== undefined && (
												<span className="inline-flex items-center gap-1 text-[10px] text-[var(--danger)]">
													Transcript load failed: {sessionRead.error}
													<button
														type="button"
														className="text-[var(--hc-cyan-text)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-500"
														onClick={(event) => {
															event.preventDefault();
															event.stopPropagation();
															openVisitSession(visit);
														}}
													>
														Retry
													</button>
												</span>
											)}
										</div>
									)}
								</div>
							)}
						</details>
					);
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

function formatVisitDuration(visit: HyperchartVisitInfo): string {
	const milliseconds = Math.max(0, (visit.endedAt ?? Date.now()) - visit.startedAt);
	if (milliseconds < 1_000) {
		return `${Math.round(milliseconds)}ms`;
	}
	const seconds = Math.round(milliseconds / 1_000);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function durationTitle(visit: HyperchartVisitInfo): string {
	return `Started ${formatHyperchartDateTime(visit.startedAt)} · ${
		visit.endedAt === undefined ? "Still running" : `Ended ${formatHyperchartDateTime(visit.endedAt)}`
	}`;
}

function prettyJson(value: unknown): string {
	return JSON.stringify(value, null, 2) ?? String(value);
}

function formatPinSize(size: number): string {
	if (size < 1024) {
		return `${size} B`;
	}
	if (size < 1024 * 1024) {
		return `${(size / 1024).toFixed(1)} KB`;
	}
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
