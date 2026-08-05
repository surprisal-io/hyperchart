import type {
	ChartEvent,
	ActionStateAst,
	ActionUID,
	ActorDeclarationAst,
	ActorWorkflowStateAst,
	AgentActionAst,
	ChartAst,
	GuardOutcome,
	ArtifactAst,
	ArtifactOfAst,
	ArtifactOfCst,
	JoinArtifactOfAst,
	JoinArtifactOfCst,
	GuardRefAst,
	InputRef,
	OnReject,
	OnReenterAst,
	SchemaAst,
	ScriptActionAst,
	StatePath,
	TemplateAst,
	Templatable,
	UserActionAst,
	ValueAst,
} from "./types.js";
import { isInputRef } from "./types.js";
import type { ActorMessageEnvelope, ActorMessageSource, DurableLogRecord } from "./durable_events.js";
import { actorContextForState, actorGenerationPath, actorOccurrencePath, actorStatePath } from "./actors.js";
import { actionUidKey } from "./action_uid.js";
import { declaredArtifactsForState } from "./normalize.js";
import {
	allowedEvents,
	type BranchProjection,
	hasTransition,
	isFinalState,
	type PendingAction,
	projectBranch,
} from "./projection.js";
import {
	instancePathFor,
	lastSegmentKey,
	matchesDeclaredUid,
	nearestInstance,
	nodeAt,
	parentPath,
	stripLastKey,
	templatePath,
	underScope,
} from "./paths.js";

export type MachineState = {
	ast: ChartAst;
	projection: BranchProjection;
	// Ids of effects already dispatched in this machine lifetime. Guards against dispatching the
	// same invoke/run/validation/feedback twice; starts empty on restart, so unfinished work
	// re-runs.
	dispatched: Set<EffectId>;
};

export type EffectId = string;

export type ResumeRequest = Readonly<{
	message: string;
	session?: string;
}>;

// A file parameter with its path rendered and — when the producer declared one — the shape of
// its content; the runtime uses the shape both to instruct the agent and to verify the file.
export type RenderedArtifact = Readonly<{
	// Present on the producing side: the artifact's declared name.
	name?: string;
	/** Producer state for artifact-backed reads; absent for raw paths and produced outputs. */
	sourceState?: string;
	/** One producer artifact or one expanded member of a map fan-in. */
	readKind?: "artifact" | "join";
	path: string;
	shape?: SchemaAst;
	// Present on artifactOf reads with a selector: the runtime hands the agent only this field of the
	// file's content (validated against `shape`, which describes the WHOLE file).
	select?: string;
}>;

// A spawn-ready subagent call: the definition name and frontmatter overrides live in `action`;
// task/output/reads are the templated parameters rendered into final text by the machine.
export type AgentEffect = Readonly<{
	kind: "agent";
	id: EffectId;
	actionUid: ActionUID;
	action: AgentActionAst;
	task?: string;
	// The artifact channel: named deliverable files to produce (with shapes), files to read first.
	artifacts?: readonly RenderedArtifact[];
	reads?: readonly RenderedArtifact[];
	// The reply (stdout) channel — the step's RESULT: which completion event types the machine
	// will accept (own transitions plus bubbling ancestors), and what shape the event's payload
	// must have — it becomes results[state] once accepted. The runtime tells the agent both
	// upfront and validates the actual reply at the boundary.
	events: readonly string[];
	reply?: SchemaAst;
	resume?: ResumeRequest;
}>;

export type UserEffect = Readonly<{
	kind: "user";
	id: EffectId;
	/** Durable record that caused this user phase; public gate identity is (runId, seqId). */
	seqId: number;
	actionUid: ActionUID;
	action: UserActionAst;
	prompt: string;
	events: readonly string[];
	reply?: SchemaAst;
}>;

// A command to execute: same completion contract as an agent (events + reply for the parsed
// stdout), same artifact channels; parameters arrive as rendered env vars.
export type ScriptEffect = Readonly<{
	kind: "script";
	id: EffectId;
	actionUid: ActionUID;
	action: ScriptActionAst;
	command: string;
	args: readonly string[];
	// Rendered env. A string is final (templates; artifactOf without select renders to the
	// producer's file path). A RenderedArtifact appears for artifactOf WITH select: the runtime
	// resolves it at spawn — read the file, validate against shape, extract the field, serialize
	// (string verbatim, everything else as JSON) — same rules as an agent's reads.
	env?: Readonly<Record<string, string | RenderedArtifact>>;
	artifacts?: readonly RenderedArtifact[];
	events: readonly string[];
	reply?: SchemaAst;
}>;

export type ActionEffect = AgentEffect | UserEffect | ScriptEffect;

export type DurableRecordsEffect = Readonly<{
	kind: "durable_records";
	id: EffectId;
	records: readonly DurableLogRecord[];
}>;

export type ActorCreateEffect = Readonly<{
	kind: "actor_create";
	id: EffectId;
	declaration: ActorDeclarationAst;
	occurrence: StatePath;
	generation: number;
	owner?: StatePath;
	input: unknown;
}>;

export type ActorEnqueueEffect = Readonly<{
	kind: "actor_enqueue";
	id: EffectId;
	occurrence: StatePath;
	generation: number;
	schema: SchemaAst;
	source: ActorMessageSource;
	messages: readonly ActorMessageEnvelope[];
}>;

export type ActorReplyEffect = Readonly<{
	kind: "actor_reply";
	id: EffectId;
	occurrence: StatePath;
	messageId: string;
	message: string;
	callerState?: StatePath;
	callId?: string;
	replyEvent?: string;
	output?: unknown;
	schema?: SchemaAst;
}>;

export type ActorEffect = ActorCreateEffect | ActorEnqueueEffect | ActorReplyEffect;

// Asks the runtime to run the state's validator against an action's completion. The runtime
// answers with a `validated` event; the completion is not processed until then.
export type ValidateEffect = Readonly<{
	kind: "validate";
	id: EffectId;
	actionUid: ActionUID;
	guard: GuardRefAst;
	event: ChartEvent;
	// Rendered exactly like a script action's options. Values are resolved only while this
	// completion is pending; they are never durable facts or action results.
	env?: Readonly<Record<string, string | RenderedArtifact>>;
	artifacts?: readonly RenderedArtifact[];
	reply?: SchemaAst;
}>;

// A completion did not pass the state's validate check. The action is still pending; the runtime
// must deliver the feedback per onReject, and the action completes again with a fixed result.
export type RejectedEffect = Readonly<{
	kind: "rejected";
	id: EffectId;
	/** Durable rejected-validation fact that caused this retry phase. */
	seqId: number;
	actionUid: ActionUID;
	event: ChartEvent;
	onReject: OnReject;
	// Which rejected validation round this is (1-based); the budget lives in the state's `retries`.
	validationAttempts: number;
	reason?: string;
	// Fully rendered invocation reconstructed from chart + replayed facts using the original
	// invoke seqId. Used when a rejected action must continue/restart after process memory is gone.
	invocation: ActionEffect;
}>;

// A deadline racing a running action: fires at `firesAt` (absolute — the invoke fact's timestamp
// plus the state's after.delayMs, so a restarted machine waits only the remaining time). The
// runtime answers with a `timer` event; whether the firing still matters is the machine's call.
export type TimerEffect = Readonly<{
	kind: "timer";
	id: EffectId;
	actionUid: ActionUID;
	firesAt: number;
}>;

