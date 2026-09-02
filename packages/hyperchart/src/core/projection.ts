import assert from "./assert.js";
import type { ActionStateAst, ActionUID, ActorDefinitionAst, ActorEndpointDeclarationAst, ActorDeclarationAst, ActorPoolDeclarationAst, ChartAst, ChartEvent, SchemaAst, StateAst, StatePath, TransitionAst } from "./types.js";
import type { ActorMessageEnvelope, ArtifactPin, DurableLogRecord, UserInteractionOpenedLog } from "./durable_events.js";
import { actorContextForState, actorDefinitionForEndpoint, actorGenerationPath, actorLogicalOccurrencePath, actorOccurrencePath, actorPoolWorkerOccurrencePath, actorStatePath } from "./actors.js";
import { actionUidKey } from "./action_uid.js";
import {
	childPath,
	lastSegmentKey,
	matchesDeclaredUid,
	nodeAt,
	parentPath,
	siblingPath,
	stripLastKey,
	templatePath,
	underScope,
} from "./paths.js";

// A pending action and the phase it is in, each phase started by a log record: invoke —
// "running"; a completion on a validated state — "validating"; a negative verdict — "rejected"
// (feedback to deliver); a new completion restarts the cycle. An accepted verdict (or a
// completion needing no validation) removes the entry and applies the transition. The action's
// session is alive through the whole cycle. seqId is the record that started the current phase;
// it makes the effect id of each phase unique.
export type ProjectionSkippedRecord = Readonly<{
	record: DurableLogRecord;
	state: StatePath;
	reason: "inactive";
	activeLeaves: readonly StatePath[];
}>;

export type PendingAction =
	// timestamp of the invoke fact is the state's entry time — the anchor for its after-deadline.
	// validationAttempts counts the rejected rounds of this invoke cycle — derived from validated(false)
	// facts, it decides when the retry budget (state.retries) is exhausted.
	| { actionUid: ActionUID; visitId: number; seqId: number; invokeSeqId: number; sessionId: string; timestamp: number; phase: "running"; gateSeqId?: number }
	| {
			actionUid: ActionUID;
			visitId: number;
			seqId: number;
			invokeSeqId: number;
			sessionId: string;
			phase: "validating";
			gateSeqId?: number;
			event: ChartEvent;
			validationAttempts: number;
	  }
	| {
			actionUid: ActionUID;
			visitId: number;
			seqId: number;
			invokeSeqId: number;
			sessionId: string;
			phase: "rejected";
			gateSeqId?: number;
			event: ChartEvent;
			validationAttempts: number;
			reason?: string;
	  };

export type ProjectedActorMessage = ActorMessageEnvelope & {
	status: "queued" | "accepted" | "replied" | "settled" | "failed" | "cancelled";
	receiveState?: StatePath;
	replyEvent?: string;
	replyOutput?: unknown;
	workerIndex?: number;
};

export type ProjectedActorOccurrence = {
	declaration: StatePath;
	logicalOccurrence: StatePath;
	occurrence: StatePath;
	generation: number;
	owner?: StatePath;
	input: unknown;
	definition: import("./types.js").ActorDeclarationAst;
	currentState: StatePath;
	mailbox: ProjectedActorMessage[];
	currentMessage?: ProjectedActorMessage;
	status: "idle" | "busy" | "closing" | "draining" | "stopped" | "failed" | "cancelled";
};

export type ProjectedActorPoolWorker = {
	index: number;
	occurrence: StatePath;
	currentState: StatePath;
	currentMessage?: ProjectedActorMessage;
	status: "idle" | "busy" | "draining" | "stopped" | "failed" | "cancelled";
};

export type ProjectedActorPoolOccurrence = {
	declaration: StatePath;
	logicalOccurrence: StatePath;
	occurrence: StatePath;
	generation: number;
	owner?: StatePath;
	input: unknown;
	definition: ActorPoolDeclarationAst;
	mailbox: ProjectedActorMessage[];
	workers: ProjectedActorPoolWorker[];
	status: "idle" | "busy" | "closing" | "draining" | "stopped" | "failed" | "cancelled";
};

export type ProjectedActorEndpointOccurrence = ProjectedActorOccurrence | ProjectedActorPoolOccurrence;

export type PendingActorCall =
	| {
		kind: "singleton";
		callId: string;
		callerState: StatePath;
		occurrence: StatePath;
		messageId: string;
		status: "enqueued" | "accepted" | "partial";
		messages: ProjectedActorMessage[];
	}
	| {
		kind: "batch";
		callId: string;
		callerState: StatePath;
		occurrence: StatePath;
		messageIds: readonly string[];
		status: "enqueued" | "accepted" | "partial";
		messages: ProjectedActorMessage[];
	};

export type OpenProjectedUserInteraction = {
	opened: UserInteractionOpenedLog;
	status: "open";
};

export type BranchProjection = {
	// The active configuration: one leaf normally, one per region while a parallel is active.
	// Always leaves — compounds drill down to their initial, parallels expand to their regions.
	activeLeaves: StatePath[];
	seqId: number;
	pendingActions: PendingAction[];
	/** Open journal-native user gates keyed by their opened-record seqId. */
	openUserInteractions: Record<number, OpenProjectedUserInteraction>;
	// The run's input arguments; undefined until the args fact lands in the log.
	args?: Readonly<Record<string, unknown>>;
	// Pinned fan-outs: map instance-path → { key → item }, written by spawned facts. Entries stay
	// after the map exits — reads over a completed map's instances resolve from here.
	spawns: Record<StatePath, Readonly<Record<string, unknown>>>;
	// Latest input object per input-declaring state; re-entering a state overwrites its inputs.
	inputs: Record<StatePath, Record<string, unknown>>;
	// Latest accepted output per action state; re-entering a state overwrites its result.
	results: Record<StatePath, unknown>;
	// Per concrete actionUid, how many invoke records have entered that action state. Replayed from
	// durable facts so visit ids stay stable without being stored in each log record.
	stateVisits: Record<string, number>;
	// Latest persisted agent session file per concrete actionUid. Optional runtime metadata used
	// for onReenter resume; it never drives chart control flow.
	sessions: Record<string, string>;
	/** Latest accepted durable artifact revision per rendered authored path. */
	artifactPins: Record<string, ArtifactPin>;
	/** Durable global fail-fast intent. Presence blocks every new invoke/message effect. */
	failure?: { origin: StatePath; error: unknown; seqId: number };
	actors: Record<StatePath, ProjectedActorOccurrence>;
	actorPools: Record<StatePath, ProjectedActorPoolOccurrence>;
	pendingActorCalls: Record<string, PendingActorCall>;
	/** Derived producer visit count makes message/call ids deterministic across restart. */
	actorProducerVisits: Record<StatePath, number>;
};

export function isFinalState(projection: BranchProjection, ast: ChartAst): boolean {
	return (
		projection.activeLeaves.length > 0 && projection.activeLeaves.every((leaf) => nodeAt(ast, leaf)?.kind === "final")
	);
}

export function createBranchProjection(ast: ChartAst): BranchProjection {
	const projection: BranchProjection = {
		activeLeaves: enterState(ast, ast.initial),
		seqId: 0,
		pendingActions: [],
		openUserInteractions: {},
		spawns: {},
		inputs: {},
		results: {},
		stateVisits: {},
		sessions: {},
		artifactPins: {},
		actors: {},
		actorPools: {},
		pendingActorCalls: {},
		actorProducerVisits: {},
	};
	applyInputsForEntry(projection, ast, ast.initial);
	completeParallels(projection, ast);
	return projection;
}

