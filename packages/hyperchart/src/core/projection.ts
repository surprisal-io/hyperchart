import type { ActionStateAst, ActionUID, ActorDeclarationAst, ChartAst, ChartEvent, SchemaAst, StateAst, StatePath, TransitionAst } from "./types.js";
import type { ActorMessageEnvelope, DurableLogRecord } from "./durable_events.js";
import { actorContextForState, actorDeclarationForOccurrence, actorGenerationPath, actorLogicalOccurrencePath, actorOccurrencePath, actorStatePath } from "./actors.js";
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
	| { actionUid: ActionUID; visitId: number; seqId: number; invokeSeqId: number; timestamp: number; phase: "running" }
	| {
			actionUid: ActionUID;
			visitId: number;
			seqId: number;
			invokeSeqId: number;
			phase: "validating";
			event: ChartEvent;
			validationAttempts: number;
	  }
	| {
			actionUid: ActionUID;
			visitId: number;
			seqId: number;
			invokeSeqId: number;
			phase: "rejected";
			event: ChartEvent;
			validationAttempts: number;
			reason?: string;
	  };

export type ProjectedActorMessage = ActorMessageEnvelope & {
	status: "queued" | "accepted" | "replied" | "settled" | "failed" | "cancelled";
	receiveState?: StatePath;
	replyEvent?: string;
	replyOutput?: unknown;
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
	messages: ProjectedActorMessage[];
	currentMessage?: ProjectedActorMessage;
	status: "idle" | "busy" | "closing" | "draining" | "stopped" | "failed" | "cancelled";
};

export type PendingActorCall = {
	callId: string;
	callerState: StatePath;
	occurrence: StatePath;
	messageId: string;
	status: "enqueued" | "accepted";
};

