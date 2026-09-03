import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRightIcon } from "@heroicons/react/20/solid";
import { BoltIcon, CommandLineIcon, EnvelopeIcon } from "@heroicons/react/24/outline";
import type { HyperchartActorGenerationInfo, HyperchartActorMessageBatchInfo, HyperchartActorMessageInfo, HyperchartActorSentMessageInfo, HyperchartInspectorDataSource, HyperchartStateInfo, HyperchartVisitInfo, HyperchartMapVisitInfo } from "../../../types.js";
import type { HistoryCursor, HistorySnapshot, HistorySubject } from "../../../../runtime/generic/log_store.js";
import { formatHyperchartDateTime, formatHyperchartUsage } from "../../../hyperchart-display.js";
import { stateHasRuntimeDetails } from "../helpers/state.js";
import { FanoutStatusCard } from "../graph/FanoutStatusCard.js";
import { ExpandablePre } from "../ui/ExpandablePre.js";
import { Section } from "../ui/Section.js";
import { AgentSessionDialog } from "./AgentSessionDialog.js";
import { ActorMailboxMessageRow } from "./ActorMailboxCard.js";
import { MapResolvedInputList } from "./MapResolvedInputList.js";
import { MapVisitHistory } from "./MapVisitHistory.js";
import { VisitHistory } from "./VisitHistory.js";
import { VirtualizedHistoryList } from "../history/VirtualizedHistoryList.js";

export type RuntimeHistoryContext = { runId: string; snapshot: HistorySnapshot; dataSource: HyperchartInspectorDataSource; targetSeqId?: number };

function ActorInternalMessageRow({ message, replies }: { message: HyperchartActorMessageInfo; replies: boolean }) {
	const [open, setOpen] = useState(false);
	const toggle = () => setOpen((value) => !value);
	return (
		<div
			role="button"
			tabIndex={0}
			aria-expanded={open}
			className="cursor-pointer rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-[10px]"
			onClick={toggle}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					toggle();
				}
			}}
		>
			<div className="flex min-w-0 items-center gap-2">
				<ChevronRightIcon className={`h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] transition-transform ${open ? "rotate-90" : ""}`} />
				<span className="min-w-0 flex-1 truncate font-semibold text-[var(--text-primary)]">
					{replies ? `${message.event} → ${message.replyEvent ?? "void"}` : message.event}
				</span>
				<span className="shrink-0 uppercase text-[var(--text-muted)]">{message.status}</span>
			</div>
			{open && (
				<div className="mt-2 min-w-0 space-y-2 pl-5">
					<dl className="grid min-w-0 gap-1 text-[var(--text-tertiary)] sm:grid-cols-2">
						<div className="min-w-0"><dt className="text-[var(--text-muted)]">message</dt><dd className="truncate font-mono" title={message.messageId}>{message.messageId}</dd></div>
						<div className="min-w-0"><dt className="text-[var(--text-muted)]">producer</dt><dd className="truncate font-mono" title={message.producerVisit}>{message.producerVisit}</dd></div>
						{message.callId !== undefined && <div className="min-w-0"><dt className="text-[var(--text-muted)]">call</dt><dd className="truncate font-mono">{message.callId}</dd></div>}
						{message.acceptedAt !== undefined && <div><dt className="text-[var(--text-muted)]">accepted</dt><dd>{formatHyperchartDateTime(message.acceptedAt)}</dd></div>}
						{message.repliedAt !== undefined && <div><dt className="text-[var(--text-muted)]">replied</dt><dd>{formatHyperchartDateTime(message.repliedAt)}</dd></div>}
						{replies && message.validation !== undefined && <div><dt className="text-[var(--text-muted)]">validation</dt><dd>{message.validation}</dd></div>}
					</dl>
					{!replies && <ExpandablePre collapsedLines={4} language="json">{JSON.stringify(message.input, null, 2)}</ExpandablePre>}
					{replies && Object.hasOwn(message, "replyOutput") && <ExpandablePre collapsedLines={4} language="json">{JSON.stringify(message.replyOutput, null, 2)}</ExpandablePre>}
				</div>
			)}
		</div>
	);
}