export function projectBranch(
	projection: BranchProjection,
	ast: ChartAst,
	log: readonly DurableLogRecord[],
	// Collects pending work dropped by an exit while its session was alive (its own record never
	// removes it — see exitAndEnter). The machine turns these into cancel signals; replay at
	// startup passes nothing and lets history's abandoned work stay abandoned.
	abandoned: PendingAction[] = [],
	// Collects durable facts that are legal no-ops because their state is no longer active. This is
	// the race-loser mechanism, but replay diagnostics also use it to expose chart edits that make
	// old work disappear silently.
	skipped: ProjectionSkippedRecord[] = [],
): BranchProjection {
	for (const record of log) {
		switch (record.type) {
			case "session_ref":
				// No control-state change, just a reference to a persisted runtime session.
				if (record.actionUid !== undefined) {
					projection.sessions[actionUidKey(record.actionUid)] = record.file;
				}
				break;
			case "args":
				projection.args = record.args;
				break;
			case "failure_intent":
				assertFailureIntent(projection);
				projection.failure = { origin: record.origin, error: record.error, seqId: record.seqId };
				projection.openUserInteractions = {};
				break;
			case "actor_created": {
				const { liveDefinition, logicalOccurrence } = assertActorCreated(projection, ast, record);
				if (liveDefinition.kind === "actorPool") {
					projection.actorPools[record.occurrence] = {
						declaration: record.declaration,
						logicalOccurrence,
						occurrence: record.occurrence,
						generation: record.generation,
						...(record.owner === undefined ? {} : { owner: record.owner }),
						input: record.input,
						definition: record.definition as ActorPoolDeclarationAst,
						mailbox: [],
						workers: Array.from({ length: liveDefinition.concurrency }, (_, index) => ({
							index,
							occurrence: actorPoolWorkerOccurrencePath(record.occurrence, index),
							currentState: liveDefinition.worker.initial,
							status: "idle" as const,
						})),
						status: "idle",
					};
				} else {
					projection.actors[record.occurrence] = {
						declaration: record.declaration,
						logicalOccurrence,
						occurrence: record.occurrence,
						generation: record.generation,
						...(record.owner === undefined ? {} : { owner: record.owner }),
						input: record.input,
						definition: record.definition as ActorDeclarationAst,
						currentState: liveDefinition.initial,
						mailbox: [],
						status: "idle",
					};
				}
				break;
			}
			case "actor_messages_enqueued": {
				const actor = assertActorMessagesEnqueued(projection, ast, record);
				const messages = record.messages.map((envelope): ProjectedActorMessage => ({ ...envelope, status: "queued" }));
				actor.mailbox.push(...messages);
				const callId = record.messages[0]?.callId;
				if (callId !== undefined) {
					projection.pendingActorCalls[callId] = record.source.kind === "callBatch"
						? { kind: "batch", callId, callerState: record.source.producerState, occurrence: record.occurrence, messageIds: record.messages.map((message) => message.messageId), messages, status: "enqueued" }
						: { kind: "singleton", callId, callerState: record.source.producerState, occurrence: record.occurrence, messageId: record.messages[0]!.messageId, messages, status: "enqueued" };
				}
				const producer = record.messages[0]?.producerState;
				if (producer !== undefined) {
					projection.actorProducerVisits[producer] = record.messages[0]!.producerVisit;
					advanceActorProducerAfterEnqueue(projection, ast, producer, abandoned);
				}
				break;
			}
			case "actor_message": {
				if (record.kind === "accepted") {
					const { endpoint, worker, head, target } = assertActorMessageAccepted(projection, ast, record);
					endpoint.mailbox.shift();
					head.status = "accepted";
					head.receiveState = record.receiveState;
					if (record.workerIndex !== undefined) head.workerIndex = record.workerIndex;
					if (worker === undefined) {
						const actor = endpoint as ProjectedActorOccurrence;
						actor.currentMessage = head;
						applyActorInputForEntry(projection, ast, endpoint, target);
						actor.currentState = target;
						actor.status = actor.status === "closing" || actor.status === "draining" ? "draining" : "busy";
					} else {
						worker.currentMessage = head;
						applyActorInputForEntry(projection, ast, endpoint, target, worker);
						worker.currentState = target;
						worker.status = endpoint.status === "closing" || endpoint.status === "draining" ? "draining" : "busy";
						refreshPoolStatus(endpoint as ProjectedActorPoolOccurrence);
					}
					if (head.callId !== undefined) {
						syncPendingCallMessage(projection, head);
						refreshPendingBatchStatus(projection, head.callId);
					}
					break;
				}
				if (record.kind === "replied") {
					const { current } = assertActorMessageReplied(projection, ast, record);
					current.status = "replied";
					if (record.replyEvent !== undefined) current.replyEvent = record.replyEvent;
					if (Object.hasOwn(record, "output")) current.replyOutput = record.output;
					if (current.callId !== undefined) syncPendingCallMessage(projection, current);
					break;
				}
				const { endpoint, worker, current, reply } = assertActorMessageSettled(projection, ast, record);
				current.status = "settled";
				if (worker === undefined) {
					const actor = endpoint as ProjectedActorOccurrence;
					delete actor.currentMessage;
					actor.currentState = reply.target;
					actor.status = actor.status === "closing" || actor.status === "draining" ? "draining" : "idle";
				} else {
					delete worker.currentMessage;
					worker.currentState = reply.target;
					worker.status = endpoint.status === "closing" || endpoint.status === "draining" ? "draining" : "idle";
					refreshPoolStatus(endpoint as ProjectedActorPoolOccurrence);
				}
				if (current.callId !== undefined) {
					syncPendingCallMessage(projection, current);
					refreshPendingBatchStatus(projection, current.callId);
				}
				break;
			}
			case "actor_call_resolved": {
				assertActorCallResolved(projection, record);
				delete projection.pendingActorCalls[record.callId];
				if (Object.hasOwn(record, "output")) projection.results[record.callerState] = record.output;
				advanceActorProducerAfterReply(projection, ast, record.callerState, record.replyEvent, record.output, abandoned);
				break;
			}
			case "actor_batch_call_resolved": {
				const outputs = assertActorBatchCallResolved(projection, record);
				delete projection.pendingActorCalls[record.callId];
				projection.results[record.callerState] = outputs;
				advanceActorProducerAfterReply(projection, ast, record.callerState, undefined, outputs, abandoned);
				break;
			}
			case "actor_scope": {
				const actor = assertActorScope(projection, record);
				if (record.kind === "closing") {
					if (actor.definition.kind === "actorPool") {
						const pool = actor as ProjectedActorPoolOccurrence;
						pool.status = pool.mailbox.length === 0 && pool.workers.every((worker) => worker.currentMessage === undefined) ? "closing" : "draining";
						for (const worker of pool.workers) worker.status = "draining";
					} else {
						const ordinary = actor as ProjectedActorOccurrence;
						ordinary.status = ordinary.currentMessage === undefined && ordinary.mailbox.length === 0 ? "closing" : "draining";
					}
				} else {
					actor.status = "stopped";
					if (actor.definition.kind === "actorPool") for (const worker of (actor as ProjectedActorPoolOccurrence).workers) worker.status = "stopped";
					completeParallels(projection, ast);
				}
				break;
			}
			case "spawned": {
				// The placeholder guard mirrors invoke: a spawn for a map that is no longer active
				// lost a race and is skipped.
				if (!projection.activeLeaves.includes(record.path)) {
					recordSkipped(skipped, projection, record, record.path);
					break;
				}
				const node = nodeAt(ast, record.path);
				if (node?.kind !== "map") {
					throw new Error(`Spawned record for non-map state ${record.path}`);
				}
				projection.spawns[record.path] = record.instances;
				const keys = Object.keys(record.instances);
				const entered = keys.length === 0 ? siblingPath(record.path, node.onDone) : undefined;
				projection.activeLeaves = [
					...projection.activeLeaves.filter((leaf) => leaf !== record.path),
					// An empty fan-out completes the map immediately, like a compound reaching final.
					...(entered === undefined
						? keys.flatMap((key) => enterState(ast, `${record.path}#${key}`))
						: enterState(ast, entered)),
				];
				if (entered === undefined) {
					for (const key of keys) {
						// Finite maps share the occurrence input substrate with explicit actors. The
						// spawn fact is still the only birth fact and pins this immutable pair.
						projection.inputs[`${record.path}#${key}`] = { key, item: record.instances[key] };
						applyInputsForEntry(projection, ast, `${record.path}#${key}`);
					}
				} else {
					applyInputsForEntry(projection, ast, entered);
				}
				completeParallels(projection, ast);
				break;
			}
			case "user_interaction": {
				if (record.kind === "opened") {
					const pending = projection.pendingActions.find((entry) =>
						sameActionUid(entry.actionUid, record.actionUid) &&
						(entry.phase === "running" || entry.phase === "rejected"),
					);
					if (pending === undefined || pending.seqId !== record.phaseSeqId) {
						throw new Error(`No matching pending user phase for opened gate in state ${record.actionUid.state}`);
					}
					const node = actionStateAt(ast, record.actionUid.state);
					if (node?.kind !== "state" || node.action.kind !== "user") {
						throw new Error(`Opened user interaction for non-user state ${record.actionUid.state}`);
					}
					if (pending.gateSeqId !== undefined) throw new Error(`User phase in state ${record.actionUid.state} already has an opened gate`);
					pending.gateSeqId = record.seqId;
					projection.openUserInteractions[record.seqId] = { opened: record, status: "open" };
					break;
				}
				const gate = projection.openUserInteractions[record.gateSeqId];
				const pending = projection.pendingActions.find((entry) =>
					sameActionUid(entry.actionUid, record.actionUid) &&
					(entry.phase === "running" || entry.phase === "rejected") &&
					entry.gateSeqId === record.gateSeqId,
				);
				if (gate === undefined || gate.status !== "open" || pending === undefined || !sameActionUid(gate.opened.actionUid, record.actionUid)) {
					throw new Error(`No open user interaction ${record.gateSeqId} for state ${record.actionUid.state}`);
				}
				const node = actionStateAt(ast, record.actionUid.state);
				if (node?.kind !== "state" || node.action.kind !== "user") {
					throw new Error(`Resolved user interaction for non-user state ${record.actionUid.state}`);
				}
				if (record.event.type === "FAILED" || !gate.opened.events.includes(record.event.type)) {
					throw new Error(`Event '${record.event.type}' is not allowed for user interaction ${record.gateSeqId}`);
				}
				delete projection.openUserInteractions[record.gateSeqId];
				applyActionCompletion(projection, ast, record.actionUid, record.event, record.seqId, abandoned);
				break;
			}
			case "state_action":
				switch (record.kind) {
					case "invoke":
						if (!isRecord(record.definition)) {
							throw new Error(`Invoke record for state ${record.actionUid.state} is missing action definition provenance`);
						}
						if (isActionActive(projection, ast, record.actionUid.state)) {
							assertActiveActionUid(ast, record.actionUid.state, record.actionUid, "invoke");
							const key = actionUidKey(record.actionUid);
							const visitId = (projection.stateVisits[key] ?? 0) + 1;
							projection.stateVisits[key] = visitId;
							projection.pendingActions.push({
								actionUid: record.actionUid,
								visitId,
								seqId: record.seqId,
								invokeSeqId: record.seqId,
								sessionId: record.sessionId,
								timestamp: record.timestamp,
								phase: "running",
							});
						} else {
							recordSkipped(skipped, projection, record, record.actionUid.state);
						}
						break;
					case "complete":
						applyActionCompletion(projection, ast, record.actionUid, record.event, record.seqId, abandoned, skipped, record);
						break;
					case "timer_fired":
						// The active-leaf guard makes race losers no-ops: a completion logged after the
						// timer (or vice versa) refers to a state that is no longer active and is skipped.
						if (isActionActive(projection, ast, record.actionUid.state)) {
							assertActiveActionUid(ast, record.actionUid.state, record.actionUid, "timer_fired");
							removePendingAction(projection, record.actionUid);
							applyAfterTransition(projection, ast, record.actionUid.state, abandoned);
						} else {
							recordSkipped(skipped, projection, record, record.actionUid.state);
						}
						break;
					case "validated": {
						const validating = projection.pendingActions.find(
							(pending): pending is Extract<PendingAction, { phase: "validating" }> =>
								pending.phase === "validating" && sameActionUid(pending.actionUid, record.actionUid),
						);
						if (!validating) {
							throw new Error(`No pending validation for action in state ${record.actionUid.state}`);
						}
						if (record.outcome === true) {
							recordResult(projection, record.actionUid.state, validating.event);
							removePendingAction(projection, record.actionUid);
							applyTransition(projection, ast, record.actionUid.state, record.event.type, abandoned, record.event);
							break;
						}
						const node = actionStateAt(ast, record.actionUid.state);
						const retries = node?.retries;
						const validationAttempts = validating.validationAttempts + 1;
						if (retries !== undefined && validationAttempts > retries) {
							// The machine appends failure_intent in the same durable transaction. Keep the
							// action pending so terminalization can issue a best-effort runtime cancel.
							break;
						}
						projection.pendingActions[projection.pendingActions.indexOf(validating)] = {
							actionUid: validating.actionUid,
							visitId: validating.visitId,
							seqId: record.seqId,
							invokeSeqId: validating.invokeSeqId,
							sessionId: validating.sessionId,
							phase: "rejected",
							event: validating.event,
							validationAttempts,
							...(typeof record.outcome === "object" ? { reason: record.outcome.reason } : {}),
						};
						break;
					}
				}
				break;
		}
		projection.seqId = Math.max(projection.seqId, record.seqId);
	}
	return projection;
}