export type BranchProjection = {
	// The active configuration: one leaf normally, one per region while a parallel is active.
	// Always leaves — compounds drill down to their initial, parallels expand to their regions.
	activeLeaves: StatePath[];
	seqId: number;
	pendingActions: PendingAction[];
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
	/** Durable global fail-fast intent. Presence blocks every new invoke/message effect. */
	failure?: { origin: StatePath; error: unknown; seqId: number };
	actors: Record<StatePath, ProjectedActorOccurrence>;
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
		spawns: {},
		inputs: {},
		results: {},
		stateVisits: {},
		sessions: {},
		actors: {},
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
				if (projection.failure !== undefined) throw new Error("A run may contain only one failure intent");
				projection.failure = { origin: record.origin, error: record.error, seqId: record.seqId };
				break;
			case "actor_created": {
				if (projection.actors[record.occurrence] !== undefined) throw new Error(`Actor occurrence ${record.occurrence} was created twice`);
				const liveDefinition = liveActorDeclaration(ast, record.declaration, record.occurrence);
				if (record.definition.path !== record.declaration) throw new Error(`Actor creation ${record.occurrence} has mismatched definition provenance`);
				if (!Number.isInteger(record.generation) || record.generation < 1) throw new Error(`Actor occurrence ${record.occurrence} has invalid generation`);
				const declaredOwner: StatePath | undefined = record.definition.owner;
				if ((declaredOwner === undefined) !== (record.owner === undefined) || (declaredOwner !== undefined && record.owner !== undefined && templatePath(record.owner) !== declaredOwner)) {
					throw new Error(`Actor creation ${record.occurrence} has mismatched owner provenance`);
				}
				if (record.owner !== undefined) {
					const ownerNode = nodeAt(ast, declaredOwner!);
					if (ownerNode?.kind === "map") {
						const key = lastSegmentKey(record.owner);
						const spawned = projection.spawns[stripLastKey(record.owner)];
						if (key === undefined || spawned === undefined || !Object.prototype.hasOwnProperty.call(spawned, key)) {
							throw new Error(`Actor creation ${record.occurrence} targets an owner map occurrence that was not spawned`);
						}
					}
					if (!projection.activeLeaves.some((leaf) => underScope(leaf, record.owner!))) {
						throw new Error(`Actor creation ${record.occurrence} targets an owner occurrence that is not active`);
					}
				}
				const logicalOccurrence = actorLogicalOccurrencePath(record.occurrence, record.generation);
				const expectedLogicalOccurrence = actorOccurrencePath(record.definition, record.owner);
				if (logicalOccurrence !== expectedLogicalOccurrence) throw new Error(`Actor creation ${record.occurrence} has mismatched logical occurrence provenance`);
				if (record.occurrence !== actorGenerationPath(logicalOccurrence, record.generation)) throw new Error(`Actor creation ${record.occurrence} does not match its generation`);
				const priorGeneration = Object.values(projection.actors).filter((entry) => entry.logicalOccurrence === logicalOccurrence).sort((left, right) => right.generation - left.generation)[0];
				if (record.generation !== (priorGeneration?.generation ?? 0) + 1) throw new Error(`Actor occurrence ${logicalOccurrence} generation is not sequential`);
				if (priorGeneration !== undefined && priorGeneration.status !== "stopped") throw new Error(`Actor occurrence ${logicalOccurrence} re-entered before its prior generation stopped`);
				projection.actors[record.occurrence] = {
					declaration: record.declaration,
					logicalOccurrence,
					occurrence: record.occurrence,
					generation: record.generation,
					...(record.owner === undefined ? {} : { owner: record.owner }),
					input: record.input,
					definition: record.definition,
					currentState: liveDefinition.initial,
					mailbox: [],
					messages: [],
					status: "idle",
				};
				break;
			}
			case "actor_messages_enqueued": {
				const actor = projection.actors[record.occurrence];
				if (actor === undefined) throw new Error(`Message enqueue targets unknown actor ${record.occurrence}`);
				if (record.generation !== actor.generation) throw new Error(`Message enqueue targets the wrong generation of ${actor.logicalOccurrence}`);
				if (record.source.targetDeclaration !== actor.declaration || record.source.event !== record.messages[0]?.event) throw new Error(`Message enqueue has inconsistent target/event provenance`);
				if (record.source.producerState !== record.messages[0]?.producerState || record.messages.some((message) => message.producerState !== record.source.producerState || message.event !== record.source.event)) throw new Error(`Message enqueue has inconsistent producer provenance`);
				if (actor.status === "stopped" || actor.status === "cancelled" || actor.status === "failed") throw new Error(`Message enqueue targets stopped actor ${record.occurrence}`);
				if (actor.status === "closing" || actor.status === "draining") {
					const producerContext = actorContextForState(ast, record.source.producerState);
					const producer = producerContext === undefined ? undefined : projection.actors[producerContext.occurrence];
					if (producer?.currentMessage === undefined) throw new Error(`External message enqueue targets closing actor ${record.occurrence}`);
				}
				if (record.messages.length === 0) throw new Error("Actor enqueue transaction must contain at least one message");
				const ids = new Set(actor.messages.map((message) => message.messageId));
				for (const envelope of record.messages) {
					if (ids.has(envelope.messageId)) throw new Error(`Duplicate actor message id ${envelope.messageId}`);
					ids.add(envelope.messageId);
					const message: ProjectedActorMessage = { ...envelope, status: "queued" };
					actor.mailbox.push(message);
					actor.messages.push(message);
					if (envelope.callId !== undefined) {
						if (projection.pendingActorCalls[envelope.callId] !== undefined) throw new Error(`Duplicate actor call id ${envelope.callId}`);
						projection.pendingActorCalls[envelope.callId] = { callId: envelope.callId, callerState: envelope.producerState, occurrence: record.occurrence, messageId: envelope.messageId, status: "enqueued" };
					}
				}
				const producer = record.messages[0]?.producerState;
				if (producer !== undefined) {
					projection.actorProducerVisits[producer] = Math.max(projection.actorProducerVisits[producer] ?? 0, record.messages[0]?.producerVisit ?? 0);
					advanceActorControlState(projection, ast, producer, "enqueued", undefined, abandoned);
				}
				break;
			}
			case "actor_message": {
				const actor = projection.actors[record.occurrence];
				if (actor === undefined) throw new Error(`Actor message fact targets unknown actor ${record.occurrence}`);
				const definition = liveActorDeclaration(ast, actor.declaration, actor.occurrence);
				if (record.kind === "accepted") {
					if (actor.currentMessage !== undefined) throw new Error(`Actor ${record.occurrence} already owns a current message`);
					const head = actor.mailbox[0];
					if (head?.messageId !== record.messageId) throw new Error(`Actor ${record.occurrence} may accept only its FIFO head`);
					const receive = definition.states[actor.currentState];
					if (receive?.kind !== "receive") throw new Error(`Actor ${record.occurrence} accepted a message outside receive()`);
					if (record.receiveState !== actorStatePath(record.occurrence, actor.currentState)) throw new Error(`Actor ${record.occurrence} accepted from the wrong receive visit`);
					const target = receive.on[head.event];
					if (target === undefined) throw new Error(`FIFO head '${head.event}' is unsupported by receive '${actor.currentState}'`);
					actor.mailbox.shift();
					head.status = "accepted";
					head.receiveState = record.receiveState;
					actor.currentMessage = head;
					applyActorInputForEntry(projection, ast, actor, target);
					actor.currentState = target;
					actor.status = actor.status === "closing" || actor.status === "draining" ? "draining" : "busy";
					if (head.callId !== undefined && projection.pendingActorCalls[head.callId] !== undefined) projection.pendingActorCalls[head.callId]!.status = "accepted";
					break;
				}
				if (record.kind === "replied") {
					const current = actor.currentMessage;
					if (current?.messageId !== record.messageId) throw new Error(`Actor ${record.occurrence} replied to a message it does not own`);
					const reply = definition.states[actor.currentState];
					if (reply?.kind !== "reply" || reply.message !== current.event || record.message !== current.event) throw new Error(`Actor ${record.occurrence} reply does not match its inferred current message`);
					current.status = "replied";
					if (record.replyEvent !== undefined) current.replyEvent = record.replyEvent;
					if (Object.hasOwn(record, "output")) current.replyOutput = record.output;
					break;
				}
				const current = actor.currentMessage;
				if (current?.messageId !== record.messageId || current.status !== "replied") throw new Error(`Actor ${record.occurrence} settled before a validated reply`);
				const reply = definition.states[actor.currentState];
				if (reply?.kind !== "reply") throw new Error(`Actor ${record.occurrence} settled outside reply()`);
				current.status = "settled";
				delete actor.currentMessage;
				actor.currentState = reply.target;
				actor.status = actor.status === "closing" || actor.status === "draining" ? "draining" : "idle";
				break;
			}
			case "actor_call_resolved": {
				const call = projection.pendingActorCalls[record.callId];
				if (call === undefined || call.callerState !== record.callerState || call.messageId !== record.messageId) throw new Error(`Actor call result ${record.callId} has no matching pending caller`);
				const actor = projection.actors[call.occurrence];
				const message = actor?.messages.find((entry) => entry.messageId === record.messageId);
				if (message?.status !== "settled") throw new Error(`Actor call result ${record.callId} resolved before its message settled`);
				if (message.callId !== record.callId || message.replyEvent !== record.replyEvent || (Object.hasOwn(record, "output") && JSON.stringify(message.replyOutput) !== JSON.stringify(record.output))) throw new Error(`Actor call result ${record.callId} does not match the correlated reply`);
				delete projection.pendingActorCalls[record.callId];
				if (Object.hasOwn(record, "output")) projection.results[record.callerState] = record.output;
				advanceActorControlState(projection, ast, record.callerState, "replied", record.replyEvent, abandoned, record.output);
				break;
			}
			case "actor_scope": {
				const actor = projection.actors[record.occurrence];
				if (actor === undefined) throw new Error(`Actor scope fact targets unknown actor ${record.occurrence}`);
				if (record.kind === "closing") {
					if (actor.status === "stopped") throw new Error(`Stopped actor ${record.occurrence} cannot close again`);
					actor.status = actor.currentMessage === undefined && actor.mailbox.length === 0 ? "closing" : "draining";
				} else {
					if (actor.currentMessage !== undefined || actor.mailbox.length > 0) throw new Error(`Actor ${record.occurrence} stopped before drain`);
					actor.status = "stopped";
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
								timestamp: record.timestamp,
								phase: "running",
							});
						} else {
							recordSkipped(skipped, projection, record, record.actionUid.state);
						}
						break;
					case "complete":
						if (isActionActive(projection, ast, record.actionUid.state)) {
							assertActiveActionUid(ast, record.actionUid.state, record.actionUid, "complete");
							const state = actionStateAt(ast, record.actionUid.state);
							if (state?.kind === "state" && state.validate !== undefined && record.event.type !== "FAILED") {
								// The completion goes into validation, restarting the cycle if a previous round was
								// rejected; the validation-attempt count survives the retry.
								const previous = projection.pendingActions.find((pending) =>
									sameActionUid(pending.actionUid, record.actionUid),
								);
								const validationAttempts = previous?.phase === "rejected" ? previous.validationAttempts : 0;
								removePendingAction(projection, record.actionUid);
								projection.pendingActions.push({
									actionUid: record.actionUid,
									visitId: previous?.visitId ?? projection.stateVisits[actionUidKey(record.actionUid)] ?? 1,
									seqId: record.seqId,
									invokeSeqId: previous?.invokeSeqId ?? record.seqId,
									phase: "validating",
									event: record.event,
									validationAttempts,
								});
								break;
							}
							recordResult(projection, record.actionUid.state, record.event);
							removePendingAction(projection, record.actionUid);
							applyTransition(projection, ast, record.actionUid.state, record.event.type, abandoned, record.event);
						} else {
							recordSkipped(skipped, projection, record, record.actionUid.state);
						}
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
		projection.pendingActions.splice(index, 1);
	}
}