// The action lost to its deadline: the runtime must stop the agent. Purely a kill signal — the
// chart has already moved on via the timer_fired fact.
export type CancelEffect = Readonly<{
	kind: "cancel";
	id: EffectId;
	actionUid: ActionUID;
}>;

export type Effect =
	| AgentEffect
	| UserEffect
	| ScriptEffect
	| DurableRecordsEffect
	| ActorEffect
	| ValidateEffect
	| RejectedEffect
	| TimerEffect
	| CancelEffect;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// A record the machine wants to append, before numbering. parentId/seqId/timestamp are assigned
// in one place — when the append is actually emitted — so building an append is pure and it can
// be derived speculatively and deduplicated.
type DraftRecord = DistributiveOmit<DurableLogRecord, "parentId" | "seqId" | "timestamp">;

export type RecordAppend = Readonly<{
	kind: "append";
	id: EffectId;
	records: readonly DraftRecord[];
}>;

export type AgentMachineEvent = Readonly<{
	kind: "agent";
	effectId: EffectId;
	event: ChartEvent;
}>;

export type UserMachineEvent = Readonly<{
	kind: "user";
	effectId: EffectId;
	event: ChartEvent;
}>;

// A script's completion: same shape and handling as an agent's — the runtime maps the process
// outcome (exit code, parsed stdout) into a chart event.
export type ScriptMachineEvent = Readonly<{
	kind: "script";
	effectId: EffectId;
	event: ChartEvent;
}>;

export type DurableRecordsAddedMachineEvent = Readonly<{
	kind: "durable_records_added";
	effectId: EffectId;
	records: readonly DurableLogRecord[];
}>;

// The runtime's answer to a validate effect.
export type ValidatedMachineEvent = Readonly<{
	kind: "validated";
	effectId: EffectId;
	outcome: GuardOutcome;
}>;

// The runtime's answer to a timer effect: the deadline passed.
export type TimerMachineEvent = Readonly<{
	kind: "timer";
	effectId: EffectId;
}>;

export type ActorEffectMachineEvent = Readonly<{
	kind: "actor_effect";
	effectId: EffectId;
	operation: "create" | "enqueue" | "reply";
	ok: boolean;
	error?: string;
}>;

export type MachineStartEvent = Readonly<{
	kind: "start";
}>;

export type MachineEvent =
	| MachineStartEvent
	| AgentMachineEvent
	| UserMachineEvent
	| ScriptMachineEvent
	| DurableRecordsAddedMachineEvent
	| ValidatedMachineEvent
	| TimerMachineEvent
	| ActorEffectMachineEvent;

export type MachineOutput = MachineOutputEffect | MachineOutputFinal | MachineOutputError;

export type MachineOutputError = Readonly<{
	kind: "error";
	state: MachineState;
	error: string;
}>;

export type MachineOutputFinal = Readonly<{
	kind: "final";
	state: MachineState;
	// Parting effects the runtime must still execute — e.g. cancels for agents abandoned by the
	// transition that finished the chart.
	effects: Effect[];
	result: unknown;
}>;

export type MachineOutputEffect = Readonly<{
	kind: "effect";
	state: MachineState;
	effects: Effect[];
}>;

export function createMachineOutput(state: MachineState, responses: readonly (Effect | RecordAppend)[]): MachineOutput {
	if (state.projection.failure !== undefined) {
		// Failure terminalizes immediately. Runtime cancellation is best-effort, just like
		// timeout/scope-exit cancellation; it is not part of the durable log contract.
		return {
			kind: "final",
			state,
			effects: [
				...responses.map((entry) => (entry.kind === "append" ? stampAppend(state, entry) : entry)),
				...state.projection.pendingActions.map((pending): CancelEffect => ({
					kind: "cancel",
					id: pendingEffectId(pending),
					actionUid: pending.actionUid,
				})),
			],
			result: undefined,
		};
	}
	if (isFinalState(state.projection, state.ast) && actorsTerminalForRun(state)) {
		return {
			kind: "final",
			state,
			effects: responses.map((entry) => (entry.kind === "append" ? stampAppend(state, entry) : entry)),
			result: state.projection.results[state.projection.activeLeaves[0] ?? ""],
		};
	}

	// What the runtime should be doing right now, derived entirely from the projection: an invoke
	// record for every active action-leaf with nothing pending yet, plus the effects of each
	// pending action — run it (with a deadline timer, if the state has one), validate its
	// completion, or deliver the rejection.
	const desired: (Effect | RecordAppend)[] = [
		...dueSpawns(state),
		...dueActorCreates(state),
		...dueActorAdmissionFailures(state),
		...dueActorEnqueues(state),
		...dueActorAccepts(state),
		...dueInvokes(state).map((actionUid) => invokeAppend(state, actionUid)),
		...dueActorReplies(state),
		...dueActorScopeFacts(state),
		...state.projection.pendingActions.flatMap((pending) => pendingEffects(state, pending)),
	];

	// Each desired entry is dispatched once per machine lifetime; markers of entries no longer
	// desired are dropped, so re-entering the same state later dispatches again.
	const desiredIds = new Set(desired.map((entry) => entry.id));
	for (const id of state.dispatched) {
		if (!desiredIds.has(id)) {
			state.dispatched.delete(id);
		}
	}
	const fresh = desired.filter((entry) => !state.dispatched.has(entry.id));
	for (const entry of fresh) {
		state.dispatched.add(entry.id);
	}

	// The only place where records are numbered: appends that made it into the output consume
	// their seqIds here.
	const effects = [...responses, ...fresh].map((entry) =>
		entry.kind === "append" ? stampAppend(state, entry) : entry,
	);

	return { kind: "effect", state, effects };
}

function stampAppend(state: MachineState, append: RecordAppend): DurableRecordsEffect {
	return {
		kind: "durable_records",
		id: append.id,
		records: append.records.map((record) => ({
			...record,
			parentId: state.projection.seqId,
			seqId: ++state.projection.seqId,
			timestamp: Date.now(),
		})),
	};
}

// Every pending action's effect answers the log record that started its phase: invoke → run the
// action, complete → validate it, validated(false) → deliver the rejection. The record's seqId
// makes the id unique per phase, so each phase dispatches exactly once.
function pendingEffectId(pending: PendingAction): EffectId {
	return actionEffectId(pending.actionUid, pending.visitId, pending.seqId);
}

function actionEffectId(actionUid: ActionUID, visitId: number, seqId: number): EffectId {
	return `${actionUidKey(actionUid)}:${visitId}:${seqId}`;
}

// All effects a pending action currently wants: its phase effect, plus — while running under a
// deadline — the timer racing it.
function pendingEffects(state: MachineState, pending: PendingAction): Effect[] {
	const ast = state.ast;
	const effects = [pendingEffect(state, pending)];
	if (pending.phase === "running") {
		const node = actionStateAtMachine(ast, pending.actionUid.state);
		if (node?.after !== undefined) {
			effects.push({
				kind: "timer",
				id: timerEffectId(pending),
				actionUid: pending.actionUid,
				firesAt: pending.timestamp + node.after.delayMs,
			});
		}
	}
	return effects;
}

function timerEffectId(pending: PendingAction): EffectId {
	return actionEffectId(pending.actionUid, pending.visitId, pending.seqId);
}