export function ActorInternalMessageHistory({ state, messages }: { state: HyperchartStateInfo; messages: HyperchartActorMessageInfo[] }) {
	const replies = state.type === "reply";
	return (
		<div className="grid gap-1.5">
			<div className="text-[9px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
				{messages.length} {replies ? (messages.length === 1 ? "reply" : "replies") : (messages.length === 1 ? "accepted message" : "accepted messages")}
			</div>
			{messages.map((message, index) => <ActorInternalMessageRow key={`${message.messageId}:${index}`} message={message} replies={replies} />)}
		</div>
	);
}

function ActorInternalGenerationRuntime({
	state,
	allStates,
	onNavigateToState,
	onSteerSession,
	onHighlightArtifact,
}: {
	state: HyperchartStateInfo;
	allStates: HyperchartStateInfo[];
	onNavigateToState?: (stateId: string) => void;
	onSteerSession?: (actionKey: string, message: string) => void | Promise<void>;
	onHighlightArtifact?: (stateId: string, artifactName: string) => void;
}) {
	const [showHistory, setShowHistory] = useState(false);
	const generations = state.actorInternal?.generations ?? [];
	const latest = generations.at(-1);
	if (latest === undefined) return null;
	const previous = generations.slice(0, -1).reverse();
	const renderGeneration = (generation: (typeof generations)[number], latestInstance: boolean) => {
		const messages = generation.actorMessageHistory ?? [];
		const sentMessages = generation.actorMessages ?? [];
		const visits = generation.visitHistory ?? [];
		return (
			<section key={generation.occurrencePath} className={latestInstance ? "" : "border-t border-[var(--border-secondary)] pt-2"}>
				<div className="mb-2 flex flex-wrap items-center gap-2 text-[10px]">
					<span className="font-semibold text-[var(--text-primary)]">{latestInstance ? "Latest instance" : "Instance"}</span>
					<button
						type="button"
						className="font-mono text-[var(--hc-cyan-text)] hover:underline"
						onClick={() => onNavigateToState?.(generation.logicalPath)}
					>
						{generation.logicalPath} · generation {generation.generation}
					</button>
					<span className="ml-auto uppercase text-[var(--text-muted)]">{generation.stateStatus}</span>
				</div>
				{messages.length > 0 && <ActorInternalMessageHistory state={state} messages={messages} />}
				{sentMessages.length > 0 && state.actorMessageLink !== undefined && (
					<ActorSentMessageVisits link={state.actorMessageLink} messages={sentMessages} />
				)}
				{visits.length > 0 && (
					<VisitHistory
						visits={visits}
						state={state}
						allStates={allStates}
						{...(state.agent === undefined ? {} : { agentName: state.agent })}
						{...(onSteerSession === undefined ? {} : { onSteerSession })}
						{...(onHighlightArtifact === undefined ? {} : { onHighlightArtifact })}
					/>
				)}
				{messages.length === 0 && sentMessages.length === 0 && visits.length === 0 && <div className="text-[10px] text-[var(--text-muted)]">No activity in this generation.</div>}
			</section>
		);
	};
	return (
		<div className="grid gap-2">
			{renderGeneration(latest, true)}
			{previous.length > 0 && (
				<button type="button" className="justify-self-start text-[10px] text-[var(--hc-cyan-text)]" onClick={() => setShowHistory((value) => !value)}>
					{showHistory ? "Hide history" : "Show history"}
				</button>
			)}
			{showHistory && <div className="grid gap-2">{previous.map((generation) => renderGeneration(generation, false))}</div>}
		</div>
	);
}

function messagesByVisit(messages: HyperchartActorSentMessageInfo[] | undefined) {
	const visits = new Map<number, HyperchartActorSentMessageInfo[]>();
	for (const message of messages ?? []) visits.set(message.producerVisit, [...(visits.get(message.producerVisit) ?? []), message]);
	return [...visits.entries()];
}