export function projectedActorEndpoints(projection: BranchProjection): ProjectedActorEndpointOccurrence[] {
	return [...Object.values(projection.actors), ...Object.values(projection.actorPools)];
}

export function projectedActorEndpoint(
	projection: BranchProjection,
	occurrence: StatePath,
): ProjectedActorEndpointOccurrence | undefined {
	return projection.actors[occurrence] ?? projection.actorPools[occurrence];
}

/** Live-control messages only; settled non-call history belongs to durable history queries. */
export function projectedActorLiveMessages(
	projection: BranchProjection,
	endpoint: ProjectedActorEndpointOccurrence,
): ProjectedActorMessage[] {
	const messages = new Map<string, ProjectedActorMessage>();
	for (const message of endpoint.mailbox) messages.set(message.messageId, message);
	if ("workers" in endpoint) {
		for (const worker of endpoint.workers) {
			if (worker.currentMessage !== undefined) messages.set(worker.currentMessage.messageId, worker.currentMessage);
		}
	} else if (endpoint.currentMessage !== undefined) {
		messages.set(endpoint.currentMessage.messageId, endpoint.currentMessage);
	}
	for (const call of Object.values(projection.pendingActorCalls)) {
		if (call.occurrence !== endpoint.occurrence) continue;
		for (const message of call.messages) messages.set(message.messageId, message);
	}
	return [...messages.values()];
}

function actorExecutionForContext(projection: BranchProjection, context: ReturnType<typeof actorContextForState>) {
	assert(context !== undefined);
	const endpoint = projectedActorEndpoint(projection, context.endpointOccurrence);
	assert(endpoint !== undefined, `Actor endpoint ${context.endpointOccurrence} is not projected`);
	const worker = context.workerIndex === undefined
		? undefined
		: endpoint.definition.kind === "actorPool" ? (endpoint as ProjectedActorPoolOccurrence).workers[context.workerIndex] : undefined;
	return { endpoint, worker };
}

function executionCurrentState(endpoint: ProjectedActorEndpointOccurrence, worker?: ProjectedActorPoolWorker): StatePath {
	return worker?.currentState ?? (endpoint as ProjectedActorOccurrence).currentState;
}