function pendingEffect(state: MachineState, pending: PendingAction): Effect {
	const node = actionStateAtMachine(state.ast, pending.actionUid.state);
	if (node === undefined || !matchesDeclaredUid(pending.actionUid, node.action.uid)) {
		throw new Error(`Pending action does not match the chart in state ${pending.actionUid.state}`);
	}
	const id = pendingEffectId(pending);
	switch (pending.phase) {
		case "running":
			return actionInvocationForAction(state, pending.actionUid, node.action, id, pending.seqId);
		case "validating": {
			if (node.validate === undefined) {
				throw new Error(`Cannot validate a completion for state ${pending.actionUid.state} without a validator`);
			}
			// Render from the same projection and original invoke context as the action effect. The
			// completion is still pending, so its output has not entered results and cannot perturb
			// the rendered paths. This also makes a replayed pending completion deterministic.
			return {
				kind: "validate",
				id,
				actionUid: pending.actionUid,
				guard: node.validate,
				event: pending.event,
				...(node.validate.kind === "script"
					? renderScriptOptions(state, node.validate as ScriptOptionsAst, pending.actionUid.state, pending.actionUid.state)
					: {}),
			};
		}
		case "rejected":
			return {
				kind: "rejected",
				id,
				seqId: pending.seqId,
				actionUid: pending.actionUid,
				event: pending.event,
				onReject: node.onReject ?? "resume",
				validationAttempts: pending.validationAttempts,
				...(pending.reason === undefined ? {} : { reason: pending.reason }),
				invocation: actionInvocationForAction(
					state,
					pending.actionUid,
					node.action,
					actionEffectId(pending.actionUid, pending.visitId, pending.invokeSeqId),
					pending.invokeSeqId,
				),
			};
	}
}

export function renderPendingActionInvocation(
	ast: ChartAst,
	projection: BranchProjection,
	pending: Extract<PendingAction, { phase: "running" }>,
): ActionEffect {
	const node = actionStateAtMachine(ast, pending.actionUid.state);
	if (node === undefined || !matchesDeclaredUid(pending.actionUid, node.action.uid)) {
		throw new Error(`Pending action does not match the chart in state ${pending.actionUid.state}`);
	}
	return actionInvocationForAction(
		{ ast, projection, dispatched: new Set() },
		pending.actionUid,
		node.action,
		actionEffectId(pending.actionUid, pending.visitId, pending.invokeSeqId),
		pending.seqId,
	);
}

function actionInvocationForAction(
	state: MachineState,
	actionUid: ActionUID,
	action: ActionStateAst["action"],
	id: EffectId,
	seqId: number,
): ActionEffect {
	switch (action.kind) {
		case "agent":
			return agentInvocationForAction(state, actionUid, action, id);
		case "script":
			return scriptInvocationForAction(state, actionUid, action, id);
		case "user":
			return userInvocationForAction(state, actionUid, action, id, seqId);
	}
}

function agentInvocationForAction(
	state: MachineState,
	actionUid: ActionUID,
	action: AgentActionAst,
	id: EffectId,
): AgentEffect {
	const resume = resumeRequestForAction(state, actionUid, id);
	return {
		kind: "agent",
		id,
		actionUid,
		action,
		events: allowedEventsForAction(state.ast, actionUid.state),
		...(action.reply === undefined ? {} : { reply: action.reply }),
		...(resume === undefined ? {} : { resume }),
		...(action.task === undefined ? {} : { task: renderTemplate(state, action.task, actionUid.state) }),
		...(action.artifacts === undefined
			? {}
			: {
					artifacts: Object.entries(action.artifacts).map(([name, declared]) => ({
						name,
						...renderArtifact(state, declared, actionUid.state),
					})),
				}),
		...(action.reads === undefined
			? {}
			: {
					reads: action.reads.flatMap((read) =>
						read.kind === "joinArtifactOf"
							? renderJoin(state, read, actionUid.state)
							: [renderRead(state, read, actionUid.state)],
					),
				}),
	};
}

type ScriptOptionsAst = {
	env?: Readonly<Record<string, TemplateAst | ArtifactOfAst | JoinArtifactOfAst>>;
	artifacts?: Readonly<Record<string, ArtifactAst>>;
	reply?: SchemaAst;
};

function renderScriptOptions(
	state: MachineState,
	action: ScriptOptionsAst,
	stateId: StatePath,
	selfActionArtifactsState?: StatePath,
): {
	env?: Readonly<Record<string, string | RenderedArtifact>>;
	artifacts?: readonly RenderedArtifact[];
	reply?: SchemaAst;
} {
	return {
		...(action.env === undefined ? {} : { env: renderScriptEnv(state, action.env, stateId, selfActionArtifactsState) }),
		...(action.artifacts === undefined
			? {}
			: { artifacts: Object.entries(action.artifacts).map(([name, declared]) => ({ name, ...renderArtifact(state, declared, stateId) })) }),
		...(action.reply === undefined ? {} : { reply: action.reply }),
	};
}

function renderScriptEnv(
	state: MachineState,
	env: Readonly<Record<string, Templatable | ArtifactOfCst | JoinArtifactOfCst>>,
	stateId: StatePath,
	selfActionArtifactsState?: StatePath,
): Readonly<Record<string, string | RenderedArtifact>> {
	return Object.fromEntries(
		Object.entries(env).map(([name, value]) => {
			if (typeof value === "string") return [name, value];
			if (value.kind === "template") return [name, renderTemplate(state, value, stateId)];
			if (value.kind === "joinArtifactOf") {
				const paths = renderJoin(state, value, stateId).map((read) => read.path);
				return [name, JSON.stringify(paths)];
			}
			const read = renderRead(state, value, stateId, selfActionArtifactsState);
			return [name, read.select === undefined ? read.path : read];
		}),
	);
}

function scriptInvocationForAction(
	state: MachineState,
	actionUid: ActionUID,
	action: ScriptActionAst,
	id: EffectId,
): ScriptEffect {
	return {
		kind: "script",
		id,
		actionUid,
		action,
		command: action.command,
		args: action.args,
		events: allowedEventsForAction(state.ast, actionUid.state),
		...renderScriptOptions(state, action, actionUid.state),
	};
}

function userInvocationForAction(
	state: MachineState,
	actionUid: ActionUID,
	action: UserActionAst,
	id: EffectId,
	seqId: number,
): UserEffect {
	return {
		kind: "user",
		id,
		seqId,
		actionUid,
		action,
		prompt: renderTemplate(state, action.prompt, actionUid.state),
		events: allowedEventsForAction(state.ast, actionUid.state),
		...(action.reply === undefined ? {} : { reply: action.reply }),
	};
}

function resumeRequestForAction(state: MachineState, actionUid: ActionUID, id: EffectId): ResumeRequest | undefined {
	const parts = effectIdParts(id);
	if (parts === null || parts.visitId <= 1) return undefined;
	const match = onReenterForAction(state.ast, actionUid.state);
	if (match === undefined || match.policy === "restart") return undefined;
	return {
		message: renderTemplate(state, match.policy.message, match.scope),
		...(state.projection.sessions[actionUidKey(actionUid)] === undefined
			? {}
			: { session: state.projection.sessions[actionUidKey(actionUid)] }),
	};
}

