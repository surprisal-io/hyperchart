import { useState } from "react";
import { ChevronRightIcon } from "@heroicons/react/20/solid";
import { BoltIcon, CommandLineIcon, EnvelopeIcon } from "@heroicons/react/24/outline";
import type { HyperchartActorMessageInfo, HyperchartActorSentMessageInfo, HyperchartStateInfo } from "../../../types.js";
import { formatHyperchartDateTime, formatHyperchartUsage } from "../../../hyperchart-display.js";
import { stateHasRuntimeDetails } from "../helpers/state.js";
import { FanoutStatusCard } from "../graph/FanoutStatusCard.js";
import { ExpandablePre } from "../ui/ExpandablePre.js";
import { Section } from "../ui/Section.js";
import { AgentSessionDialog } from "./AgentSessionDialog.js";
import { MapResolvedInputList } from "./MapResolvedInputList.js";
import { MapVisitHistory } from "./MapVisitHistory.js";
import { VisitHistory } from "./VisitHistory.js";

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

export function RuntimeSection({
	state,
	allStates = [state],
	onSteerSession,
	onHighlightArtifact,
	onNavigateToState,
}: {
	state: HyperchartStateInfo;
	allStates?: HyperchartStateInfo[];
	onSteerSession?: (actionKey: string, message: string) => void | Promise<void>;
	onHighlightArtifact?: (stateId: string, artifactName: string) => void;
	onNavigateToState?: (stateId: string) => void;
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