function setExecutionCurrentState(endpoint: ProjectedActorEndpointOccurrence, target: StatePath, worker?: ProjectedActorPoolWorker): void {
	if (worker !== undefined) worker.currentState = target;
	else (endpoint as ProjectedActorOccurrence).currentState = target;
}

function refreshPoolStatus(pool: ProjectedActorPoolOccurrence): void {
	if (pool.status === "closing" || pool.status === "draining") {
		pool.status = pool.mailbox.length === 0 && pool.workers.every((worker) => worker.currentMessage === undefined) ? "closing" : "draining";
		return;
	}
	pool.status = pool.workers.some((worker) => worker.currentMessage !== undefined) || pool.mailbox.length > 0 ? "busy" : "idle";
}

function syncPendingCallMessage(projection: BranchProjection, message: ProjectedActorMessage): void {
	if (message.callId === undefined) return;
	const pending = projection.pendingActorCalls[message.callId];
	const retained = pending?.messages.find((candidate) => candidate.messageId === message.messageId);
	if (retained !== undefined && retained !== message) Object.assign(retained, message);
}

function refreshPendingBatchStatus(projection: BranchProjection, callId: string): void {
	const pending = projection.pendingActorCalls[callId];
	if (pending === undefined) return;
	if (pending.kind === "singleton") {
		pending.status = "accepted";
		return;
	}
	const accepted = pending.messages.filter((message) => message.status !== "queued").length;
	const settled = pending.messages.filter((message) => message.status === "settled").length;
	pending.status = settled > 0 || (accepted > 0 && accepted < pending.messages.length) ? "partial" : accepted === pending.messages.length ? "accepted" : "enqueued";
}

function applyActionCompletion(
	projection: BranchProjection,
	ast: ChartAst,
	actionUid: ActionUID,
	event: ChartEvent,
	seqId: number,
	abandoned: PendingAction[],
	skipped?: ProjectionSkippedRecord[],
	record?: DurableLogRecord,
): void {
	if (!isActionActive(projection, ast, actionUid.state)) {
		if (skipped !== undefined && record !== undefined) recordSkipped(skipped, projection, record, actionUid.state);
		else throw new Error(`User interaction completion for inactive state ${actionUid.state}`);
		return;
	}
	assertActiveActionUid(ast, actionUid.state, actionUid, "complete");
	if (record?.type === "state_action" && record.kind === "complete" && record.artifacts !== undefined) {
		for (const [path, pin] of Object.entries(record.artifacts)) projection.artifactPins[path] = pin;
	}
	const state = actionStateAt(ast, actionUid.state);
	if (state?.kind === "state" && state.validate !== undefined && event.type !== "FAILED") {
		const previous = projection.pendingActions.find((pending) => sameActionUid(pending.actionUid, actionUid));
		if (previous === undefined) throw new Error(`No pending invocation for completion in ${actionUid.state}`);
		const validationAttempts = previous.phase === "rejected" ? previous.validationAttempts : 0;
		removePendingAction(projection, actionUid);
		projection.pendingActions.push({
			actionUid,
			visitId: previous.visitId,
			seqId,
			invokeSeqId: previous.invokeSeqId,
			sessionId: previous.sessionId,
			phase: "validating",
			event,
			validationAttempts,
		});
		return;
	}
	recordResult(projection, actionUid.state, event);
	removePendingAction(projection, actionUid);
	applyTransition(projection, ast, actionUid.state, event.type, abandoned, event);
}

// A result exists once the completion is accepted (directly, or by a positive verdict).
function recordResult(projection: BranchProjection, state: StatePath, event: ChartEvent): void {
	if ("output" in event && event.output !== undefined) {
		projection.results[state] = event.output;
	}
}

function recordSkipped(
	skipped: ProjectionSkippedRecord[],
	projection: BranchProjection,
	record: DurableLogRecord,
	state: StatePath,
): void {
	skipped.push({ record, state, reason: "inactive", activeLeaves: [...projection.activeLeaves] });
}

function removePendingAction(projection: BranchProjection, actionUid: ActionUID): void {
	const index = projection.pendingActions.findIndex((pending) => sameActionUid(pending.actionUid, actionUid));
	if (index !== -1) {
		const [removed] = projection.pendingActions.splice(index, 1);
		if (removed?.gateSeqId !== undefined) delete projection.openUserInteractions[removed.gateSeqId];
	}
}

function applyAfterTransition(
	projection: BranchProjection,
	ast: ChartAst,
	leaf: StatePath,
	abandoned: PendingAction[],
): void {
	const state = actionStateAt(ast, leaf);
	assert(state?.after !== undefined, `No after transition in state ${leaf}`);
	const actorContext = actorContextForState(ast, leaf);
	if (actorContext !== undefined) {
		const { endpoint, worker } = actorExecutionForContext(projection, actorContext);
		assert(executionCurrentState(endpoint, worker) === actorContext.localState, `Actor state ${leaf} is not active`);
		applyActorInputForEntry(projection, ast, endpoint, state.after.target, worker);
		setExecutionCurrentState(endpoint, state.after.target, worker);
		return;
	}
	const target = siblingPath(leaf, state.after.target);
	applyInputsForEntry(projection, ast, target);
	exitAndEnter(projection, ast, leaf, target, abandoned);
}

// Transitions are not logged: recompute the move from the chart AST. The handler's level decides
// the exit scope; its target is a sibling at that level.
function applyTransition(
	projection: BranchProjection,
	ast: ChartAst,
	fromLeaf: StatePath,
	eventType: string,
	abandoned: PendingAction[],
	event: ChartEvent,
): void {
	const actorContext = actorContextForState(ast, fromLeaf);
	if (actorContext !== undefined) {
		const { endpoint, worker } = actorExecutionForContext(projection, actorContext);
		assert(executionCurrentState(endpoint, worker) === actorContext.localState, `Actor state ${fromLeaf} is not active`);
		assert(actorContext.node.kind === "state", `Actor state ${fromLeaf} cannot emit action event ${eventType}`);
		const transition = actorContext.node.transitions[eventType];
		assert(transition !== undefined, `No actor transition for event type ${eventType} in state ${fromLeaf}`);
		applyActorInputForEntry(projection, ast, endpoint, transition.target, worker, { transition, event });
		setExecutionCurrentState(endpoint, transition.target, worker);
		return;
	}
	const handler = findHandler(ast, fromLeaf, eventType);
	if (!handler) {
		throw new Error(`No transition for event type ${eventType} in state ${fromLeaf}`);
	}
	const target = siblingPath(handler.path, handler.transition.target);
	applyInputsForEntry(projection, ast, target, { transition: handler.transition, event });
	exitAndEnter(projection, ast, handler.path, target, abandoned);
}

function advanceActorProducerAfterEnqueue(
	projection: BranchProjection,
	ast: ChartAst,
	statePath: StatePath,
	abandoned: PendingAction[],
): void {
	const node = actorProducerNode(ast, statePath);
	if (node.kind === "call" || node.kind === "callBatch") return;
	applyActorProducerTransition(
		projection,
		ast,
		statePath,
		{ target: node.target },
		{ type: "ACTOR_REPLY" },
		abandoned,
	);
}

function advanceActorProducerAfterReply(
	projection: BranchProjection,
	ast: ChartAst,
	statePath: StatePath,
	replyEvent: string | undefined,
	output: unknown,
	abandoned: PendingAction[],
): void {
	const node = actorProducerNode(ast, statePath);
	assert(node.kind === "call" || node.kind === "callBatch", `Fire-and-forget send state ${statePath} cannot await a reply`);
	const transition = node.target !== undefined
		? { target: node.target }
		: replyEvent === undefined
			? undefined
			: node.transitions[replyEvent];
	assert(transition !== undefined, `Actor call ${statePath} has no route for reply '${replyEvent ?? "missing"}'`);
	applyActorProducerTransition(
		projection,
		ast,
		statePath,
		transition,
		{ type: replyEvent ?? "ACTOR_REPLY", ...(output === undefined ? {} : { output }) },
		abandoned,
	);
}