function onReenterForAction(
	ast: ChartAst,
	statePath: StatePath,
): { policy: OnReenterAst; scope: StatePath } | undefined {
	const own = nodeAt(ast, statePath);
	if (own?.kind === "state" && own.onReenter !== undefined) {
		return { policy: own.onReenter, scope: statePath };
	}
	let cur = parentPath(statePath);
	while (cur !== undefined) {
		const node = nodeAt(ast, cur);
		if (node?.kind === "map" && node.onReenter !== undefined) {
			return { policy: node.onReenter, scope: cur };
		}
		cur = parentPath(cur);
	}
	return undefined;
}

function effectIdParts(id: EffectId): { actionUid: ActionUID; visitId: number; seqId: number } | null {
	const [chart, state, action, visit, seq] = id.split(":");
	const visitId = Number(visit);
	const seqId = Number(seq);
	if (!chart || !state || !action || !Number.isInteger(visitId) || !Number.isInteger(seqId)) {
		return null;
	}

	return { actionUid: { chart, state, action }, visitId, seqId };
}

function sameActionUid(left: ActionUID, right: ActionUID): boolean {
	return left.chart === right.chart && left.state === right.state && left.action === right.action;
}

export function stepMachine(state: MachineState, event: MachineEvent): MachineOutput {
	if (
		state.projection.failure !== undefined &&
		event.kind !== "durable_records_added" &&
		event.kind !== "start"
	) return createMachineOutput(state, []);
	switch (event.kind) {
		case "agent":
		case "script":
		case "user": {
			const pending = findPendingAction(state, event.effectId);
			if (pending === null) {
				// The action is no longer pending — it lost a race (e.g. its timer fired first).
				// The late completion is ignored.
				break;
			}
			if (typeof pending === "string") {
				return { kind: "error", state, error: pending };
			}
			if (event.event.type === "FAILED") {
				return createMachineOutput(state, [
					{
						kind: "append",
						id: `failure:${event.effectId}`,
						records: [{ type: "failure_intent", origin: pending.actionUid.state, error: "error" in event.event ? event.event.error : "Action emitted FAILED" }],
					},
				]);
			}
			if (!hasActionTransition(state.ast, pending.actionUid.state, event.event.type)) {
				return {
					kind: "error",
					state,
					error: `No transition found for event type ${event.event.type} in state ${pending.actionUid.state}`,
				};
			}
			// The completion is logged unconditionally; whether it needs validation before the
			// transition is the projection's decision.
			return createMachineOutput(state, [
				{
					kind: "append",
					id: event.effectId,
					records: [{ type: "state_action", kind: "complete", actionUid: pending.actionUid, event: event.event }],
				},
			]);
		}
		case "validated": {
			const validating = state.projection.pendingActions.find(
				(pending): pending is Extract<PendingAction, { phase: "validating" }> =>
					pending.phase === "validating" && pendingEffectId(pending) === event.effectId,
			);
			if (!validating) {
				return { kind: "error", state, error: `No pending validation found for effectId ${event.effectId}` };
			}
			const node = actionStateAtMachine(state.ast, validating.actionUid.state);
			if (node?.validate === undefined) {
				return { kind: "error", state, error: `State ${validating.actionUid.state} has no validator` };
			}
			// The verdict is a fact: stored with the guard ref that produced it, never re-evaluated.
			// Exhausting validation retries is a reserved runtime failure, never an authored route.
			const exhausted = event.outcome !== true && node.retries !== undefined && validating.validationAttempts + 1 > node.retries;
			return createMachineOutput(state, [
				{
					kind: "append",
					id: event.effectId,
					records: [
						{
							type: "state_action",
							kind: "validated",
							actionUid: validating.actionUid,
							event: validating.event,
							guard: node.validate,
							outcome: event.outcome,
						},
						...(exhausted
							? [{
								type: "failure_intent" as const,
								origin: validating.actionUid.state,
								error: typeof event.outcome === "object" ? event.outcome.reason : "Validation retry budget exhausted",
							}]
							: []),
					],
				},
			]);
		}
		case "actor_effect": {
			const effect = [...dueActorCreates(state), ...dueActorEnqueues(state), ...dueActorReplies(state)].find((candidate) => candidate.id === event.effectId);
			// A response whose effect is no longer due lost a race — e.g. the owner
			// scope exited before actor-create validation returned. Race losers are
			// no-ops, mirroring invoke/spawn facts on inactive leaves.
			if (effect === undefined) break;
			if (!event.ok) {
				const origin = effect.kind === "actor_enqueue" ? effect.messages[0]?.producerState ?? effect.occurrence : effect.occurrence;
				return createMachineOutput(state, [{
					kind: "append",
					id: `failure:${effect.id}`,
					records: [{ type: "failure_intent", origin, error: event.error ?? `Actor ${event.operation} validation failed` }],
				}]);
			}
			if (effect.kind === "actor_create") {
				return createMachineOutput(state, [{
					kind: "append",
					id: effect.id,
					records: [{
						type: "actor_created",
						declaration: effect.declaration.path,
						occurrence: effect.occurrence,
						generation: effect.generation,
						...(effect.owner === undefined ? {} : { owner: effect.owner }),
						input: effect.input,
						definition: effect.declaration,
					}],
				}]);
			}
			if (effect.kind === "actor_enqueue") {
				return createMachineOutput(state, [{
					kind: "append",
					id: effect.id,
					records: [{ type: "actor_messages_enqueued", occurrence: effect.occurrence, generation: effect.generation, source: effect.source, messages: effect.messages }],
				}]);
			}
			return createMachineOutput(state, [{
				kind: "append",
				id: effect.id,
				records: [
					{
						type: "actor_message",
						kind: "replied",
						occurrence: effect.occurrence,
						messageId: effect.messageId,
						message: effect.message,
						...(effect.replyEvent === undefined ? {} : { replyEvent: effect.replyEvent }),
						...(Object.hasOwn(effect, "output") ? { output: effect.output } : {}),
						...(effect.schema === undefined ? {} : { schema: effect.schema }),
					},
					{ type: "actor_message", kind: "settled", occurrence: effect.occurrence, messageId: effect.messageId },
					...(effect.callId === undefined || effect.callerState === undefined
						? []
						: [{
							type: "actor_call_resolved" as const,
							callId: effect.callId,
							callerState: effect.callerState,
							messageId: effect.messageId,
							...(effect.replyEvent === undefined ? {} : { replyEvent: effect.replyEvent }),
							...(Object.hasOwn(effect, "output") ? { output: effect.output } : {}),
						}]),
				],
			}]);
		}
		case "timer": {
			const running = state.projection.pendingActions.find(
				(pending) => pending.phase === "running" && timerEffectId(pending) === event.effectId,
			);
			if (!running) {
				// The action completed (or moved into validation) before its deadline: stale, ignored.
				break;
			}
			// The expiry is a fact; the transition target is the projection's job. The cancel signal
			// rides along — the runtime must stop the now-abandoned agent.
			return createMachineOutput(state, [
				{
					kind: "append",
					id: event.effectId,
					records: [{ type: "state_action", kind: "timer_fired", actionUid: running.actionUid }],
				},
				{ kind: "cancel", id: event.effectId, actionUid: running.actionUid },
			]);
		}
		case "start":
			// Nothing to apply: the derivation in createMachineOutput starts whatever is due.
			break;
		case "durable_records_added": {
			// The projection reports what an exit dropped while its session was alive — e.g. one
			// region's event exited the whole parallel. The runtime must kill it.
			const abandoned: PendingAction[] = [];
			state.projection = projectBranch(state.projection, state.ast, event.records, abandoned);
			const cancels = abandoned.map(
				(pending): Effect => ({
					kind: "cancel",
					id: pendingEffectId(pending),
					actionUid: pending.actionUid,
				}),
			);
			return createMachineOutput(state, cancels);
		}
	}

	return createMachineOutput(state, []);
}

