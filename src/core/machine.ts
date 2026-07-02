import type {
	ChartEvent,
	ActionStateAst,
	ActionUID,
	AgentActionAst,
	ChartAst,
	GuardOutcome,
	GuardRef,
	OnReject,
	UserActionAst,
} from "./types.js";
import type { DurableLogRecord } from "./durable_events.js";
import { isFinalState, projectBranch, type BranchProjection, type PendingAction } from "./projection.js";

export type MachineState = {
	ast: ChartAst;
	projection: BranchProjection;
	// Ids of effects already dispatched in this machine lifetime. Guards against dispatching the
	// same invoke/run/validation/feedback twice; starts empty on restart, so unfinished work
	// re-runs.
	dispatched: Set<EffectId>;
};

export type EffectId = string;

export type AgentEffect = Readonly<{
	kind: "agent";
	id: EffectId;
	actionUid: ActionUID;
	action: AgentActionAst;
}>;

export type UserEffect = Readonly<{
	kind: "user";
	id: EffectId;
	actionUid: ActionUID;
	action: UserActionAst;
}>;

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
	reason?: string;
}>;

export type Effect = AgentEffect | UserEffect | DurableRecordsEffect | ValidateEffect | RejectedEffect;

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

export type MachineStartEvent = Readonly<{
	kind: "start";
}>;

export type MachineEvent =
	| MachineStartEvent
	| AgentMachineEvent
	| UserMachineEvent
	| DurableRecordsAddedMachineEvent
	| ValidatedMachineEvent;

export type MachineOutput = MachineOutputEffect | MachineOutputFinal | MachineOutputError;

export type MachineOutputError = Readonly<{
	kind: "error";
	state: MachineState;
	error: string;
}>;

export type MachineOutputFinal = Readonly<{
	kind: "final";
	state: MachineState;
	result: unknown;
}>;

export type MachineOutputEffect = Readonly<{
	kind: "effect";
	state: MachineState;
	effects: Effect[];
}>;

export function createMachineOutput(state: MachineState, appends: readonly RecordAppend[]): MachineOutput {
	if (isFinalState(state.projection, state.ast)) {
		return {
			kind: "final",
			state,
			result: state.projection.results[state.projection.activeState],
		};
	}

	// What the runtime should be doing right now, derived entirely from the projection: append an
	// invoke record when the active action-state has nothing pending yet, plus exactly one effect
	// per pending action — run it, validate its completion, or deliver the rejection.
	const missing = missingInvoke(state);
	const desired: (Effect | RecordAppend)[] = state.projection.pendingActions.map((pending) =>
		pendingEffect(state.ast, pending),
	);
	if (missing) {
		desired.unshift(invokeAppend(missing));
	}

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
	const effects = [...appends, ...fresh].map((entry) => (entry.kind === "append" ? stampAppend(state, entry) : entry));

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

function actionUidKey(actionUid: ActionUID): string {
	return `${actionUid.chart}:${actionUid.state}:${actionUid.action}`;
}

// Every pending action's effect answers the log record that started its phase: invoke → run the
// action, complete → validate it, validated(false) → deliver the rejection. The record's seqId
// makes the id unique per phase, so each phase dispatches exactly once.
function pendingEffectId(pending: PendingAction): EffectId {
	return `${pending.phase}:${actionUidKey(pending.actionUid)}:${pending.seqId}`;
}

function pendingEffect(ast: ChartAst, pending: PendingAction): Effect {
	const node = ast.states[pending.actionUid.state];
	if (node?.kind !== "state" || !sameActionUid(pending.actionUid, node.action.uid)) {
		throw new Error(`Pending action does not match the chart in state ${pending.actionUid.state}`);
	}
	const id = pendingEffectId(pending);
	switch (pending.phase) {
		case "running":
			return node.action.kind === "agent"
				? { kind: "agent", id, actionUid: pending.actionUid, action: node.action }
				: { kind: "user", id, actionUid: pending.actionUid, action: node.action };
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
				...(pending.reason === undefined ? {} : { reason: pending.reason }),
			};
	}
}

function effectIdToActionUid(id: EffectId): ActionUID | null {
	const [, chart, state, action] = id.split(":");
	if (!chart || !state || !action) {
		return null;
	}

	return { chart, state, action };
}

function sameActionUid(left: ActionUID, right: ActionUID): boolean {
	return left.chart === right.chart && left.state === right.state && left.action === right.action;
}

export function stepMachine(state: MachineState, event: MachineEvent): MachineOutput {
	switch (event.kind) {
		case "agent": {
			const pending = findPendingAction(state, event.effectId);
			if (typeof pending === "string") {
				return { kind: "error", state, error: pending };
			}
			const nextStateId = pending.state.transitions[event.event.type];
			if (!nextStateId) {
				return {
					kind: "error",
					state,
					error: `No transition found for event type ${event.event.type} in state ${state.projection.activeState}`,
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
			const node = state.ast.states[validating.actionUid.state];
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
		case "start":
			// Nothing to apply: the derivation in createMachineOutput starts whatever is due.
			break;
		case "user":
			// User actions are not implemented yet; the event is accepted but ignored.
			break;
		case "durable_records_added":
			state.projection = projectBranch(state.projection, state.ast, event.records);
			break;
	}

	return createMachineOutput(state, []);
}

type PendingActionContext = {
	actionUid: ActionUID;
	state: ActionStateAst;
};

function findPendingAction(machine: MachineState, effectId: EffectId): PendingActionContext | string {
	const actionId = effectIdToActionUid(effectId);
	if (!actionId) {
		return `Invalid effectId ${effectId}`;
	}
	const pending = machine.projection.pendingActions.find((el) => sameActionUid(el.actionUid, actionId));
	if (!pending) {
		return `No pending action found for effectId ${effectId}`;
	}
	if (pending.phase === "validating") {
		return `Validation already in flight for ${effectId}`;
	}
	const curState = machine.ast.states[machine.projection.activeState];
	if (curState?.kind !== "state") {
		return `Current state ${machine.projection.activeState} is not actionable`;
	}
	return { actionUid: actionId, state: curState };
}

// The machine decides when actions start: an invoke record is due whenever the active state's
// action is not pending yet. This covers the initial state and every transition target — the
// runtime never initiates anything on its own. The id carries no seqId, but between two entries
// into the same state the action is always pending, so the dispatch marker is dropped in between.
function missingInvoke(state: MachineState): ActionUID | null {
	const node = state.ast.states[state.projection.activeState];
	if (node?.kind !== "state") {
		return null;
	}
	const actionUid = node.action.uid;
	const pending = state.projection.pendingActions.some((entry) => sameActionUid(entry.actionUid, actionUid));
	return pending ? null : actionUid;
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