function applyAfterTransition(
	projection: BranchProjection,
	ast: ChartAst,
	leaf: StatePath,
	abandoned: PendingAction[],
): void {
	const state = actionStateAt(ast, leaf);
	if (state?.after === undefined) throw new Error(`No after transition in state ${leaf}`);
	const actorContext = actorContextForState(ast, leaf);
	if (actorContext !== undefined) {
		const actor = projection.actors[actorContext.occurrence];
		if (actor === undefined || actor.currentState !== actorContext.localState) throw new Error(`Actor state ${leaf} is not active`);
		applyActorInputForEntry(projection, ast, actor, state.after.target);
		actor.currentState = state.after.target;
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
	event?: ChartEvent,
): void {
	const actorContext = actorContextForState(ast, fromLeaf);
	if (actorContext !== undefined) {
		const actor = projection.actors[actorContext.occurrence];
		if (actor === undefined || actor.currentState !== actorContext.localState) throw new Error(`Actor state ${fromLeaf} is not active`);
		if (actorContext.node.kind !== "state") throw new Error(`Actor state ${fromLeaf} cannot emit action event ${eventType}`);
		const transition = actorContext.node.transitions[eventType];
		if (transition === undefined) throw new Error(`No actor transition for event type ${eventType} in state ${fromLeaf}`);
		applyActorInputForEntry(projection, ast, actor, transition.target, transition, event);
		actor.currentState = transition.target;
		return;
	}
	const handler = findHandler(ast, fromLeaf, eventType);
	if (!handler) {
		throw new Error(`No transition for event type ${eventType} in state ${fromLeaf}`);
	}
	const target = siblingPath(handler.path, handler.transition.target);
	// Input defaults belong to the entered state; event-bound inputs require a concrete event and
	// fail explicitly inside applyInputsForEntry when one is unavailable.
	applyInputsForEntry(projection, ast, target, handler.transition, event);
	exitAndEnter(projection, ast, handler.path, target, abandoned);
}

function advanceActorControlState(
	projection: BranchProjection,
	ast: ChartAst,
	statePath: StatePath,
	phase: "enqueued" | "replied",
	replyEvent: string | undefined,
	abandoned: PendingAction[],
	output?: unknown,
): void {
	const actorContext = actorContextForState(ast, statePath);
	const node = actorContext?.node ?? nodeAt(ast, statePath);
	if (node?.kind !== "send" && node?.kind !== "call") throw new Error(`Actor message fact has invalid producer state ${statePath}`);
	if (phase === "enqueued" && node.kind === "call") return;
	if (phase === "replied" && node.kind === "send") throw new Error(`Fire-and-forget send state ${statePath} cannot await a reply`);
	const transition =
		node.kind === "send"
			? { target: node.target }
			: node.target !== undefined
				? { target: node.target }
				: replyEvent === undefined
					? undefined
					: node.transitions[replyEvent];
	if (transition === undefined) throw new Error(`Actor call ${statePath} has no route for reply '${replyEvent ?? "single"}'`);
	const event: ChartEvent = {
		type: replyEvent ?? "ACTOR_REPLY",
		...(output === undefined ? {} : { output }),
	};
	if (actorContext !== undefined) {
		const actor = projection.actors[actorContext.occurrence];
		if (actor === undefined || actor.currentState !== actorContext.localState) throw new Error(`Actor producer state ${statePath} is not active`);
		applyActorInputForEntry(projection, ast, actor, transition.target, transition, event);
		actor.currentState = transition.target;
		return;
	}
	if (!projection.activeLeaves.includes(statePath)) throw new Error(`Actor producer state ${statePath} is not active`);
	const target = siblingPath(statePath, transition.target);
	applyInputsForEntry(projection, ast, target, transition, event);
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
		const actors = Object.values(projection.actors).filter((actor) => actor.owner !== undefined && underScope(actor.owner, path));
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
		const actors = Object.values(projection.actors).filter((actor) => actor.owner === path);
		if (actors.every((actor) => actor.status === "stopped")) {
			candidates.push({ path, target: siblingPath(path, node.onDone) });
		}
	}
	return candidates.sort((left, right) => right.path.length - left.path.length)[0];
}

