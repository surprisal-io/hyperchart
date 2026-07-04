import type {
	ChartEvent,
	ActionStateAst,
	ActionUID,
	AgentActionAst,
	ChartAst,
	GuardOutcome,
	ArtifactAst,
	ArtifactOfAst,
	JoinArtifactOfAst,
	GuardRef,
	InputRef,
	OnReject,
	SchemaAst,
	ScriptActionAst,
	StatePath,
	TemplateAst,
	UserActionAst,
} from "./types.js";
import type { DurableLogRecord } from "./durable_events.js";
import { actionUidKey } from "./action_uid.js";
import {
	allowedEvents,
	type BranchProjection,
	hasTransition,
	isFinalState,
	type PendingAction,
	projectBranch,
} from "./projection.js";
import { instancePathFor, lastSegmentKey, matchesDeclaredUid, nearestInstance, nodeAt, parentPath } from "./paths.js";

export type MachineState = {
	ast: ChartAst;
	projection: BranchProjection;
	// Ids of effects already dispatched in this machine lifetime. Guards against dispatching the
	// same invoke/run/validation/feedback twice; starts empty on restart, so unfinished work
	// re-runs.
	dispatched: Set<EffectId>;
};

export type EffectId = string;

// A file parameter with its path rendered and — when the producer declared one — the shape of
// its content; the runtime uses the shape both to instruct the agent and to verify the file.
export type RenderedArtifact = Readonly<{
	// Present on the producing side: the artifact's declared name.
	name?: string;
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
}>;