function actorProducerNode(ast: ChartAst, statePath: StatePath) {
	const actorContext = actorContextForState(ast, statePath);
	const node = actorContext?.node ?? nodeAt(ast, statePath);
	assert(node?.kind === "send" || node?.kind === "sendBatch" || node?.kind === "call" || node?.kind === "callBatch", `Actor message fact has invalid producer state ${statePath}`);
	return node;
}

function applyActorProducerTransition(
	projection: BranchProjection,
	ast: ChartAst,
	statePath: StatePath,
	transition: TransitionAst,
	event: ChartEvent,
	abandoned: PendingAction[],
): void {
	const actorContext = actorContextForState(ast, statePath);
	if (actorContext !== undefined) {
		const { endpoint, worker } = actorExecutionForContext(projection, actorContext);
		assert(executionCurrentState(endpoint, worker) === actorContext.localState, `Actor producer state ${statePath} is not active`);
		applyActorInputForEntry(projection, ast, endpoint, transition.target, worker, { transition, event });
		setExecutionCurrentState(endpoint, transition.target, worker);
		return;
	}
	assert(projection.activeLeaves.includes(statePath), `Actor producer state ${statePath} is not active`);
	const target = siblingPath(statePath, transition.target);
	applyInputsForEntry(projection, ast, target, { transition, event });
	exitAndEnter(projection, ast, statePath, target, abandoned);
}

// The exit scope is the handler's own state: every active leaf under it leaves the
// configuration. Pending work whose leaf left is dropped and reported as abandoned — its own
// records never bring it here (complete/validated/timer_fired remove the entry explicitly before
// the transition), so everything in `abandoned` had a live session that must be killed.
function exitAndEnter(
	projection: BranchProjection,
	ast: ChartAst,
	exitPath: StatePath,
	targetPath: StatePath,
	abandoned: PendingAction[],
): void {
	projection.activeLeaves = [
		...projection.activeLeaves.filter((leaf) => !underScope(leaf, exitPath)),
		...enterState(ast, targetPath),
	];
	const kept: PendingAction[] = [];
	for (const pending of projection.pendingActions) {
		// Main-chart transitions must not abandon an independently active actor-local action.
		// isActionActive checks both ordinary leaves and the actor occurrence's current state.
		if (isActionActive(projection, ast, pending.actionUid.state)) {
			kept.push(pending);
		} else {
			abandoned.push(pending);
			if (pending.gateSeqId !== undefined) delete projection.openUserInteractions[pending.gateSeqId];
		}
	}
	projection.pendingActions = kept;
	completeParallels(projection, ast);
}

// Innermost-first: the leaf that emitted the event handles it, or the closest ancestor declaring
// it. Events are not broadcast — a completion belongs to exactly one leaf, so parallel regions
// never conflict by construction.
function findHandler(
	ast: ChartAst,
	fromPath: StatePath,
	eventType: string,
): { path: StatePath; node: StateAst; transition: TransitionAst } | undefined {
	let path: StatePath | undefined = fromPath;
	while (path !== undefined) {
		const node: StateAst | undefined = nodeAt(ast, path);
		if (node === undefined) {
			throw new Error(`Broken parent chain: state ${path} not found`);
		}
		if (node.kind !== "final") {
			const transition = node.transitions[eventType];
			if (transition !== undefined) {
				// A map's transitions belong to the container, not the instance the event bubbled
				// out of: the handler scope drops the instance key, so the exit aborts ALL instances.
				return { path: node.kind === "map" ? stripLastKey(path) : path, node, transition };
			}
		}
		path = parentPath(path);
	}
	return undefined;
}

export function hasTransition(ast: ChartAst, fromPath: StatePath, eventType: string): boolean {
	return findHandler(ast, fromPath, eventType) !== undefined;
}

// Every event type a completion from this leaf can take somewhere: the leaf's own transitions
// plus everything catchable by its ancestors (bubbling), innermost first. This is what the
// machine would accept — told to the agent upfront instead of learned by rejection.
export function allowedEvents(ast: ChartAst, fromPath: StatePath): string[] {
	const events: string[] = [];
	const seen = new Set<string>();
	let path: StatePath | undefined = fromPath;
	while (path !== undefined) {
		const node: StateAst | undefined = nodeAt(ast, path);
		if (node === undefined) {
			throw new Error(`Broken parent chain: state ${path} not found`);
		}
		if (node.kind !== "final") {
			for (const eventType of Object.keys(node.transitions)) {
				if (!seen.has(eventType)) {
					seen.add(eventType);
					events.push(eventType);
				}
			}
		}
		path = parentPath(path);
	}
	return events;
}

// Entering a state resolves it to active leaves: compounds and regions drill down their initial
// chain, parallels enter every region, and a final child immediately completes its compound
// container through onDone unless that compound owns actors. Actor-owning compounds hold the
// final leaf until their projected occurrences stop. A final in a region stays as-is: it marks
// the region complete for the join.
function enterState(ast: ChartAst, path: StatePath): StatePath[] {
	const node = nodeAt(ast, path);
	if (node === undefined) {
		throw new Error(`Unknown state ${path}`);
	}
	if (node.kind === "compound" || node.kind === "region") {
		return enterState(ast, childPath(path, node.initial));
	}
	if (node.kind === "map") {
		// The bare map path rests as a placeholder until its spawned fact pins the instances; an
		// instance path ("#key") drills down like a compound.
		return lastSegmentKey(path) === undefined ? [path] : enterState(ast, childPath(path, node.initial));
	}
	if (node.kind === "parallel") {
		return node.regions.flatMap((region) => enterState(ast, childPath(path, region)));
	}
	const parent = parentPath(path);
	if (node.kind === "final" && parent !== undefined) {
		const container = nodeAt(ast, parent);
		if (container === undefined) {
			throw new Error(`Broken parent chain: state ${parent} not found`);
		}
		if (container.kind === "compound") {
			const ownsActors = Object.values(ast.actors).some((actor) => actor.owner === templatePath(parent));
			if (!ownsActors) return enterState(ast, siblingPath(parent, container.onDone));
		}
	}
	return [path];
}

// A parallel or map fan-out completes when every active leaf and owned actor under it is final;
// an actor-owning compound completes when its direct final child is held and its created actor
// occurrences have stopped. Innermost first, repeated together until stable — completing one may
// complete an outer.
function completeParallels(projection: BranchProjection, ast: ChartAst): void {
	for (;;) {
		const parallel = findCompletedParallel(projection, ast);
		const compound = findCompletedCompound(projection, ast);
		const done = parallel === undefined
			? compound
			: compound === undefined || parallel.path.length >= compound.path.length ? parallel : compound;
		if (done === undefined) return;
		projection.activeLeaves = [
			...projection.activeLeaves.filter((leaf) => !underScope(leaf, done.path)),
			...enterState(ast, done.target),
		];
		applyInputsForEntry(projection, ast, done.target);
	}
}

function findCompletedParallel(
	projection: BranchProjection,
	ast: ChartAst,
): { path: StatePath; target: StatePath } | undefined {
	const candidates: { path: StatePath; target: StatePath }[] = [];
	const seen = new Set<StatePath>();
	for (const leaf of projection.activeLeaves) {
		let path = parentPath(leaf);
		while (path !== undefined) {
			const node = nodeAt(ast, path);
			if (node === undefined) {
				throw new Error(`Broken parent chain: state ${path} not found`);
			}
			if (node.kind === "parallel" || node.kind === "map") {
				// A map joins over ALL its instances: the scope is the container with the instance
				// key stripped, so every instance's leaves must be final.
				const scope = node.kind === "map" ? stripLastKey(path) : path;
				if (!seen.has(scope)) {
					seen.add(scope);
					candidates.push({ path: scope, target: siblingPath(scope, node.onDone) });
				}
			}
			path = parentPath(path);
		}
	}
	candidates.sort((a, b) => b.path.length - a.path.length);
	return candidates.find(({ path }) => {
		const leaves = projection.activeLeaves.filter((leaf) => underScope(leaf, path));
		const actors = projectedActorEndpoints(projection).filter((actor) => actor.owner !== undefined && underScope(actor.owner, path));
		const mapOwnedDeclarations = Object.values(ast.actors).filter((actor) => actor.owner === templatePath(path));
		const expectedActors = mapOwnedDeclarations.length * Object.keys(projection.spawns[path] ?? {}).length;
		return (
			leaves.length > 0 &&
			leaves.every((leaf) => nodeAt(ast, leaf)?.kind === "final") &&
			actors.length >= expectedActors &&
			actors.every((actor) => actor.status === "stopped")
		);
	});
}