function liveActorDeclaration(ast: ChartAst, declaration: StatePath, occurrence: StatePath): ActorDeclarationAst {
	const live = ast.actors[declaration];
	if (live === undefined) throw new Error(`Actor ${occurrence} declaration ${declaration} is missing from the live chart`);
	return live;
}

function applyActorInputForEntry(
	projection: BranchProjection,
	ast: ChartAst,
	actor: ProjectedActorOccurrence,
	target: StatePath,
	transition?: TransitionAst,
	event?: ChartEvent,
): void {
	const node = liveActorDeclaration(ast, actor.declaration, actor.occurrence).states[target];
	if (node?.kind !== "state" || node.input === undefined) return;
	const values: Record<string, unknown> = {};
	for (const [name, schema] of Object.entries(node.input)) {
		const binding = transition?.input?.[name];
		if (binding !== undefined) {
			if (event === undefined) throw new Error(`Input '${name}' for actor state ${actor.occurrence}.${target}: event binding has no event payload`);
			values[name] = selectEventValue(event, binding.path, name, `${actor.occurrence}.${target}`);
		} else if (schemaHasDefault(schema)) {
			values[name] = cloneJson((schema.schema as Record<string, unknown>).default);
		}
	}
	projection.inputs[actorStatePath(actor.occurrence, target)] = values;
}

