import type { ChartEvent, ActionUID, AgentActionAst, ChartAst, UserActionAst } from "./types.js";
import type { DurableLogRecord } from "./durable_events.js";
import { isFinalState, projectBranch, type BranchProjection } from "./projection.js";

export type MachineState = {
	ast: ChartAst;
	projection: BranchProjection;
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

export type Effect = AgentEffect | UserEffect | DurableRecordsEffect;

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

export type MachineStartEvent = Readonly<{
	kind: "start";
}>;

export type MachineEvent = MachineStartEvent | AgentMachineEvent | UserMachineEvent | DurableRecordsAddedMachineEvent;

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

export function createMachineOutput(state: MachineState, effects: Effect[]): MachineOutput {
	if (isFinalState(state.projection, state.ast)) {
		return {
			kind: "final",
			state,
			result: state.projection.results[state.projection.activeState],
		};
	}

	return {
		kind: "effect",
		state,
		effects: effects.concat(
			state.projection.pendingActions.map((actionUid, index) => createEffect(state.ast, actionUid, index)),
		),
	};
}

function createEffect(ast: ChartAst, actionUid: ActionUID, index: number): Effect {
	const state = ast.states[actionUid.state];
	if (state?.kind !== "state") {
		throw new Error(`Cannot create effect for non-action state ${actionUid.state}`);
	}
	if (!sameActionUid(actionUid, state.action.uid)) {
		throw new Error(`Cannot create effect for action uid in state ${actionUid.state}`);
	}

	const id = createEffectId(actionUid, index);
	switch (state.action.kind) {
		case "agent":
			return { kind: "agent", id, actionUid, action: state.action };
		case "user":
			return { kind: "user", id, actionUid, action: state.action };
	}
}

function createEffectId(actionUid: ActionUID, index: number): EffectId {
	return `${actionUid.chart}:${actionUid.state}:${actionUid.action}:${index}`;
}

function effectIdToActionUid(id: EffectId): ActionUID | null {
	const [chart, state, action] = id.split(":");
	if (!chart || !state || !action) {
		return null;
	}

	return { chart, state, action };
}

function sameActionUid(left: ActionUID, right: ActionUID): boolean {
	return left.chart === right.chart && left.state === right.state && left.action === right.action;
}

export function stepMachine(state: MachineState, event: MachineEvent): MachineOutput {
	let effects: Effect[] = [];
	switch (event.kind) {
		case "agent": {
			let actionId = effectIdToActionUid(event.effectId);
			if (!actionId) {
				return {
					kind: "error",
					state,
					error: `Invalid effectId ${event.effectId}`,
				};
			}
			let action = state.projection.pendingActions.find((el) => sameActionUid(el, actionId));
			if (!action) {
				return {
					kind: "error",
					state,
					error: `No pending action found for effectId ${event.effectId}`,
				};
			}
			let curState = state.ast.states[state.projection.activeState];
			if (curState?.kind === "state" && curState.transitions) {
				let nextStateId = curState.transitions[event.event.type];
				if (nextStateId) {
					effects = effects.concat([
						{
							kind: "durable_records",
							id: event.effectId,
							records: [
								{
									type: "state_action",
									kind: "complete",
									actionUid: actionId,
									parentId: state.projection.seqId,
									seqId: ++state.projection.seqId,
									timestamp: Date.now(),
								},
								{
									type: "state_transition",
									kind: "simple",
									source: state.projection.activeState,
									target: nextStateId,
									parentId: state.projection.seqId,
									seqId: ++state.projection.seqId,
									timestamp: Date.now(),
								},
							],
						},
					]);
				} else {
					return {
						kind: "error",
						state,
						error: `No transition found for event type ${event.event.type} in state ${state.projection.activeState}`,
					};
				}
			} else {
				return {
					kind: "error",
					state,
					error: `Current state ${state.projection.activeState} is not actionable or has no transitions`,
				};
			}
			return {
				kind: "effect",
				state,
				effects,
			};
		}
		case "start":
		case "user":
			// For user and agent events, we assume the event has already been validated against the expected action and options.
			// The event processing would typically involve recording the event as a durable log record, which would then be projected in the next step.
			break;
		case "durable_records_added":
			state.projection = projectBranch(state.projection, state.ast, event.records);
			break;
	}

	return createMachineOutput(state, effects);
}

export function createMachine(ast: ChartAst, projection: BranchProjection): MachineState {
	return { ast, projection };
}