function ActorSentMessageVisits({
	link,
	messages,
}: {
	link: NonNullable<HyperchartStateInfo["actorMessageLink"]>;
	messages: HyperchartActorSentMessageInfo[];
}) {
	return (
		<div className="grid gap-2">
			<div className="flex items-center gap-1.5 text-[10px]">
				<EnvelopeIcon className="h-3 w-3 text-[var(--text-muted)]" aria-hidden="true" />
				<span className="font-mono text-[var(--text-primary)]">{link.event}</span>
				<span className="text-[var(--text-muted)]">→</span>
				<span className="font-mono text-[var(--text-secondary)]">{link.to}</span>
			</div>
			{messagesByVisit(messages).map(([visit, visitMessages]) => (
				<div key={visit} className="grid gap-2 rounded-lg border border-[var(--border-secondary)] p-2">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]">
						<span className="font-semibold text-[var(--text-secondary)]">Visit {visit} · {visitMessages.length} {visitMessages.length === 1 ? "message" : "messages"}</span>
						{visitMessages[0] !== undefined && (
							<span className="ml-auto text-[var(--text-muted)]">
								target <code className="text-[var(--text-secondary)]">{visitMessages[0].targetLogicalPath}</code> · generation {visitMessages[0].targetGeneration}
							</span>
						)}
					</div>
					{[...visitMessages].sort((left, right) => left.batchIndex - right.batchIndex).map((message) => (
						<div key={message.messageId} className="rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-[10px]">
							<div className="flex items-center justify-between gap-2">
								<code className="truncate text-[var(--text-tertiary)]" title={message.messageId}>{message.messageId}</code>
								<span className="shrink-0 text-[var(--text-muted)]">{message.status}</span>
							</div>
							<ExpandablePre collapsedLines={6} language="json">{JSON.stringify(message.input, null, 2)}</ExpandablePre>
						</div>
					))}
				</div>
			))}
		</div>
	);
}

function HistoryDisclosure({ label, children }: { label: string; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return <div className="grid gap-2"><button type="button" aria-expanded={open} className="justify-self-start text-[10px] text-[var(--hc-cyan-text)]" onClick={() => setOpen((value) => !value)}>{open ? `Hide ${label}` : `Load ${label}`}</button>{open && children}</div>;
}

function historyCacheKey(history: RuntimeHistoryContext, kind: string, subject: string): string {
	return `${history.runId}:${history.snapshot.branchId}:${history.snapshot.headSeqId ?? "root"}:${kind}:${subject}`;
}

/** @internal Deep-link request coordinator characterized by interaction tests. */
export function useTargetCursor(history: RuntimeHistoryContext, subject: HistorySubject) {
	const key = `${historyCacheKey(history, subject.kind, JSON.stringify(subject))}:${history.targetSeqId ?? "newest"}`;
	const [resolved, setResolved] = useState<{ key: string; cursor?: HistoryCursor; error?: string }>();
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		if (history.targetSeqId === undefined) return;
		let current = true;
		void history.dataSource.cursorAt({ runId: history.runId, snapshot: history.snapshot, subject, seqId: history.targetSeqId }).then((cursor) => {
			if (current) setResolved({ key, ...(cursor === undefined ? {} : { cursor }) });
		}, (error: unknown) => {
			if (current) setResolved({ key, error: error instanceof Error ? error.message : String(error) });
		});
		return () => { current = false; };
	}, [attempt, history.dataSource, history.runId, history.snapshot, history.targetSeqId, key]);
	return history.targetSeqId === undefined
		? { ready: true as const, missing: false }
		: resolved?.key === key
			? { ready: true as const, missing: resolved.error === undefined && resolved.cursor === undefined, cursor: resolved.cursor, error: resolved.error, retry: () => setAttempt((value) => value + 1) }
			: { ready: false as const, missing: false };
}

function TargetCursorError({ error, onRetry }: { error: string; onRetry: () => void }) {
	return <div className="flex items-center gap-2 text-[10px] text-[var(--danger)]"><span>Could not locate history item: {error}</span><button type="button" className="text-[var(--hc-cyan-text)]" onClick={onRetry}>Retry</button></div>;
}