export type UserEffect = Readonly<{
	kind: "user";
	id: EffectId;
	actionUid: ActionUID;
	action: UserActionAst;
	prompt: string;
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

// Asks the runtime to run the state's validator against an action's completion. The runtime
// answers with a `validated` event; the completion is not processed until then.
export type ValidateEffect = Readonly<{
	kind: "validate";
	id: EffectId;
	actionUid: ActionUID;
	guard: GuardRef;
	event: ChartEvent;
}>;

// A completion did not pass the state's validate check. The action is still pending; the runtime
// must deliver the feedback per onReject, and the action completes again with a fixed result.
export type RejectedEffect = Readonly<{
	kind: "rejected";
	id: EffectId;
	actionUid: ActionUID;
	event: ChartEvent;
	onReject: OnReject;
	// Which rejected round this is (1-based); the budget lives in the state's `retries`.
	attempt: number;
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
	| TimerMachineEvent;

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
	if (isFinalState(state.projection, state.ast)) {
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
		...dueInvokes(state).map(invokeAppend),
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
	return actionEffectId(pending.actionUid, pending.attemptId, pending.seqId);
}

function actionEffectId(actionUid: ActionUID, attemptId: number, seqId: number): EffectId {
	return `${actionUidKey(actionUid)}:${attemptId}:${seqId}`;
}

// All effects a pending action currently wants: its phase effect, plus — while running under a
// deadline — the timer racing it.
function pendingEffects(state: MachineState, pending: PendingAction): Effect[] {
	const ast = state.ast;
	const effects = [pendingEffect(state, pending)];
	if (pending.phase === "running") {
		const node = nodeAt(ast, pending.actionUid.state);
		if (node?.kind === "state" && node.after !== undefined) {
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
	return actionEffectId(pending.actionUid, pending.attemptId, pending.seqId);
}

function pendingEffect(state: MachineState, pending: PendingAction): Effect {
	const node = nodeAt(state.ast, pending.actionUid.state);
	if (node?.kind !== "state" || !matchesDeclaredUid(pending.actionUid, node.action.uid)) {
		throw new Error(`Pending action does not match the chart in state ${pending.actionUid.state}`);
	}
	const id = pendingEffectId(pending);
	switch (pending.phase) {
		case "running":
			return actionInvocationForAction(state, pending.actionUid, node.action, id);
		case "validating":
			if (node.validate === undefined) {
				throw new Error(`Cannot validate a completion for state ${pending.actionUid.state} without a validator`);
			}
			return { kind: "validate", id, actionUid: pending.actionUid, guard: node.validate, event: pending.event };
		case "rejected":
			return {
				kind: "rejected",
				id,
				actionUid: pending.actionUid,
				event: pending.event,
				onReject: node.onReject ?? "resume",
				attempt: pending.rejections,
				...(pending.reason === undefined ? {} : { reason: pending.reason }),
				invocation: actionInvocationForAction(
					state,
					pending.actionUid,
					node.action,
					actionEffectId(pending.actionUid, pending.attemptId, pending.invokeSeqId),
				),
			};
	}
}

function actionInvocationForAction(
	state: MachineState,
	actionUid: ActionUID,
	action: ActionStateAst["action"],
	id: EffectId,
): ActionEffect {
	switch (action.kind) {
		case "agent":
			return agentInvocationForAction(state, actionUid, action, id);
		case "script":
			return scriptInvocationForAction(state, actionUid, action, id);
		case "user":
			return userInvocationForAction(state, actionUid, action, id);
	}
}

function agentInvocationForAction(
	state: MachineState,
	actionUid: ActionUID,
	action: AgentActionAst,
	id: EffectId,
): AgentEffect {
	return {
		kind: "agent",
		id,
		actionUid,
		action,
		events: allowedEvents(state.ast, actionUid.state),
		...(action.reply === undefined ? {} : { reply: action.reply }),
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
		events: allowedEvents(state.ast, actionUid.state),
		...(action.reply === undefined ? {} : { reply: action.reply }),
		...(action.env === undefined
			? {}
			: {
					env: Object.fromEntries(
						Object.entries(action.env).map(([name, value]) => {
							if (value.kind === "template") {
								return [name, renderTemplate(state, value, actionUid.state)];
							}
							if (value.kind === "joinArtifactOf") {
								const paths = renderJoin(state, value, actionUid.state).map((read) => read.path);
								return [name, JSON.stringify(paths)];
							}
							const read = renderRead(state, value, actionUid.state);
							return [name, read.select === undefined ? read.path : read];
						}),
					),
				}),
		...(action.artifacts === undefined
			? {}
			: {
					artifacts: Object.entries(action.artifacts).map(([name, declared]) => ({
						name,
						...renderArtifact(state, declared, actionUid.state),
					})),
				}),
	};
}

function userInvocationForAction(
	state: MachineState,
	actionUid: ActionUID,
	action: UserActionAst,
	id: EffectId,
): UserEffect {
	return {
		kind: "user",
		id,
		actionUid,
		action,
		prompt: renderTemplate(state, action.prompt, actionUid.state),
	};
}

function effectIdParts(id: EffectId): { actionUid: ActionUID; attemptId: number; seqId: number } | null {
	const [chart, state, action, attempt, seq] = id.split(":");
	const attemptId = Number(attempt);
	const seqId = Number(seq);
	if (!chart || !state || !action || !Number.isInteger(attemptId) || !Number.isInteger(seqId)) {
		return null;
	}

	return { actionUid: { chart, state, action }, attemptId, seqId };
}

function sameActionUid(left: ActionUID, right: ActionUID): boolean {
	return left.chart === right.chart && left.state === right.state && left.action === right.action;
}

export function stepMachine(state: MachineState, event: MachineEvent): MachineOutput {
	switch (event.kind) {
		case "agent":
		case "script": {
			const pending = findPendingAction(state, event.effectId);
			if (pending === null) {
				// The action is no longer pending — it lost a race (e.g. its timer fired first).
				// The late completion is ignored.
				break;
			}
			if (typeof pending === "string") {
				return { kind: "error", state, error: pending };
			}
			if (!hasTransition(state.ast, pending.actionUid.state, event.event.type)) {
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
			const node = nodeAt(state.ast, validating.actionUid.state);
			if (node?.kind !== "state" || node.validate === undefined) {
				return { kind: "error", state, error: `State ${validating.actionUid.state} has no validator` };
			}
			// The verdict is a fact: stored with the guard ref that produced it, never re-evaluated
			// on replay. Whether it accepts (transition) or rejects (feedback) is the projection's job.
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
					],
				},
			]);
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
		case "user":
			// User actions are not implemented yet; the event is accepted but ignored.
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
		(el) => sameActionUid(el.actionUid, parsed.actionUid) && el.attemptId === parsed.attemptId,
	);
	if (!pending || pendingEffectId(pending) !== effectId) {
		return null;
	}
	if (pending.phase === "validating") {
		return `Validation already in flight for ${effectId}`;
	}
	const curState = nodeAt(machine.ast, parsed.actionUid.state);
	if (curState?.kind !== "state") {
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
	const blocked = blockedInstances(state);
	const due: ActionUID[] = [];
	for (const leaf of state.projection.activeLeaves) {
		const node = nodeAt(state.ast, leaf);
		if (node?.kind !== "state" || blocked.has(leaf)) continue;
		// The uid of the invoke carries the INSTANCE path — that is the action's identity in the
		// log and in effect ids; the chart's declared uid keeps the template path.
		const actionUid = { ...node.action.uid, state: leaf };
		if (!state.projection.pendingActions.some((entry) => sameActionUid(entry.actionUid, actionUid))) {
			due.push(actionUid);
		}
	}
	return due;
}

// The leaves a map's concurrency gate holds shut right now. Per limited map: instances already
// holding pending work keep their slots; idle instances take the free slots in activeLeaves
// order — the spawn fact's key order, so slots fill deterministically — and the rest wait. A
// completed instance has nothing pending and no action leaf, so it holds no slot.
function blockedInstances(state: MachineState): Set<StatePath> {
	const blocked = new Set<StatePath>();
	const running = new Map<StatePath, Set<string>>();
	for (const entry of state.projection.pendingActions) {
		const instance = nearestInstance(entry.actionUid.state);
		if (instance === undefined) continue;
		const keys = running.get(instance.container) ?? new Set<string>();
		keys.add(instance.key);
		running.set(instance.container, keys);
	}
	for (const leaf of state.projection.activeLeaves) {
		if (nodeAt(state.ast, leaf)?.kind !== "state") continue;
		const instance = nearestInstance(leaf);
		if (instance === undefined) continue;
		const container = nodeAt(state.ast, instance.container);
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

// Templates are rendered, never logged: the same args/results facts always render to the same
// text, so a restarted machine hands the agent an identical call. This is the effect boundary —
// the last moment the engine holds the value — so the parameter contract is enforced here: a ref
// into a missing arg/result and a non-primitive value without a json() mark both fail loud.
function renderTemplate(state: MachineState, template: TemplateAst, stateId: string): string {
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
function renderRead(state: MachineState, read: TemplateAst | ArtifactOfAst, stateId: string): RenderedArtifact {
	if (read.kind === "template") {
		return { path: renderTemplate(state, read, stateId) };
	}
	const producer = nodeAt(state.ast, read.state);
	const artifacts =
		producer?.kind === "state" && producer.action.kind !== "user" ? producer.action.artifacts : undefined;
	const names = Object.keys(artifacts ?? {});
	const name = read.artifact ?? (names.length === 1 ? names[0] : undefined);
	const declared = name === undefined ? undefined : artifacts?.[name];
	if (declared === undefined) {
		throw new Error(`Read in state ${stateId}: cannot resolve artifact '${read.artifact ?? "*"}' of ${read.state}`);
	}
	return {
		...renderArtifact(state, declared, stateId),
		...(read.select === undefined ? {} : { select: read.select }),
	};
}

// A fan-in read over a map: one artifact per spawned instance, in spawn-fact key order. The
// producer's declared path renders in each instance's scope — key()/item() and result() refs in
// it resolve exactly as they did for the producer itself.
function renderJoin(state: MachineState, read: JoinArtifactOfAst, stateId: string): RenderedArtifact[] {
	const container = enclosingMapPath(state.ast, read.state, stateId);
	const mapPath = instancePathFor(container, stateId);
	const instances = state.projection.spawns[mapPath];
	if (instances === undefined) {
		throw new Error(`Read in state ${stateId}: map ${mapPath} has no spawned instances`);
	}
	const single: ArtifactOfAst = {
		kind: "artifactOf",
		state: read.state,
		...(read.artifact === undefined ? {} : { artifact: read.artifact }),
	};
	return Object.keys(instances).map((key) =>
		renderRead(state, single, `${mapPath}#${key}${read.state.slice(container.length)}`),
	);
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
	}
}

// stateId is the referencing action's INSTANCE path: result lookups re-scope into it, key/item
// resolve against its nearest enclosing map's spawn fact.
function resolveRef(state: MachineState, ref: InputRef, stateId: string): unknown {
	if (ref.kind === "arg") {
		const args = state.projection.args;
		if (args === undefined || !(ref.name in args)) {
			throw new Error(`Template in state ${stateId}: no argument '${ref.name}'`);
		}
		return args[ref.name];
	}
	if (ref.kind === "key" || ref.kind === "item") {
		const instance = nearestInstance(stateId, ref.map);
		if (instance === undefined) {
			throw new Error(`Template in state ${stateId}: ${refLabel(ref)} used outside any map instance`);
		}
		const instances = state.projection.spawns[instance.container];
		if (instances === undefined || !(instance.key in instances)) {
			throw new Error(`Template in state ${stateId}: no spawned instance '${instance.key}' of ${instance.container}`);
		}
		if (ref.kind === "key") {
			return instance.key;
		}
		return selectPath(instances[instance.key], ref.path, ref, stateId);
	}
	const resultKey = instancePathFor(ref.state, stateId);
	if (!(resultKey in state.projection.results)) {
		throw new Error(`Template in state ${stateId}: no result for state ${resultKey}`);
	}
	return selectPath(state.projection.results[resultKey], ref.path, ref, stateId);
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

function invokeAppend(actionUid: ActionUID): RecordAppend {
	return {
		kind: "append",
		id: `invoke:${actionUidKey(actionUid)}`,
		records: [{ type: "state_action", kind: "invoke", actionUid }],
	};
}

export function createMachine(ast: ChartAst, projection: BranchProjection): MachineState {
	return { ast, projection, dispatched: new Set() };
}
