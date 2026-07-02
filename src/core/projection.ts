import type { ActionUID, ChartAst, StateId } from "./types.js";
import type { DurableLogRecord } from "./durable_events.js";

export type BranchProjection = {
	activeState: StateId;
	seqId: number;
	pendingActions: ActionUID[];
	results: Record<StateId, unknown>;
};

export function isFinalState(projection: BranchProjection, ast: ChartAst): boolean {
	return ast.states[projection.activeState]?.kind === "final";
}

export function createBranchProjection(ast: ChartAst): BranchProjection {
	return {
		activeState: ast.initial,
		seqId: 0,
		pendingActions: [],
		results: {},
	};
}

export function projectBranch(
	projection: BranchProjection,
	ast: ChartAst,
	log: readonly DurableLogRecord[],
): BranchProjection {
	for (const record of log) {
		switch (record.type) {
			case "session_ref":
				// No state change, just a reference to a session
				break;
			case "state_action":
				switch (record.kind) {
					case "invoke":
						if (record.actionUid.state === projection.activeState) {
							assertActiveActionUid(ast, projection.activeState, record.actionUid, "invoke");
							projection.pendingActions.push(record.actionUid);
						}
						break;
					case "complete":
						if (record.actionUid.state === projection.activeState) {
							assertActiveActionUid(ast, projection.activeState, record.actionUid, "complete");
							const index = projection.pendingActions.findIndex((uid) => sameActionUid(uid, record.actionUid));
							if (index !== -1) {
								projection.pendingActions.splice(index, 1);
							}
							// Transitions are not logged: recompute the move from the chart AST.
							const state = ast.states[projection.activeState];
							const target = state?.kind === "state" ? state.transitions?.[record.event.type] : undefined;
							if (!target) {
								throw new Error(
									`No transition for event type ${record.event.type} in state ${projection.activeState}`,
								);
							}
							projection.activeState = target;
						}
						break;
				}
				break;
		}
		projection.seqId = Math.max(projection.seqId, record.seqId);
	}
	return projection;
}

function assertActiveActionUid(ast: ChartAst, stateId: StateId, actual: ActionUID, operation: string): void {
	const state = ast.states[stateId];
	if (state?.kind !== "state") {
		throw new Error(`Cannot ${operation} action for non-action state ${stateId}`);
	}
	if (!sameActionUid(actual, state.action.uid)) {
		throw new Error(`Invalid action ${operation} for state ${stateId}`);
	}
}

function sameActionUid(left: ActionUID, right: ActionUID): boolean {
	return left.chart === right.chart && left.state === right.state && left.action === right.action;
}