function applyInputsForEntry(
	projection: BranchProjection,
	ast: ChartAst,
	entryPath: StatePath,
	transition?: TransitionAst,
	event?: ChartEvent,
): void {
	for (const target of inputEntryTargets(ast, entryPath)) {
		const values: Record<string, unknown> = {};
		for (const [name, schema] of Object.entries(target.input)) {
			const binding = transition?.input?.[name];
			if (binding !== undefined) {
				if (event === undefined) {
					throw new Error(`Input '${name}' for state ${target.path}: event binding has no event payload`);
				}
				values[name] = selectEventValue(event, binding.path, name, target.path);
				continue;
			}
			if (schemaHasDefault(schema)) {
				values[name] = cloneJson((schema.schema as Record<string, unknown>).default);
			}
		}
		projection.inputs[target.path] = values;
	}
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

function cloneJson(value: unknown): unknown {
	if (value === undefined) return undefined;
	return JSON.parse(JSON.stringify(value)) as unknown;
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
	return context !== undefined && projection.actors[context.occurrence]?.currentState === context.localState;
}

function assertActiveActionUid(ast: ChartAst, stateId: StatePath, actual: ActionUID, operation: string): void {
	const state = actionStateAt(ast, stateId);
	if (state === undefined) throw new Error(`Cannot ${operation} action for non-action state ${stateId}`);
	if (!matchesDeclaredUid(actual, state.action.uid)) throw new Error(`Invalid action ${operation} for state ${stateId}`);
}

function sameActionUid(left: ActionUID, right: ActionUID): boolean {
	return left.chart === right.chart && left.state === right.state && left.action === right.action;
}