type PendingActionContext = {
	actionUid: ActionUID;
	state: ActionStateAst;
};

// null means "nothing pending for this action" — not an error, the completion may simply have
// lost a race; a string is a protocol violation to report.
function findPendingAction(machine: MachineState, effectId: EffectId): PendingActionContext | string | null {
	const parsed = effectIdParts(effectId);
	if (!parsed) {
		return `Invalid effectId ${effectId}`;
	}
	const pending = machine.projection.pendingActions.find(
		(el) => sameActionUid(el.actionUid, parsed.actionUid) && el.visitId === parsed.visitId,
	);
	if (!pending || pendingEffectId(pending) !== effectId) {
		return null;
	}
	if (pending.phase === "validating") {
		return `Validation already in flight for ${effectId}`;
	}
	const curState = actionStateAtMachine(machine.ast, parsed.actionUid.state);
	if (curState === undefined) {
		return `State ${parsed.actionUid.state} is not actionable`;
	}
	return { actionUid: parsed.actionUid, state: curState };
}

// The machine decides when actions start: an invoke record is due for every active action-leaf
// whose action is not pending yet. This covers the initial state, every transition target and
// all parallel regions — the runtime never initiates anything on its own. The id carries no
// seqId, but between two entries into the same state the action is always pending, so the
// dispatch marker is dropped in between.
function dueInvokes(state: MachineState): ActionUID[] {
	const blocked = concurrencyBlockedActionLeaves(state.ast, state.projection);
	const due: ActionUID[] = [];
	for (const leaf of state.projection.activeLeaves) {
		const node = nodeAt(state.ast, leaf);
		if (node?.kind !== "state" || blocked.has(leaf)) continue;
		// The uid of the invoke carries the INSTANCE path — that is the action's identity in the
		// log and in effect ids; the chart's declared uid keeps the template path.
		const actionUid = { ...node.action.uid, state: leaf };
		if (!state.projection.pendingActions.some((entry) => sameActionUid(entry.actionUid, actionUid))) due.push(actionUid);
	}
	for (const actor of Object.values(state.projection.actors)) {
		if (actor.status === "stopped" || actor.status === "failed" || actor.status === "cancelled") continue;
		const node = liveActorDeclaration(state, actor).states[actor.currentState];
		if (node?.kind !== "state") continue;
		const actionUid = { ...node.action.uid, state: actorStatePath(actor.occurrence, actor.currentState) };
		if (!state.projection.pendingActions.some((entry) => sameActionUid(entry.actionUid, actionUid))) due.push(actionUid);
	}
	return due;
}

// The action leaves a map's concurrency gate holds shut right now. Per limited map: instances
// already holding pending work keep their slots; idle instances take the free slots in
// activeLeaves order — the spawn fact's key order, so slots fill deterministically — and the rest
// wait. A completed instance has nothing pending and no action leaf, so it holds no slot.
//
// The host adapter reuses this exact admission view so inspector status cannot drift from the
// machine and label a gated action as running before its invoke exists.
export function concurrencyBlockedActionLeaves(ast: ChartAst, projection: BranchProjection): Set<StatePath> {
	const blocked = new Set<StatePath>();
	const running = new Map<StatePath, Set<string>>();
	for (const entry of projection.pendingActions) {
		const instance = nearestInstance(entry.actionUid.state);
		if (instance === undefined) continue;
		const keys = running.get(instance.container) ?? new Set<string>();
		keys.add(instance.key);
		running.set(instance.container, keys);
	}
	for (const leaf of projection.activeLeaves) {
		if (nodeAt(ast, leaf)?.kind !== "state") continue;
		const instance = nearestInstance(leaf);
		if (instance === undefined) continue;
		const container = nodeAt(ast, instance.container);
		if (container?.kind !== "map" || container.concurrency === undefined) continue;
		const keys = running.get(instance.container) ?? new Set<string>();
		if (keys.has(instance.key)) continue;
		if (keys.size >= container.concurrency) {
			blocked.add(leaf);
			continue;
		}
		keys.add(instance.key);
		running.set(instance.container, keys);
	}
	return blocked;
}

// A bare map leaf is a placeholder awaiting its fan-out: resolve `over` from the same facts
// templates render from and pin the keys and items as a spawned fact. Replay reads the fact and
// never re-resolves — the instances are frozen at birth.
function dueSpawns(state: MachineState): RecordAppend[] {
	const appends: RecordAppend[] = [];
	for (const leaf of state.projection.activeLeaves) {
		const node = nodeAt(state.ast, leaf);
		if (node?.kind !== "map" || lastSegmentKey(leaf) !== undefined) continue;
		const over = resolveRef(state, node.over, leaf);
		const instances = Array.isArray(over) ? Object.fromEntries(over.map((item, index) => [String(index), item])) : over;
		if (typeof instances !== "object" || instances === null) {
			throw new Error(`Map ${leaf}: 'over' must resolve to a record or an array, got ${typeof over}`);
		}
		for (const key of Object.keys(instances)) {
			if (!/^[A-Za-z0-9_-]+$/.test(key)) {
				throw new Error(`Map ${leaf}: instance key '${key}' must match [A-Za-z0-9_-]+`);
			}
		}
		appends.push({
			kind: "append",
			id: `spawn:${leaf}`,
			records: [{ type: "spawned", path: leaf, instances: instances as Record<string, unknown> }],
		});
	}
	return appends;
}

function ownerOccurrencesForActor(state: MachineState, declaration: ActorDeclarationAst): Array<StatePath | undefined> {
	if (declaration.owner === undefined) return [undefined];
	const ownerNode = nodeAt(state.ast, declaration.owner);
	if (ownerNode?.kind === "map") {
		const occurrences: StatePath[] = [];
		for (const [mapPath, instances] of Object.entries(state.projection.spawns)) {
			if (templatePath(mapPath) !== declaration.owner) continue;
			for (const key of Object.keys(instances)) {
				const occurrence = `${mapPath}#${key}`;
				if (state.projection.activeLeaves.some((leaf) => underScope(leaf, occurrence))) occurrences.push(occurrence);
			}
		}
		return occurrences;
	}
	const occurrences = new Set<StatePath>();
	for (const leaf of state.projection.activeLeaves) {
		const concrete = instancePathFor(declaration.owner, leaf);
		if (underScope(leaf, concrete)) occurrences.add(concrete);
	}
	return [...occurrences];
}

function dueActorCreates(state: MachineState): ActorCreateEffect[] {
	const effects: ActorCreateEffect[] = [];
	for (const declaration of Object.values(state.ast.actors)) {
		for (const owner of ownerOccurrencesForActor(state, declaration)) {
			const logicalOccurrence = actorOccurrencePath(declaration, owner);
			const generations = Object.values(state.projection.actors)
				.filter((actor) => actor.logicalOccurrence === logicalOccurrence)
				.sort((left, right) => right.generation - left.generation);
			const latest = generations[0];
			if (latest !== undefined && (declaration.owner === undefined || latest.status !== "stopped" || actorOwnerIsClosing(state, latest))) continue;
			const generation = (latest?.generation ?? 0) + 1;
			const occurrence = actorGenerationPath(logicalOccurrence, generation);
			const scope = owner ?? state.projection.activeLeaves[0] ?? state.ast.initial;
			effects.push({
				kind: "actor_create",
				id: `actor:create:${occurrence}`,
				declaration,
				occurrence,
				generation,
				...(owner === undefined ? {} : { owner }),
				input: resolveValueAst(state, declaration.inputValue, scope),
			});
		}
	}
	return effects;
}