function LazyStateVisits({ history, state, allStates, onSteerSession, onHighlightArtifact }: {
	history: RuntimeHistoryContext;
	state: HyperchartStateInfo;
	allStates: HyperchartStateInfo[];
	onSteerSession?: (actionKey: string, message: string) => void | Promise<void>;
	onHighlightArtifact?: (stateId: string, artifactName: string) => void;
}) {
	const stateId = state.runtimeStatePath ?? state.id;
	const target = useTargetCursor(history, { kind: "state-visits", state: stateId });
	const source = useMemo(() => ({ load: (cursor?: HistoryCursor) => history.dataSource.readStateVisits({ runId: history.runId, snapshot: history.snapshot, stateId, ...(cursor === undefined ? {} : { cursor }) }) }), [history.dataSource, history.runId, history.snapshot, stateId]);
	if (!target.ready) return <div className="text-[10px] text-[var(--text-muted)]">Locating history item…</div>;
	if ("error" in target && target.error !== undefined) return <TargetCursorError error={target.error} onRetry={target.retry} />;
	if (target.missing) return <div className="text-[10px] text-[var(--text-muted)]">The linked record is not a visit of this state.</div>;
	return <VirtualizedHistoryList<HyperchartVisitInfo>
		cacheKey={historyCacheKey(history, "state-visits", stateId)} source={source} {...(target.cursor === undefined ? {} : { initialCursor: target.cursor })}
		identity={(visit) => String(visit.invokeSeqId)} estimateSize={88} emptyLabel="No visits in this snapshot."
		renderItem={(visit) => <VisitHistory visits={[visit]} state={state} allStates={allStates} lazyDetails {...(state.agent === undefined ? {} : { agentName: state.agent })} onReadSession={(invokeSeqId) => history.dataSource.readVisitSession({ runId: history.runId, branchId: history.snapshot.branchId, invokeSeqId })} {...(onSteerSession === undefined ? {} : { onSteerSession })} {...(onHighlightArtifact === undefined ? {} : { onHighlightArtifact })} />}
	/>;
}

function LazyMapVisits({ history, state }: { history: RuntimeHistoryContext; state: HyperchartStateInfo }) {
	const mapPath = state.runtimeStatePath ?? state.id;
	const target = useTargetCursor(history, { kind: "map-visits", mapPath });
	const source = useMemo(() => ({ load: (cursor?: HistoryCursor) => history.dataSource.readMapVisits({ runId: history.runId, snapshot: history.snapshot, mapPath, ...(cursor === undefined ? {} : { cursor }) }) }), [history.dataSource, history.runId, history.snapshot, mapPath]);
	if (!target.ready) return <div className="text-[10px] text-[var(--text-muted)]">Locating history item…</div>;
	if ("error" in target && target.error !== undefined) return <TargetCursorError error={target.error} onRetry={target.retry} />;
	if (target.missing) return <div className="text-[10px] text-[var(--text-muted)]">The linked record is not a launch of this map.</div>;
	return <VirtualizedHistoryList<HyperchartMapVisitInfo>
		cacheKey={historyCacheKey(history, "map-visits", mapPath)} source={source} {...(target.cursor === undefined ? {} : { initialCursor: target.cursor })}
		identity={(visit) => String(visit.spawnSeqId)} estimateSize={62} emptyLabel="No map launches in this snapshot."
		renderItem={(visit) => <MapVisitHistory visits={[visit]} {...(state.onReenter === undefined ? {} : { onReenter: state.onReenter })} />}
	/>;
}

function LazyActorGenerations({ history, logicalOccurrence }: { history: RuntimeHistoryContext; logicalOccurrence: string }) {
	const target = useTargetCursor(history, { kind: "actor-generations", logicalOccurrence });
	const source = useMemo(() => ({ load: (cursor?: HistoryCursor) => history.dataSource.readActorGenerations({ runId: history.runId, snapshot: history.snapshot, logicalOccurrence, ...(cursor === undefined ? {} : { cursor }) }) }), [history.dataSource, history.runId, history.snapshot, logicalOccurrence]);
	if (!target.ready) return <div className="text-[10px] text-[var(--text-muted)]">Locating history item…</div>;
	if ("error" in target && target.error !== undefined) return <TargetCursorError error={target.error} onRetry={target.retry} />;
	if (target.missing) return <div className="text-[10px] text-[var(--text-muted)]">The linked record is not an actor generation.</div>;
	return <VirtualizedHistoryList<HyperchartActorGenerationInfo>
		cacheKey={historyCacheKey(history, "actor-generations", logicalOccurrence)} source={source} {...(target.cursor === undefined ? {} : { initialCursor: target.cursor })}
		identity={(generation) => `${generation.occurrencePath}:${generation.createdSeqId}`}
		estimateSize={53}
		emptyLabel="No actor generations in this snapshot."
		renderItem={(generation) => <div className="rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-[10px]"><div className="font-semibold text-[var(--text-primary)]">Generation {generation.generation}</div><code className="text-[var(--text-muted)]">{generation.occurrencePath} · seq {generation.createdSeqId}</code></div>}
	/>;
}