function findCompletedCompound(
	projection: BranchProjection,
	ast: ChartAst,
): { path: StatePath; target: StatePath } | undefined {
	const candidates: { path: StatePath; target: StatePath }[] = [];
	for (const leaf of projection.activeLeaves) {
		if (nodeAt(ast, leaf)?.kind !== "final") continue;
		const path = parentPath(leaf);
		if (path === undefined) continue;
		const node = nodeAt(ast, path);
		if (node?.kind !== "compound") continue;
		if (!Object.values(ast.actors).some((actor) => actor.owner === templatePath(path))) continue;
		const actors = projectedActorEndpoints(projection).filter((actor) => actor.owner === path);
		if (actors.every((actor) => actor.status === "stopped")) {
			candidates.push({ path, target: siblingPath(path, node.onDone) });
		}
	}
	return candidates.sort((left, right) => right.path.length - left.path.length)[0];
}

type ActorCreatedRecord = Extract<DurableLogRecord, { type: "actor_created" }>;
type ActorMessagesEnqueuedRecord = Extract<DurableLogRecord, { type: "actor_messages_enqueued" }>;
type ActorMessageAcceptedRecord = Extract<DurableLogRecord, { type: "actor_message"; kind: "accepted" }>;
type ActorMessageRepliedRecord = Extract<DurableLogRecord, { type: "actor_message"; kind: "replied" }>;
type ActorMessageSettledRecord = Extract<DurableLogRecord, { type: "actor_message"; kind: "settled" }>;
type ActorCallResolvedRecord = Extract<DurableLogRecord, { type: "actor_call_resolved" }>;
type ActorBatchCallResolvedRecord = Extract<DurableLogRecord, { type: "actor_batch_call_resolved" }>;
type ActorScopeRecord = Extract<DurableLogRecord, { type: "actor_scope" }>;

function assertFailureIntent(projection: BranchProjection): void {
	assert.equal(projection.failure, undefined, "A run may contain only one failure intent");
}

function assertActorCreated(
	projection: BranchProjection,
	ast: ChartAst,
	record: ActorCreatedRecord,
): { liveDefinition: ActorEndpointDeclarationAst; logicalOccurrence: StatePath } {
	assert.equal(projectedActorEndpoint(projection, record.occurrence), undefined, `Actor occurrence ${record.occurrence} was created twice`);
	const liveDefinition = liveActorDeclaration(ast, record.declaration, record.occurrence);
	assert.equal(record.definition.kind, liveDefinition.kind, `Actor creation ${record.occurrence} endpoint kind changed`);
	assert.equal(record.definition.path, record.declaration, `Actor creation ${record.occurrence} has mismatched definition provenance`);
	assert(Number.isInteger(record.generation) && record.generation >= 1, `Actor occurrence ${record.occurrence} has invalid generation`);
	const declaredOwner: StatePath | undefined = record.definition.owner;
	assert(
		(declaredOwner === undefined) === (record.owner === undefined) &&
			(declaredOwner === undefined || record.owner === undefined || templatePath(record.owner) === declaredOwner),
		`Actor creation ${record.occurrence} has mismatched owner provenance`,
	);
	if (record.owner !== undefined) {
		assert(declaredOwner !== undefined, `Actor creation ${record.occurrence} has mismatched owner provenance`);
		const ownerNode = nodeAt(ast, declaredOwner);
		if (ownerNode?.kind === "map") {
			const key = lastSegmentKey(record.owner);
			const spawned = projection.spawns[stripLastKey(record.owner)];
			assert(
				key !== undefined && spawned !== undefined && Object.prototype.hasOwnProperty.call(spawned, key),
				`Actor creation ${record.occurrence} targets an owner map occurrence that was not spawned`,
			);
		}
		assert(
			projection.activeLeaves.some((leaf) => underScope(leaf, record.owner!)),
			`Actor creation ${record.occurrence} targets an owner occurrence that is not active`,
		);
	}
	const logicalOccurrence = actorLogicalOccurrencePath(record.occurrence, record.generation);
	assert.equal(
		logicalOccurrence,
		actorOccurrencePath(record.definition, record.owner),
		`Actor creation ${record.occurrence} has mismatched logical occurrence provenance`,
	);
	assert.equal(
		record.occurrence,
		actorGenerationPath(logicalOccurrence, record.generation),
		`Actor creation ${record.occurrence} does not match its generation`,
	);
	const priorGeneration = projectedActorEndpoints(projection)
		.filter((entry) => entry.logicalOccurrence === logicalOccurrence)
		.sort((left, right) => right.generation - left.generation)[0];
	assert.equal(
		record.generation,
		(priorGeneration?.generation ?? 0) + 1,
		`Actor occurrence ${logicalOccurrence} generation is not sequential`,
	);
	assert(
		priorGeneration === undefined || priorGeneration.status === "stopped",
		`Actor occurrence ${logicalOccurrence} re-entered before its prior generation stopped`,
	);
	return { liveDefinition, logicalOccurrence };
}