function messagingStates(state: MachineState): Array<{ path: StatePath; node: Extract<ActorWorkflowStateAst | import("./types.js").StateAst, { kind: "send" | "call" }> }> {
	const states: Array<{ path: StatePath; node: Extract<ActorWorkflowStateAst | import("./types.js").StateAst, { kind: "send" | "call" }> }> = [];
	for (const leaf of state.projection.activeLeaves) {
		const node = nodeAt(state.ast, leaf);
		if (node?.kind === "send" || node?.kind === "call") states.push({ path: leaf, node });
	}
	for (const actor of Object.values(state.projection.actors)) {
		if (actor.status === "stopped" || actor.status === "failed" || actor.status === "cancelled") continue;
		const node = liveActorDeclaration(state, actor).states[actor.currentState];
		if (node?.kind === "send" || node?.kind === "call") states.push({ path: actorStatePath(actor.occurrence, actor.currentState), node });
	}
	return states;
}

function targetActorForProducer(state: MachineState, declaration: StatePath, producerState: StatePath): BranchProjection["actors"][string] | undefined {
	const logicalOccurrence = instancePathFor(declaration, producerState);
	return Object.values(state.projection.actors)
		.filter((actor) => actor.logicalOccurrence === logicalOccurrence && actor.status !== "stopped" && actor.status !== "failed" && actor.status !== "cancelled")
		.sort((left, right) => right.generation - left.generation)[0];
}

function producerMayUseClosingActor(state: MachineState, producerState: StatePath): boolean {
	const context = actorContextForState(state.ast, producerState);
	return context !== undefined && state.projection.actors[context.occurrence]?.currentMessage !== undefined;
}

function dueActorAdmissionFailures(state: MachineState): RecordAppend[] {
	for (const { path, node } of messagingStates(state)) {
		const target = targetActorForProducer(state, node.to, path);
		if (target !== undefined && (target.status === "closing" || target.status === "draining") && !producerMayUseClosingActor(state, path)) {
			return [{
				kind: "append",
				id: `failure:closing-admission:${path}:${target.occurrence}`,
				records: [{ type: "failure_intent", origin: path, error: `External ${node.kind} cannot target closing actor ${target.logicalOccurrence}` }],
			}];
		}
	}
	return [];
}

function dueActorEnqueues(state: MachineState): ActorEnqueueEffect[] {
	const effects: ActorEnqueueEffect[] = [];
	for (const { path, node } of messagingStates(state)) {
		if (node.kind === "call" && Object.values(state.projection.pendingActorCalls).some((call) => call.callerState === path)) continue;
		const target = targetActorForProducer(state, node.to, path);
		if (target === undefined) continue;
		if ((target.status === "closing" || target.status === "draining") && !producerMayUseClosingActor(state, path)) continue;
		const contract = liveActorDeclaration(state, target).protocol[node.event];
		if (contract === undefined) throw new Error(`${node.kind} in ${path} names unknown protocol message ${node.event}`);
		const visit = (state.projection.actorProducerVisits[path] ?? 0) + 1;
		const values = node.kind === "send" && node.inputs !== undefined
			? resolveValueAst(state, node.inputs, path)
			: [resolveValueAst(state, node.kind === "send" ? (node.input ?? null) : node.input, path)];
		if (!Array.isArray(values)) throw new Error(`Batch send in ${path} must resolve inputs to an array`);
		if (values.length === 0) throw new Error(`Batch send in ${path} must contain at least one message`);
		if (node.kind === "call" && values.length !== 1) throw new Error(`call() in ${path} sends exactly one message`);
		const callId = node.kind === "call" ? `${path}:call:${visit}` : undefined;
		const messages = values.map((input, batchIndex): ActorMessageEnvelope => ({
			messageId: `${path}:message:${visit}:${batchIndex}`,
			event: node.event,
			input,
			producerState: path,
			producerVisit: visit,
			...(callId === undefined ? {} : { callId }),
			batchIndex,
		}));
		const source: ActorMessageSource = { producerState: path, kind: node.kind, definition: node, targetDeclaration: node.to, event: node.event, inputSchema: contract.input };
		effects.push({ kind: "actor_enqueue", id: `actor:enqueue:${path}:${visit}`, occurrence: target.occurrence, generation: target.generation, schema: contract.input, source, messages });
	}
	return effects;
}

function dueActorAccepts(state: MachineState): RecordAppend[] {
	const ready: Array<{ actor: BranchProjection["actors"][string]; head: ActorMessageEnvelope }> = [];
	for (const actor of Object.values(state.projection.actors)) {
		if (actor.currentMessage !== undefined || actor.mailbox.length === 0 || actor.status === "stopped" || actor.status === "cancelled" || actor.status === "failed") continue;
		const receive = liveActorDeclaration(state, actor).states[actor.currentState];
		if (receive?.kind !== "receive") continue;
		const head = actor.mailbox[0];
		if (head === undefined) continue;
		if (receive.on[head.event] === undefined) {
			return [{
				kind: "append",
				id: `failure:unsupported-head:${actor.occurrence}:${head.messageId}`,
				records: [{
					type: "failure_intent",
					origin: actorStatePath(actor.occurrence, actor.currentState),
					error: `FIFO head '${head.event}' is unsupported by receive '${actor.currentState}'`,
				}],
			}];
		}
		ready.push({ actor, head });
	}
	return ready.map(({ actor, head }) => ({
		kind: "append",
		id: `actor:accept:${actor.occurrence}:${head.messageId}`,
		records: [{ type: "actor_message", kind: "accepted", occurrence: actor.occurrence, messageId: head.messageId, receiveState: actorStatePath(actor.occurrence, actor.currentState) }],
	}));
}

function dueActorReplies(state: MachineState): ActorReplyEffect[] {
	const effects: ActorReplyEffect[] = [];
	for (const actor of Object.values(state.projection.actors)) {
		const message = actor.currentMessage;
		const definition = liveActorDeclaration(state, actor);
		const reply = definition.states[actor.currentState];
		if (message === undefined || reply?.kind !== "reply" || message.status === "replied") continue;
		const contract = definition.protocol[message.event]?.reply;
		if (contract === undefined) throw new Error(`Actor ${actor.occurrence} has no protocol contract for ${message.event}`);
		const schema = contract.kind === "single" ? contract.schema : contract.kind === "named" && reply.event !== undefined ? contract.schemas[reply.event] : undefined;
		const output = reply.output === undefined ? undefined : resolveValueAst(state, reply.output, actorStatePath(actor.occurrence, actor.currentState));
		effects.push({
			kind: "actor_reply",
			id: `actor:reply:${actor.occurrence}:${message.messageId}`,
			occurrence: actor.occurrence,
			messageId: message.messageId,
			message: message.event,
			...(message.callId === undefined ? {} : { callId: message.callId, callerState: message.producerState }),
			...(reply.event === undefined ? {} : { replyEvent: reply.event }),
			...(reply.output === undefined ? {} : { output }),
			...(schema === undefined ? {} : { schema }),
		});
	}
	return effects;
}

