import type { ActionUID, ChartAst, ChartEvent, StateAst, StateId, StatePath } from "./types.js";
import type { DurableLogRecord } from "./durable_events.js";

// A pending action and the phase it is in, each phase started by a log record: invoke —
// "running"; a completion on a validated state — "validating"; a negative verdict — "rejected"
// (feedback to deliver); a new completion restarts the cycle. An accepted verdict (or a
// completion needing no validation) removes the entry and applies the transition. The action's
// session is alive through the whole cycle. seqId is the record that started the current phase;
// it makes the effect id of each phase unique.
export type PendingAction =
	// timestamp of the invoke fact is the state's entry time — the anchor for its after-deadline.
	| { actionUid: ActionUID; seqId: number; timestamp: number; phase: "running" }
	| { actionUid: ActionUID; seqId: number; phase: "validating"; event: ChartEvent }
	| { actionUid: ActionUID; seqId: number; phase: "rejected"; event: ChartEvent; reason?: string };

export type BranchProjection = {
	// Always a leaf: compounds are never active themselves, entry drills down to their initial.
	activeState: StatePath;
	seqId: number;
	pendingActions: PendingAction[];
	results: Record<StatePath, unknown>;
};

export function isFinalState(projection: BranchProjection, ast: ChartAst): boolean {
	return ast.states[projection.activeState]?.kind === "final";
}

export function createBranchProjection(ast: ChartAst): BranchProjection {
	return {
		activeState: enterState(ast, ast.initial),
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
							projection.pendingActions.push({
								actionUid: record.actionUid,
								seqId: record.seqId,
								timestamp: record.timestamp,
								phase: "running",
							});
						}
						break;
					case "complete":
						if (record.actionUid.state === projection.activeState) {
							assertActiveActionUid(ast, projection.activeState, record.actionUid, "complete");
							const state = ast.states[projection.activeState];
							if (state?.kind === "state" && state.validate !== undefined && record.event.type !== "FAILED") {
								// The completion goes into validation, restarting the cycle if a previous round was rejected.
								removePendingAction(projection, record.actionUid);
								projection.pendingActions.push({
									actionUid: record.actionUid,
									seqId: record.seqId,
									phase: "validating",
									event: record.event,
								});
								break;
							}
							removePendingAction(projection, record.actionUid);
							applyTransition(projection, ast, record.event.type);
						}
						break;
					case "timer_fired":
						// The activeState guard makes race losers no-ops: a completion logged after the
						// timer (or vice versa) refers to a state that is no longer active and is skipped.
						if (record.actionUid.state === projection.activeState) {
							assertActiveActionUid(ast, projection.activeState, record.actionUid, "timer_fired");
							removePendingAction(projection, record.actionUid);
							applyAfterTransition(projection, ast);
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
							removePendingAction(projection, record.actionUid);
							applyTransition(projection, ast, record.event.type);
						} else {
							projection.pendingActions[projection.pendingActions.indexOf(validating)] = {
								actionUid: validating.actionUid,
								seqId: record.seqId,
								phase: "rejected",
								event: validating.event,
								...(typeof record.outcome === "object" ? { reason: record.outcome.reason } : {}),
							};
						}
						break;
					}
				}
				break;
		}
		projection.seqId = Math.max(projection.seqId, record.seqId);
	}
	return projection;
}

function removePendingAction(projection: BranchProjection, actionUid: ActionUID): void {
	const index = projection.pendingActions.findIndex((pending) => sameActionUid(pending.actionUid, actionUid));
	if (index !== -1) {
		projection.pendingActions.splice(index, 1);
	}
}

function applyAfterTransition(projection: BranchProjection, ast: ChartAst): void {
	const state = ast.states[projection.activeState];
	if (state?.kind !== "state" || state.after === undefined) {
		throw new Error(`No after transition in state ${projection.activeState}`);
	}
	projection.activeState = enterState(ast, siblingPath(state, state.after.target));
}

// Transitions are not logged: recompute the move from the chart AST. The handler's level decides
// the exit scope; its target is a sibling at that level.
function applyTransition(projection: BranchProjection, ast: ChartAst, eventType: string): void {
	const handler = findHandler(ast, projection.activeState, eventType);
	if (!handler) {
		throw new Error(`No transition for event type ${eventType} in state ${projection.activeState}`);
	}
	projection.activeState = enterState(ast, siblingPath(handler.node, handler.target));
}

// Innermost-first: the active leaf handles the event, or the closest ancestor declaring it.
function findHandler(
	ast: ChartAst,
	fromPath: StatePath,
	eventType: string,
): { node: StateAst; target: StateId } | undefined {
	let path: StatePath | undefined = fromPath;
	while (path !== undefined) {
		const node: StateAst | undefined = ast.states[path];
		if (node === undefined) return undefined;
		if (node.kind !== "final") {
			const target = node.transitions[eventType];
			if (target !== undefined) return { node, target };
		}
		path = node.parent;
	}
	return undefined;
}

export function hasTransition(ast: ChartAst, fromPath: StatePath, eventType: string): boolean {
	return findHandler(ast, fromPath, eventType) !== undefined;
}

// Entering a state resolves it to the active leaf: compounds drill down their initial chain, and
// a final child immediately completes its container — the chart exits through the compound's
// onDone in the same step, with nothing logged (replay recomputes the whole chain).
function enterState(ast: ChartAst, path: StatePath): StatePath {
	let current = path;
	for (;;) {
		const node = ast.states[current];
		if (node?.kind !== "compound") break;
		current = `${current}.${node.initial}`;
	}
	const node = ast.states[current];
	if (node?.kind === "final" && node.parent !== undefined) {
		const container = ast.states[node.parent];
		if (container?.kind !== "compound" || container.onDone === undefined) {
			throw new Error(`Final state ${current} has no onDone exit`);
		}
		return enterState(ast, siblingPath(container, container.onDone));
	}
	return current;
}

function siblingPath(node: StateAst, target: StateId): StatePath {
	return node.parent === undefined ? target : `${node.parent}.${target}`;
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