function assertActorMessagesEnqueued(
	projection: BranchProjection,
	ast: ChartAst,
	record: ActorMessagesEnqueuedRecord,
): ProjectedActorEndpointOccurrence {
	const actor = projectedActorEndpoint(projection, record.occurrence);
	assert(actor !== undefined, `Message enqueue targets unknown actor ${record.occurrence}`);
	assert.equal(record.generation, actor.generation, `Message enqueue targets the wrong generation of ${actor.logicalOccurrence}`);
	const first = record.messages[0];
	assert(first !== undefined, "Actor enqueue transaction must contain at least one message");
	assert(
		record.source.targetDeclaration === actor.declaration && record.source.event === first.event,
		"Message enqueue has inconsistent target/event provenance",
	);
	assert(
		record.source.producerState === first.producerState &&
			record.messages.every((message) => message.producerState === record.source.producerState && message.event === record.source.event),
		"Message enqueue has inconsistent producer provenance",
	);
	const selfSource = (record.source.definition.kind === "send" || record.source.definition.kind === "sendBatch") && record.source.definition.self === true;
	if (selfSource) {
		const producerContext = actorContextForState(ast, record.source.producerState);
		assert(producerContext !== undefined, `Self-send producer ${record.source.producerState} is not an actor workflow state`);
		const producerExecution = actorExecutionForContext(projection, producerContext);
		const producerCurrent = producerExecution.worker?.currentMessage ?? (producerExecution.endpoint as ProjectedActorOccurrence).currentMessage;
		assert(producerCurrent !== undefined, `Self-send producer ${record.source.producerState} has no current message`);
		assert.equal(executionCurrentState(producerExecution.endpoint, producerExecution.worker), producerContext.localState, `Self-send producer ${record.source.producerState} is not current`);
		assert.equal(record.source.targetDeclaration, producerContext.declaration.path, `Self-send producer ${record.source.producerState} changed declaration`);
		assert.equal(record.occurrence, producerContext.endpointOccurrence, `Self-send producer ${record.source.producerState} escaped its actor occurrence`);
	}
	assert(
		actor.status !== "stopped" && actor.status !== "cancelled" && actor.status !== "failed",
		`Message enqueue targets stopped actor ${record.occurrence}`,
	);
	if (actor.status === "closing" || actor.status === "draining") {
		const producerContext = actorContextForState(ast, record.source.producerState);
		const producerExecution = producerContext === undefined ? undefined : actorExecutionForContext(projection, producerContext);
		const producerMessage = producerExecution?.worker?.currentMessage ?? (producerExecution?.endpoint as ProjectedActorOccurrence | undefined)?.currentMessage;
		assert(producerMessage !== undefined, `External message enqueue targets closing actor ${record.occurrence}`);
	}
	const expectedProducerVisit = (projection.actorProducerVisits[record.source.producerState] ?? 0) + 1;
	assert(
		record.messages.every((message, index) =>
			message.producerVisit === expectedProducerVisit &&
			message.batchIndex === index &&
			message.messageId === `${record.source.producerState}:message:${expectedProducerVisit}:${index}`),
		`Actor enqueue identity must use producer ${record.source.producerState} visit ${expectedProducerVisit} with canonical batch indexes`,
	);
	const singleton = record.source.kind === "send" || record.source.kind === "call";
	assert(!singleton || record.messages.length === 1, `${record.source.kind} must enqueue exactly one message`);
	const expectsCall = record.source.kind === "call" || record.source.kind === "callBatch";
	const callId = first.callId;
	const expectedCallId = `${record.source.producerState}:call:${expectedProducerVisit}`;
	assert(expectsCall
		? callId === expectedCallId && record.messages.every((message) => message.callId === expectedCallId)
		: record.messages.every((message) => message.callId === undefined), `Actor ${record.source.kind} call correlation is inconsistent`);
	if (callId !== undefined) assert(projection.pendingActorCalls[callId] === undefined, `Duplicate actor call id ${callId}`);
	const ids = new Set(projectedActorLiveMessages(projection, actor).map((message) => message.messageId));
	for (const envelope of record.messages) {
		assert(!ids.has(envelope.messageId), `Duplicate actor message id ${envelope.messageId}`);
		ids.add(envelope.messageId);
	}
	return actor;
}

function assertActorMessageAccepted(
	projection: BranchProjection,
	ast: ChartAst,
	record: ActorMessageAcceptedRecord,
) {
	const endpoint = projectedActorEndpoint(projection, record.occurrence);
	assert(endpoint !== undefined, `Actor message fact targets unknown actor ${record.occurrence}`);
	const head = endpoint.mailbox[0];
	assert(head !== undefined && head.messageId === record.messageId, `Actor ${record.occurrence} may accept only its FIFO head`);
	const definition = actorDefinitionForEndpoint(liveActorDeclaration(ast, endpoint.declaration, endpoint.occurrence));
	if (endpoint.definition.kind === "actorPool") {
		assert(record.workerIndex !== undefined && Number.isInteger(record.workerIndex), `Pool ${record.occurrence} accepted without workerIndex`);
		const pool = endpoint as ProjectedActorPoolOccurrence;
		const worker = pool.workers[record.workerIndex];
		assert(worker !== undefined, `Pool ${record.occurrence} workerIndex ${record.workerIndex} is out of range`);
		assert.equal(worker.currentMessage, undefined, `Pool worker ${worker.occurrence} already owns a current message`);
		const eligible = pool.workers.filter((candidate) => {
			if (candidate.currentMessage !== undefined || candidate.status === "stopped" || candidate.status === "failed" || candidate.status === "cancelled") return false;
			const receive = definition.states[candidate.currentState];
			return receive?.kind === "receive" && receive.on[head.event] !== undefined;
		});
		assert(eligible.some((candidate) => candidate.index === worker.index), `Pool ${record.occurrence} selected worker ${worker.index} that is not idle and receive-compatible`);
		const receive = definition.states[worker.currentState];
		assert(receive?.kind === "receive", `Pool worker ${worker.occurrence} accepted outside receive()`);
		assert.equal(record.receiveState, actorStatePath(worker.occurrence, worker.currentState), `Pool worker ${worker.occurrence} accepted from the wrong receive visit`);
		const target = receive.on[head.event];
		assert(target !== undefined, `FIFO head '${head.event}' is unsupported by receive '${worker.currentState}'`);
		return { endpoint, worker, head, target };
	}
	assert.equal(record.workerIndex, undefined, `Ordinary actor ${record.occurrence} must not carry workerIndex`);
	const actor = endpoint as ProjectedActorOccurrence;
	assert.equal(actor.currentMessage, undefined, `Actor ${record.occurrence} already owns a current message`);
	const receive = definition.states[actor.currentState];
	assert(receive?.kind === "receive", `Actor ${record.occurrence} accepted a message outside receive()`);
	assert.equal(record.receiveState, actorStatePath(record.occurrence, actor.currentState), `Actor ${record.occurrence} accepted from the wrong receive visit`);
	const target = receive.on[head.event];
	assert(target !== undefined, `FIFO head '${head.event}' is unsupported by receive '${actor.currentState}'`);
	return { endpoint, worker: undefined, head, target };
}

function assertActorMessageReplied(
	projection: BranchProjection,
	ast: ChartAst,
	record: ActorMessageRepliedRecord,
) {
	const endpoint = projectedActorEndpoint(projection, record.occurrence);
	assert(endpoint !== undefined, `Actor message fact targets unknown actor ${record.occurrence}`);
	const worker = record.workerIndex === undefined ? undefined : endpoint.definition.kind === "actorPool" ? (endpoint as ProjectedActorPoolOccurrence).workers[record.workerIndex] : undefined;
	assert.equal(endpoint.definition.kind === "actorPool", record.workerIndex !== undefined, `Actor reply worker identity does not match endpoint kind`);
	const current = worker?.currentMessage ?? (endpoint as ProjectedActorOccurrence).currentMessage;
	assert(current !== undefined && current.messageId === record.messageId, `Actor ${record.occurrence} replied to a message it does not own`);
	assert.equal(current.workerIndex, record.workerIndex, `Actor ${record.occurrence} reply worker does not match durable assignment`);
	const currentState = worker?.currentState ?? (endpoint as ProjectedActorOccurrence).currentState;
	const reply = actorDefinitionForEndpoint(liveActorDeclaration(ast, endpoint.declaration, endpoint.occurrence)).states[currentState];
	assert(reply?.kind === "reply" && reply.message === current.event && record.message === current.event, `Actor ${record.occurrence} reply does not match its inferred current message`);
	return { endpoint, worker, current };
}

function assertActorMessageSettled(
	projection: BranchProjection,
	ast: ChartAst,
	record: ActorMessageSettledRecord,
) {
	const endpoint = projectedActorEndpoint(projection, record.occurrence);
	assert(endpoint !== undefined, `Actor message fact targets unknown actor ${record.occurrence}`);
	const worker = record.workerIndex === undefined ? undefined : endpoint.definition.kind === "actorPool" ? (endpoint as ProjectedActorPoolOccurrence).workers[record.workerIndex] : undefined;
	assert.equal(endpoint.definition.kind === "actorPool", record.workerIndex !== undefined, `Actor settlement worker identity does not match endpoint kind`);
	const current = worker?.currentMessage ?? (endpoint as ProjectedActorOccurrence).currentMessage;
	assert(current !== undefined && current.messageId === record.messageId && current.status === "replied", `Actor ${record.occurrence} settled before a validated reply`);
	assert.equal(current.workerIndex, record.workerIndex, `Actor ${record.occurrence} settlement worker does not match durable assignment`);
	const currentState = worker?.currentState ?? (endpoint as ProjectedActorOccurrence).currentState;
	const reply = actorDefinitionForEndpoint(liveActorDeclaration(ast, endpoint.declaration, endpoint.occurrence)).states[currentState];
	assert(reply?.kind === "reply", `Actor ${record.occurrence} settled outside reply()`);
	return { endpoint, worker, current, reply };
}