function liveActorDeclaration(state: MachineState, actor: BranchProjection["actors"][string]): ActorDeclarationAst {
	const declaration = state.ast.actors[actor.declaration];
	if (declaration === undefined) throw new Error(`Actor ${actor.occurrence} declaration ${actor.declaration} is missing from the live chart`);
	return declaration;
}

function actorOwnerIsClosing(state: MachineState, actor: BranchProjection["actors"][string]): boolean {
	if (actor.owner === undefined) return state.projection.activeLeaves.some((leaf) => {
		const node = nodeAt(state.ast, leaf);
		return node?.kind === "final" && node.parent === undefined;
	});
	const ownerNode = nodeAt(state.ast, actor.owner);
	const leaves = state.projection.activeLeaves.filter((leaf) => underScope(leaf, actor.owner as string));
	if (ownerNode?.kind === "map" && leaves.length > 0) return leaves.every((leaf) => nodeAt(state.ast, leaf)?.kind === "final");
	return leaves.length === 0 || leaves.every((leaf) => nodeAt(state.ast, leaf)?.kind === "final");
}

function dueActorScopeFacts(state: MachineState): RecordAppend[] {
	const appends: RecordAppend[] = [];
	const enqueueTargets = new Set(dueActorEnqueues(state).map((effect) => effect.occurrence));
	for (const actor of Object.values(state.projection.actors)) {
		if ((actor.status === "idle" || actor.status === "busy") && actorOwnerIsClosing(state, actor) && !enqueueTargets.has(actor.occurrence)) {
			appends.push({ kind: "append", id: `actor:closing:${actor.occurrence}`, records: [{ type: "actor_scope", kind: "closing", occurrence: actor.occurrence }] });
			continue;
		}
		if ((actor.status === "closing" || actor.status === "draining") && actor.currentMessage === undefined && actor.mailbox.length === 0) {
			appends.push({ kind: "append", id: `actor:stopped:${actor.occurrence}`, records: [{ type: "actor_scope", kind: "stopped", occurrence: actor.occurrence }] });
		}
	}
	return appends;
}

function actorsTerminalForRun(state: MachineState): boolean {
	const rootDeclarations = Object.values(state.ast.actors).filter((actor) => actor.owner === undefined);
	if (rootDeclarations.some((declaration) => !Object.values(state.projection.actors).some((actor) => actor.declaration === declaration.path && actor.status === "stopped"))) return false;
	return Object.values(state.projection.actors).every((actor) => actor.status === "stopped");
}

function resolveValueAst(state: MachineState, value: ValueAst, stateId: StatePath): unknown {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map((entry) => resolveValueAst(state, entry, stateId));
	if (isInputRef(value)) return resolveRef(state, value, stateId);
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveValueAst(state, entry, stateId)]));
}

// Templates are rendered, never logged: the same args/results facts always render to the same
// text, so a restarted machine hands the agent an identical call. This is the effect boundary —
// the last moment the engine holds the value — so the parameter contract is enforced here: a ref
// into a missing arg/result and a non-primitive value without a json() mark both fail loud.
export function renderTemplate(state: MachineState, template: TemplateAst, stateId: string): string {
	const parts: string[] = [template.strings[0] ?? ""];
	template.refs.forEach((ref, index) => {
		parts.push(renderValue(resolveRef(state, ref, stateId), ref, stateId));
		parts.push(template.strings[index + 1] ?? "");
	});
	return parts.join("");
}

function renderValue(value: unknown, ref: InputRef, stateId: string): string {
	if (ref.json === true) {
		const text = JSON.stringify(value);
		if (text === undefined) {
			throw new Error(`Template in state ${stateId}: ${refLabel(ref)} is not JSON-serializable`);
		}
		return text;
	}
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	throw new Error(
		`Template in state ${stateId}: ${refLabel(ref)} resolved to a non-primitive value; wrap the ref in json() to embed it as JSON`,
	);
}

function renderArtifact(state: MachineState, declared: ArtifactAst, stateId: string): RenderedArtifact {
	return {
		path: renderTemplate(state, declared.path, stateId),
		...(declared.shape === undefined ? {} : { shape: declared.shape }),
	};
}

// An artifactOf read resolves to the producer's declared artifact — rendered from the same facts, so
// path and shape can never drift from what the producer was told to write. Normalize guarantees
// the reference resolves to exactly one artifact; a miss here means the chart changed under a
// live log — fail loud.
export function renderRead(
	state: MachineState,
	read: TemplateAst | ArtifactOfAst,
	stateId: string,
	selfActionArtifactsState?: StatePath,
): RenderedArtifact {
	if (read.kind === "template") {
		return { path: renderTemplate(state, read, stateId) };
	}
	const actor = actorContextForState(state.ast, stateId);
	const producerState = actor === undefined ? instancePathFor(read.state, stateId) : actorStatePath(actor.occurrence, read.state);
	const producer = actionStateAtMachine(state.ast, producerState);
	const artifacts = producer === undefined
		? undefined
		: producerState === selfActionArtifactsState && producer.action.kind !== "user"
			? producer.action.artifacts
			: declaredArtifactsForState(producer);
	const names = Object.keys(artifacts ?? {});
	const name = read.artifact ?? (names.length === 1 ? names[0] : undefined);
	const declared = name === undefined ? undefined : artifacts?.[name];
	if (declared === undefined) {
		throw new Error(`Read in state ${stateId}: cannot resolve artifact '${read.artifact ?? "*"}' of ${read.state}`);
	}
	return {
		...renderArtifact(state, declared, producerState),
		...(name === undefined ? {} : { name }),
		sourceState: producerState,
		...(read.select === undefined ? {} : { select: read.select }),
	};
}

// A fan-in read over a map: one artifact per spawned instance, in spawn-fact key order. The
// producer's declared path renders in each instance's scope — key()/item() and result() refs in
// it resolve exactly as they did for the producer itself.
export function renderJoin(state: MachineState, read: JoinArtifactOfAst, stateId: string): RenderedArtifact[] {
	const container = enclosingMapPath(state.ast, read.state, stateId);
	// A top-level map has one shared spawn fact. A nested map has one spawn fact per enclosing
	// parent instance (for example `chapters#intro.visuals`). Re-scope the template container to
	// the caller, then strip the joined map's own instance key: a join inside `items#a.check` still
	// fans in all `items`, while a join inside `chapters#intro` fans in only that chapter's nested
	// `visuals` instances.
	const mapPath = stripLastKey(instancePathFor(container, stateId));
	const instances = state.projection.spawns[mapPath];
	if (instances === undefined) {
		throw new Error(`Read in state ${stateId}: map ${mapPath} has no spawned instances`);
	}
	const single: ArtifactOfAst = {
		kind: "artifactOf",
		state: read.state,
		...(read.artifact === undefined ? {} : { artifact: read.artifact }),
	};
	return Object.keys(instances).map((key) => ({
		...renderRead(state, single, `${mapPath}#${key}${read.state.slice(container.length)}`),
		readKind: "join" as const,
	}));
}