function LazyActorMessages({ history, occurrence }: { history: RuntimeHistoryContext; occurrence: string }) {
	const target = useTargetCursor(history, { kind: "actor-messages", occurrence });
	const source = useMemo(() => ({ load: (cursor?: HistoryCursor) => history.dataSource.readActorMessages({ runId: history.runId, snapshot: history.snapshot, occurrence, ...(cursor === undefined ? {} : { cursor }) }) }), [history.dataSource, history.runId, history.snapshot, occurrence]);
	if (!target.ready) return <div className="text-[10px] text-[var(--text-muted)]">Locating history item…</div>;
	if ("error" in target && target.error !== undefined) return <TargetCursorError error={target.error} onRetry={target.retry} />;
	if (target.missing) return <div className="text-[10px] text-[var(--text-muted)]">The linked record is not an enqueue batch for this actor.</div>;
	return <VirtualizedHistoryList<HyperchartActorMessageBatchInfo>
		cacheKey={historyCacheKey(history, "actor-messages", occurrence)} source={source} {...(target.cursor === undefined ? {} : { initialCursor: target.cursor })}
		identity={(batch) => `${batch.occurrencePath}:${batch.enqueueSeqId}`}
		estimateSize={80}
		emptyLabel="No actor messages in this snapshot."
		renderItem={(batch) => <div className="grid gap-1 rounded border border-[var(--border-secondary)] p-2"><div className="text-[9px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Enqueue seq {batch.enqueueSeqId} · {batch.messages.length} message{batch.messages.length === 1 ? "" : "s"}</div>{batch.messages.map((message, index) => <ActorMailboxMessageRow key={message.messageId} message={message} index={index} />)}</div>}
	/>;
}

export function RuntimeSection({
	state,
	allStates = [state],
	onSteerSession,
	onHighlightArtifact,
	onNavigateToState,
	history,
}: {
	state: HyperchartStateInfo;
	allStates?: HyperchartStateInfo[];
	onSteerSession?: (actionKey: string, message: string) => void | Promise<void>;
	onHighlightArtifact?: (stateId: string, artifactName: string) => void;
	onNavigateToState?: (stateId: string) => void;
	history?: RuntimeHistoryContext;
}) {
	const [openSessionIdentity, setOpenSessionIdentity] = useState<string>();
	const session = state.session;
	const sessionIdentity = `${state.id}:${session?.actionKey ?? "none"}:${session?.startedAt ?? "unknown"}`;
	if (!stateHasRuntimeDetails(state)) return null;
	const sessionIsLive = session?.status === "running" || session?.status === "starting";
	const actorOccurrence = state.actorOccurrence;
	const actorMessage = state.type === "send" || state.type === "sendBatch" || state.type === "call" || state.type === "callBatch"
		? state.actorMessageLink
		: undefined;
	const actorInternalMessages = state.actorMessageHistory;
	const actorInternalGenerations = state.actorInternal?.generations;
	const linkedOccurrence = actorMessage === undefined ? undefined : allStates.find((candidate) => (candidate.actorOccurrence?.logicalPath ?? candidate.actorOccurrence?.occurrencePath) === actorMessage.to)?.actorOccurrence?.occurrencePath;
	const historyOccurrence = actorOccurrence?.occurrencePath ?? state.actorInternal?.occurrencePath ?? linkedOccurrence;
	const historyLogicalOccurrence = actorOccurrence?.logicalPath ?? state.actorInternal?.logicalOccurrencePath;
	return (
		<>
			<Section
				key={`runtime:${sessionIdentity}`}
				title="Runtime"
				icon={BoltIcon}
				defaultOpen={sessionIsLive || actorOccurrence !== undefined || actorInternalGenerations !== undefined}
				forceOpen={sessionIsLive}
			>
				{session !== undefined && actorInternalGenerations === undefined && (
					<div className="rounded-lg border border-cyan-500/25 bg-cyan-500/10 p-2">
						<div className="flex flex-wrap items-start justify-between gap-2">
							<div className="min-w-0 flex-1">
								<div className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--hc-cyan-text)]">
									<CommandLineIcon className="h-3 w-3" aria-hidden="true" /> Agent session
								</div>
								<div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--text-tertiary)]">
									<span className="inline-flex items-center gap-1">
										<span
											className={`h-1.5 w-1.5 rounded-full ${sessionIsLive ? "animate-pulse bg-emerald-400" : "bg-[var(--text-muted)]"}`}
										/>
										{session.status}
									</span>
									{session.role !== undefined && <span>role {session.role}</span>}
									{session.model !== undefined && (
										<span className="max-w-full truncate" title={session.model}>
											{session.model}
										</span>
									)}
									{session.thinking !== undefined && <span>think {session.thinking}</span>}
									{session.toolset !== undefined && <span>toolset {session.toolset}</span>}
									{session.tools !== undefined && (
										<span title={session.tools.join(", ")}>{session.tools.length} enabled tools</span>
									)}
									{session.turnCount !== undefined && <span>{session.turnCount} turns</span>}
									{session.toolCount !== undefined && <span>{session.toolCount} tools</span>}
									{session.tokenCount !== undefined && <span>{session.tokenCount.toLocaleString()} tokens</span>}
								</div>
								{session.error !== undefined && (
									<div className="mt-1 break-words text-[10px] text-[var(--danger)] [overflow-wrap:anywhere]">
										{session.error}
									</div>
								)}
							</div>
							<button
								type="button"
								onClick={() => setOpenSessionIdentity(sessionIdentity)}
								className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-cyan-500/35 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--hc-cyan-text)] hover:bg-cyan-500/15"
							>
								<CommandLineIcon className="h-3 w-3" aria-hidden="true" /> View session
							</button>
						</div>
					</div>
				)}
				{actorOccurrence !== undefined && (
					<div className="grid gap-2">
						<dl className="grid grid-cols-2 gap-2 text-[10px]">
							<div><dt className="text-[var(--text-muted)]">actor path</dt><dd className="break-all font-mono">{actorOccurrence.logicalPath ?? actorOccurrence.occurrencePath}</dd></div>
							<div><dt className="text-[var(--text-muted)]">generation</dt><dd className="font-mono">{actorOccurrence.generation}</dd></div>
							<div><dt className="text-[var(--text-muted)]">current state</dt><dd className="font-mono">{actorOccurrence.currentState}</dd></div>
							<div><dt className="text-[var(--text-muted)]">status</dt><dd>{actorOccurrence.status}</dd></div>
						</dl>
						{actorOccurrence.generationHistory !== undefined && (
							<VisitHistory
								visits={actorOccurrence.generationHistory}
								state={state}
								allStates={allStates}
								{...(onSteerSession === undefined ? {} : { onSteerSession })}
								{...(onHighlightArtifact === undefined ? {} : { onHighlightArtifact })}
							/>
						)}
						{actorOccurrence.drain !== undefined && <div className="rounded border border-amber-500/25 p-2 text-[10px]">Drain · {actorOccurrence.drain.current} current · {actorOccurrence.drain.queued} queued · {actorOccurrence.drain.settled} settled</div>}
					</div>
				)}
				{actorInternalGenerations !== undefined && (
					<ActorInternalGenerationRuntime
						state={state}
						allStates={allStates}
						{...(onNavigateToState === undefined ? {} : { onNavigateToState })}
						{...(onSteerSession === undefined ? {} : { onSteerSession })}
						{...(onHighlightArtifact === undefined ? {} : { onHighlightArtifact })}
					/>
				)}
				{actorInternalGenerations === undefined && actorInternalMessages !== undefined && <ActorInternalMessageHistory state={state} messages={actorInternalMessages} />}
				{actorMessage !== undefined && actorMessage.messages !== undefined && <ActorSentMessageVisits link={actorMessage} messages={actorMessage.messages} />}
				{actorMessage !== undefined && actorMessage.messages === undefined && <div className="text-[10px] text-[var(--text-muted)]">No message enqueued yet.</div>}
				{actorInternalGenerations === undefined && (state.startedAt !== undefined ||
					state.endedAt !== undefined ||
					state.mapItemLabel ||
					state.visits !== undefined) && (
					<dl className="grid grid-cols-2 gap-2 text-[11px]">
						{state.startedAt !== undefined && (
							<div>
								<dt className="text-[var(--text-muted)]">started</dt>
								<dd>{formatHyperchartDateTime(state.startedAt)}</dd>
							</div>
						)}
						{state.endedAt !== undefined && (
							<div>
								<dt className="text-[var(--text-muted)]">ended</dt>
								<dd>{formatHyperchartDateTime(state.endedAt)}</dd>
							</div>
						)}
						{state.mapItemLabel && (
							<div className="min-w-0">
								<dt className="text-[var(--text-muted)]">map item</dt>
								<dd className="truncate" title={state.mapItemLabel}>
									{state.mapItemLabel}
								</dd>
							</div>
						)}
						{state.visits !== undefined && (
							<div>
								<dt className="text-[var(--text-muted)]">visits</dt>
								<dd>{state.visits}</dd>
							</div>
						)}
					</dl>
				)}
				<FanoutStatusCard state={state} />
				{state.usage && (
					<div className="text-[11px] text-[var(--text-tertiary)]">
						usage: {formatHyperchartUsage(state.usage) ?? JSON.stringify(state.usage)}
					</div>
				)}
				{history !== undefined && state.visitHistory === undefined && (state.type === "agent" || state.type === "user" || state.type === "script") && (
					<LazyStateVisits history={history} state={state} allStates={allStates} {...(onSteerSession === undefined ? {} : { onSteerSession })} {...(onHighlightArtifact === undefined ? {} : { onHighlightArtifact })} />
				)}
				{history !== undefined && state.type === "map" && state.mapConfig?.visitHistory === undefined && <HistoryDisclosure label="map launch history"><LazyMapVisits history={history} state={state} /></HistoryDisclosure>}
				{history !== undefined && historyLogicalOccurrence !== undefined && <HistoryDisclosure label="actor generations"><LazyActorGenerations history={history} logicalOccurrence={historyLogicalOccurrence} /></HistoryDisclosure>}
				{history !== undefined && historyOccurrence !== undefined && <HistoryDisclosure label="actor message history"><LazyActorMessages history={history} occurrence={historyOccurrence} /></HistoryDisclosure>}
				{actorInternalGenerations === undefined && state.visitHistory !== undefined && (
					<VisitHistory
						visits={state.visitHistory}
						state={state}
						allStates={allStates}
						{...(state.agent === undefined ? {} : { agentName: state.agent })}
						{...(onSteerSession === undefined ? {} : { onSteerSession })}
						{...(onHighlightArtifact === undefined ? {} : { onHighlightArtifact })}
					/>
				)}
				{state.type === "map" && state.mapConfig?.visitHistory !== undefined && (
					<MapVisitHistory
						visits={state.mapConfig.visitHistory}
						{...(state.onReenter === undefined ? {} : { onReenter: state.onReenter })}
					/>
				)}
				{state.type === "map" && state.mapConfig?.visitHistory === undefined && <MapResolvedInputList state={state} />}
			</Section>
			{openSessionIdentity === sessionIdentity && session !== undefined && (
				<AgentSessionDialog
					key={`session-dialog:${sessionIdentity}`}
					agentName={state.agent ?? state.id}
					session={session}
					onClose={() => setOpenSessionIdentity(undefined)}
					{...(onSteerSession === undefined
						? {}
						: { onSteer: (message: string) => onSteerSession(session.actionKey, message) })}
				/>
			)}
		</>
	);
}