function assertActorCallResolved(projection: BranchProjection, record: ActorCallResolvedRecord): void {
	const call = projection.pendingActorCalls[record.callId];
	assert(
		call?.kind === "singleton" && call.callerState === record.callerState && call.messageId === record.messageId,
		`Actor call result ${record.callId} has no matching pending singleton caller`,
	);
	const message = call.messages.find((entry) => entry.messageId === record.messageId);
	assert(message?.status === "settled", `Actor call result ${record.callId} resolved before its message settled`);
	assert(
		message.callId === record.callId && message.replyEvent === record.replyEvent,
		`Actor call result ${record.callId} does not match the correlated reply`,
	);
	const resolvedHasOutput = Object.hasOwn(record, "output");
	assert.equal(
		resolvedHasOutput,
		Object.hasOwn(message, "replyOutput"),
		`Actor call result ${record.callId} output presence does not match the correlated reply`,
	);
	if (resolvedHasOutput) {
		assert.deepStrictEqual(message.replyOutput, record.output, `Actor call result ${record.callId} output does not match the correlated reply`);
	}
}

function assertActorBatchCallResolved(projection: BranchProjection, record: ActorBatchCallResolvedRecord): unknown[] {
	const call = projection.pendingActorCalls[record.callId];
	assert(call?.kind === "batch" && call.callerState === record.callerState, `Actor batch call result ${record.callId} has no matching pending caller`);
	assert.deepStrictEqual(record.messageIds, call.messageIds, `Actor batch call ${record.callId} resolution order or membership changed`);
	assert(projectedActorEndpoint(projection, call.occurrence) !== undefined, `Actor batch call ${record.callId} targets a missing endpoint`);
	return call.messageIds.map((messageId) => {
		const message = call.messages.find((entry) => entry.messageId === messageId);
		assert(message?.status === "settled", `Actor batch call ${record.callId} resolved before all items settled`);
		assert(Object.hasOwn(message, "replyOutput"), `Actor batch call ${record.callId} item ${messageId} has no single reply output`);
		return message.replyOutput;
	});
}

function assertActorScope(projection: BranchProjection, record: ActorScopeRecord): ProjectedActorEndpointOccurrence {
	const actor = projectedActorEndpoint(projection, record.occurrence);
	assert(actor !== undefined, `Actor scope fact targets unknown actor ${record.occurrence}`);
	if (record.kind === "closing") {
		assert.notEqual(actor.status, "stopped", `Stopped actor ${record.occurrence} cannot close again`);
	} else {
		const busy = actor.definition.kind === "actorPool"
			? (actor as ProjectedActorPoolOccurrence).workers.some((worker) => worker.currentMessage !== undefined)
			: (actor as ProjectedActorOccurrence).currentMessage !== undefined;
		assert(!busy && actor.mailbox.length === 0, `Actor ${record.occurrence} stopped before drain`);
	}
	return actor;
}

function liveActorDeclaration(ast: ChartAst, declaration: StatePath, occurrence: StatePath): ActorEndpointDeclarationAst {
	const live = ast.actors[declaration];
	assert(live !== undefined, `Actor ${occurrence} declaration ${declaration} is missing from the live chart`);
	return live;
}

type EntryEvent = Readonly<{ transition: TransitionAst; event: ChartEvent }>;

function applyActorInputForEntry(
	projection: BranchProjection,
	ast: ChartAst,
	actor: ProjectedActorEndpointOccurrence,
	target: StatePath,
	worker?: ProjectedActorPoolWorker,
	entry?: EntryEvent,
): void {
	const node = actorDefinitionForEndpoint(liveActorDeclaration(ast, actor.declaration, actor.occurrence)).states[target];
	if (node?.kind !== "state" || node.input === undefined) return;
	const occurrence = worker?.occurrence ?? actor.occurrence;
	projection.inputs[actorStatePath(occurrence, target)] = resolveInputValues(node.input, entry, `${occurrence}.${target}`);
}

function applyInputsForEntry(
	projection: BranchProjection,
	ast: ChartAst,
	entryPath: StatePath,
	entry?: EntryEvent,
): void {
	for (const target of inputEntryTargets(ast, entryPath)) {
		projection.inputs[target.path] = resolveInputValues(target.input, entry, target.path);
	}
}

function resolveInputValues(
	input: Readonly<Record<string, SchemaAst>>,
	entry: EntryEvent | undefined,
	statePath: StatePath,
): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	for (const [name, schema] of Object.entries(input)) {
		const binding = entry?.transition.input?.[name];
		if (entry !== undefined && binding !== undefined) {
			values[name] = selectEventValue(entry.event, binding.path, name, statePath);
			continue;
		}
		if (schemaHasDefault(schema)) {
			values[name] = structuredClone((schema.schema as Record<string, unknown>).default);
		}
	}
	return values;
}

function inputEntryTargets(
	ast: ChartAst,
	path: StatePath,
): Array<{ path: StatePath; input: Readonly<Record<string, SchemaAst>> }> {
	const node = nodeAt(ast, path);
	if (node === undefined) return [];
	if (node.kind === "state") {
		return node.input === undefined ? [] : [{ path, input: node.input }];
	}
	if (node.kind === "map") {
		if (lastSegmentKey(path) === undefined) {
			return node.input === undefined ? [] : [{ path, input: node.input }];
		}
		return inputEntryTargets(ast, childPath(path, node.initial));
	}
	if (node.kind === "compound" || node.kind === "region") {
		return inputEntryTargets(ast, childPath(path, node.initial));
	}
	if (node.kind === "parallel") {
		return node.regions.flatMap((region) => inputEntryTargets(ast, childPath(path, region)));
	}
	const parent = parentPath(path);
	if (node.kind === "final" && parent !== undefined) {
		const container = nodeAt(ast, parent);
		if (container?.kind === "compound") {
			return inputEntryTargets(ast, siblingPath(parent, container.onDone));
		}
	}
	return [];
}

function selectEventValue(
	event: ChartEvent,
	path: string | undefined,
	inputName: string,
	statePath: StatePath,
): unknown {
	if (!("output" in event)) {
		if (path === undefined) return undefined;
		throw new Error(`Input '${inputName}' for state ${statePath}: event ${event.type} has no output`);
	}
	if (path === undefined) return event.output;
	let current = event.output;
	for (const segment of path.split(".")) {
		if (typeof current !== "object" || current === null || !(segment in current)) {
			throw new Error(`Input '${inputName}' for state ${statePath}: event output has no '${path}'`);
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function schemaHasDefault(schema: SchemaAst): boolean {
	return typeof schema.schema === "object" && schema.schema !== null && "default" in schema.schema;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actionStateAt(ast: ChartAst, stateId: StatePath): ActionStateAst | undefined {
	const main = nodeAt(ast, stateId);
	if (main?.kind === "state") return main;
	const actor = actorContextForState(ast, stateId)?.node;
	return actor?.kind === "state" ? actor : undefined;
}

function isActionActive(projection: BranchProjection, ast: ChartAst, stateId: StatePath): boolean {
	if (projection.activeLeaves.includes(stateId)) return true;
	const context = actorContextForState(ast, stateId);
	if (context === undefined) return false;
	const { endpoint, worker } = actorExecutionForContext(projection, context);
	return executionCurrentState(endpoint, worker) === context.localState;
}

function assertActiveActionUid(ast: ChartAst, stateId: StatePath, actual: ActionUID, operation: string): void {
	const state = actionStateAt(ast, stateId);
	assert(state !== undefined, `Cannot ${operation} action for non-action state ${stateId}`);
	assert(matchesDeclaredUid(actual, state.action.uid), `Invalid action ${operation} for state ${stateId}`);
}

function sameActionUid(left: ActionUID, right: ActionUID): boolean {
	return left.chart === right.chart && left.state === right.state && left.action === right.action;
}