// The innermost map the producer's template path sits in — the container whose instances the
// fan-in expands over. Normalize guarantees one exists; a miss means the chart changed under a
// live log.
function enclosingMapPath(ast: ChartAst, producer: StatePath, stateId: string): StatePath {
	let path = parentPath(producer);
	while (path !== undefined) {
		if (nodeAt(ast, path)?.kind === "map") return path;
		path = parentPath(path);
	}
	throw new Error(`Read in state ${stateId}: joinArtifactOf('${producer}') is not inside a map`);
}

function refLabel(ref: InputRef): string {
	switch (ref.kind) {
		case "arg":
			return `arg '${ref.name}'`;
		case "result":
			return `result of '${ref.state}'${ref.path === undefined ? "" : ` at '${ref.path}'`}`;
		case "key":
			return `map key${ref.map === undefined ? "" : ` of '${ref.map}'`}`;
		case "item":
			return `map item${ref.map === undefined ? "" : ` of '${ref.map}'`}${ref.path === undefined ? "" : ` at '${ref.path}'`}`;
		case "input":
			return `input '${ref.name}'${ref.path === undefined ? "" : ` at '${ref.path}'`}`;
		case "visit":
			return `visit${ref.state === undefined ? "" : ` of '${ref.state}'`}`;
		case "actorInput":
			return `actor input${ref.path === undefined ? "" : ` at '${ref.path}'`}`;
		case "messageInput":
			return `message '${ref.message}' input${ref.path === undefined ? "" : ` at '${ref.path}'`}`;
	}
}

// stateId is the referencing action's INSTANCE path: result lookups re-scope into it, key/item
// resolve against its nearest enclosing map's spawn fact.
function resolveRef(state: MachineState, ref: InputRef, stateId: string): unknown {
	const actorContext = actorContextForState(state.ast, stateId);
	const actor = actorContext === undefined ? undefined : state.projection.actors[actorContext.occurrence];
	if (ref.kind === "actorInput") {
		if (actor === undefined) throw new Error(`Template in state ${stateId}: actorInput() used outside an actor`);
		return selectPath(actor.input, ref.path, ref, stateId);
	}
	if (ref.kind === "messageInput") {
		const message = actor?.currentMessage;
		if (message === undefined || message.event !== ref.message) throw new Error(`Template in state ${stateId}: messageInput('${ref.message}') does not match the current message`);
		return selectPath(message.input, ref.path, ref, stateId);
	}
	if (ref.kind === "arg") {
		const args = state.projection.args;
		if (args === undefined || !(ref.name in args)) {
			throw new Error(`Template in state ${stateId}: no argument '${ref.name}'`);
		}
		return args[ref.name];
	}
	if (ref.kind === "visit") {
		return resolveVisitRef(state, ref, stateId);
	}
	if (ref.kind === "input") {
		const slot = inputSlotFor(state, ref.name, stateId);
		if (slot === undefined || !(ref.name in slot.values)) {
			throw new Error(`Template in state ${stateId}: no input '${ref.name}'`);
		}
		return selectPath(slot.values[ref.name], ref.path, ref, stateId);
	}
	if (ref.kind === "key" || ref.kind === "item") {
		const instance = nearestInstance(stateId, ref.map);
		if (instance === undefined) {
			throw new Error(`Template in state ${stateId}: ${refLabel(ref)} used outside any map instance`);
		}
		const occurrenceInput = state.projection.inputs[`${instance.container}#${instance.key}`];
		const instances = state.projection.spawns[instance.container];
		if (instances === undefined || !(instance.key in instances)) {
			throw new Error(`Template in state ${stateId}: no spawned instance '${instance.key}' of ${instance.container}`);
		}
		if (ref.kind === "key") return occurrenceInput?.key ?? instance.key;
		return selectPath(occurrenceInput?.item ?? instances[instance.key], ref.path, ref, stateId);
	}
	const resultKey = actorContext === undefined
		? instancePathFor(ref.state, stateId)
		: actorStatePath(actorContext.occurrence, ref.state);
	if (!(resultKey in state.projection.results)) {
		throw new Error(`Template in state ${stateId}: no result for state ${resultKey}`);
	}
	return selectPath(state.projection.results[resultKey], ref.path, ref, stateId);
}

function resolveVisitRef(state: MachineState, ref: Extract<InputRef, { kind: "visit" }>, stateId: string): number {
	const actor = actorContextForState(state.ast, stateId);
	const target = ref.state === undefined
		? stateId
		: actor === undefined
			? instancePathFor(ref.state, stateId)
			: actorStatePath(actor.occurrence, ref.state);
	const node = actionStateAtMachine(state.ast, target);
	if (node === undefined) {
		throw new Error(`Template in state ${stateId}: ${refLabel(ref)} does not reference an action state`);
	}
	const key = actionUidKey({ ...node.action.uid, state: target });
	const visit = state.projection.stateVisits[key];
	if (visit === undefined) {
		throw new Error(`Template in state ${stateId}: no visit for state ${target}`);
	}
	return visit;
}

function inputSlotFor(
	state: MachineState,
	name: string,
	stateId: string,
): { path: StatePath; values: Record<string, unknown> } | undefined {
	const actor = actorContextForState(state.ast, stateId);
	if (actor?.node.kind === "state" && actor.node.input !== undefined && name in actor.node.input) {
		return { path: stateId, values: state.projection.inputs[stateId] ?? {} };
	}
	let cur: StatePath | undefined = stateId;
	while (cur !== undefined) {
		const node = nodeAt(state.ast, cur);
		if ((node?.kind === "state" || node?.kind === "map") && node.input !== undefined && name in node.input) {
			const key = node.kind === "map" ? stripLastKey(cur) : cur;
			return { path: key, values: state.projection.inputs[key] ?? {} };
		}
		cur = parentPath(cur);
	}
	return undefined;
}

function selectPath(value: unknown, path: string | undefined, ref: InputRef, stateId: string): unknown {
	if (path === undefined) {
		return value;
	}
	let current = value;
	for (const segment of path.split(".")) {
		if (typeof current !== "object" || current === null || !(segment in current)) {
			throw new Error(`Template in state ${stateId}: ${refLabel(ref)} has no '${path}'`);
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function invokeAppend(state: MachineState, actionUid: ActionUID): RecordAppend {
	const node = actionStateAtMachine(state.ast, actionUid.state);
	if (node === undefined) throw new Error(`Cannot invoke non-action state ${actionUid.state}`);
	return {
		kind: "append",
		id: `invoke:${actionUidKey(actionUid)}`,
		records: [
			{
				type: "state_action",
				kind: "invoke",
				actionUid,
				definition: node.action,
			},
		],
	};
}

function hasActionTransition(ast: ChartAst, statePath: StatePath, event: string): boolean {
	const actor = actorContextForState(ast, statePath)?.node;
	return actor?.kind === "state" ? actor.transitions[event] !== undefined : hasTransition(ast, statePath, event);
}

function allowedEventsForAction(ast: ChartAst, statePath: StatePath): string[] {
	const actor = actorContextForState(ast, statePath)?.node;
	if (actor?.kind === "state") return Object.keys(actor.transitions);
	return allowedEvents(ast, statePath);
}

function actionStateAtMachine(ast: ChartAst, statePath: StatePath): ActionStateAst | undefined {
	const main = nodeAt(ast, statePath);
	if (main?.kind === "state") return main;
	const actor = actorContextForState(ast, statePath)?.node;
	return actor?.kind === "state" ? actor : undefined;
}

export function createMachine(ast: ChartAst, projection: BranchProjection): MachineState {
	return { ast, projection, dispatched: new Set() };
}
