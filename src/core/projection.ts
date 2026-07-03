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
	// The active configuration: one leaf normally, one per region while a parallel is active.
	// Always leaves — compounds drill down to their initial, parallels expand to their regions.
	activeLeaves: StatePath[];
	seqId: number;
	pendingActions: PendingAction[];
	// The run's input arguments; undefined until the args fact lands in the log.
	args?: Readonly<Record<string, unknown>>;
	// Latest accepted output per action state; re-entering a state overwrites its result.
	results: Record<StatePath, unknown>;
};

export function isFinalState(projection: BranchProjection, ast: ChartAst): boolean {
	return (
		projection.activeLeaves.length > 0 && projection.activeLeaves.every((leaf) => ast.states[leaf]?.kind === "final")
	);
}

export function createBranchProjection(ast: ChartAst): BranchProjection {
	const projection: BranchProjection = {
		activeLeaves: enterState(ast, ast.initial),
		seqId: 0,
		pendingActions: [],
		results: {},
	};
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
): BranchProjection {
	for (const record of log) {
		switch (record.type) {
			case "session_ref":
				// No state change, just a reference to a session
				break;
			case "args":
				projection.args = record.args;
				break;
			case "state_action":
				switch (record.kind) {
					case "invoke":
						if (projection.activeLeaves.includes(record.actionUid.state)) {
							assertActiveActionUid(ast, record.actionUid.state, record.actionUid, "invoke");
							projection.pendingActions.push({
								actionUid: record.actionUid,
								seqId: record.seqId,
								timestamp: record.timestamp,
								phase: "running",
							});
						}
						break;
					case "complete":
						if (projection.activeLeaves.includes(record.actionUid.state)) {
							assertActiveActionUid(ast, record.actionUid.state, record.actionUid, "complete");
							const state = ast.states[record.actionUid.state];
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
							recordResult(projection, record.actionUid.state, record.event);
							removePendingAction(projection, record.actionUid);
							applyTransition(projection, ast, record.actionUid.state, record.event.type, abandoned);
						}
						break;
					case "timer_fired":
						// The active-leaf guard makes race losers no-ops: a completion logged after the
						// timer (or vice versa) refers to a state that is no longer active and is skipped.
						if (projection.activeLeaves.includes(record.actionUid.state)) {
							assertActiveActionUid(ast, record.actionUid.state, record.actionUid, "timer_fired");
							removePendingAction(projection, record.actionUid);
							applyAfterTransition(projection, ast, record.actionUid.state, abandoned);
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
							applyTransition(projection, ast, record.actionUid.state, record.event.type, abandoned);
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

// A result exists once the completion is accepted (directly, or by a positive verdict).
function recordResult(projection: BranchProjection, state: StatePath, event: ChartEvent): void {
	if ("output" in event && event.output !== undefined) {
		projection.results[state] = event.output;
	}
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
	const state = ast.states[leaf];
	if (state?.kind !== "state" || state.after === undefined) {
		throw new Error(`No after transition in state ${leaf}`);
	}
	exitAndEnter(projection, ast, leaf, siblingPath(state, state.after.target), abandoned);
}

// Transitions are not logged: recompute the move from the chart AST. The handler's level decides
// the exit scope; its target is a sibling at that level.
function applyTransition(
	projection: BranchProjection,
	ast: ChartAst,
	fromLeaf: StatePath,
	eventType: string,
	abandoned: PendingAction[],
): void {
	const handler = findHandler(ast, fromLeaf, eventType);
	if (!handler) {
		throw new Error(`No transition for event type ${eventType} in state ${fromLeaf}`);
	}
	exitAndEnter(projection, ast, handler.path, siblingPath(handler.node, handler.target), abandoned);
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
		...projection.activeLeaves.filter((leaf) => !isOrUnder(leaf, exitPath)),
		...enterState(ast, targetPath),
	];
	const kept: PendingAction[] = [];
	for (const pending of projection.pendingActions) {
		if (projection.activeLeaves.includes(pending.actionUid.state)) {
			kept.push(pending);
		} else {
			abandoned.push(pending);
		}
	}
	projection.pendingActions = kept;
	completeParallels(projection, ast);
}

function isOrUnder(path: StatePath, scope: StatePath): boolean {
	return path === scope || path.startsWith(`${scope}.`);
}

// Innermost-first: the leaf that emitted the event handles it, or the closest ancestor declaring
// it. Events are not broadcast — a completion belongs to exactly one leaf, so parallel regions
// never conflict by construction.
function findHandler(
	ast: ChartAst,
	fromPath: StatePath,
	eventType: string,
): { path: StatePath; node: StateAst; target: StateId } | undefined {
	let path: StatePath | undefined = fromPath;
	while (path !== undefined) {
		const node: StateAst | undefined = ast.states[path];
		if (node === undefined) {
			throw new Error(`Broken parent chain: state ${path} not found`);
		}
		if (node.kind !== "final") {
			const target = node.transitions[eventType];
			if (target !== undefined) return { path, node, target };
		}
		path = node.parent;
	}
	return undefined;
}

export function hasTransition(ast: ChartAst, fromPath: StatePath, eventType: string): boolean {
	return findHandler(ast, fromPath, eventType) !== undefined;
}

// Entering a state resolves it to active leaves: compounds and regions drill down their initial
// chain, parallels enter every region, and a final child immediately completes its compound
// container through onDone — nothing is logged, replay recomputes the whole chain. A final in a
// region stays as-is: it marks the region complete for the join.
function enterState(ast: ChartAst, path: StatePath): StatePath[] {
	const node = ast.states[path];
	if (node === undefined) {
		throw new Error(`Unknown state ${path}`);
	}
	if (node.kind === "compound" || node.kind === "region") {
		return enterState(ast, `${path}.${node.initial}`);
	}
	if (node.kind === "parallel") {
		return node.regions.flatMap((region) => enterState(ast, `${path}.${region}`));
	}
	if (node.kind === "final" && node.parent !== undefined) {
		const container = ast.states[node.parent];
		if (container === undefined) {
			throw new Error(`Broken parent chain: state ${node.parent} not found`);
		}
		if (container.kind === "compound") {
			return enterState(ast, siblingPath(container, container.onDone));
		}
	}
	return [path];
}

// A parallel is complete when every active leaf under it is final; its onDone then replaces
// them. Innermost parallels first, repeated until stable — completing one may complete an outer.
function completeParallels(projection: BranchProjection, ast: ChartAst): void {
	for (;;) {
		const done = findCompletedParallel(projection, ast);
		if (done === undefined) return;
		projection.activeLeaves = [
			...projection.activeLeaves.filter((leaf) => !isOrUnder(leaf, done.path)),
			...enterState(ast, done.target),
		];
	}
}

function findCompletedParallel(
	projection: BranchProjection,
	ast: ChartAst,
): { path: StatePath; target: StatePath } | undefined {
	const candidates: { path: StatePath; target: StatePath }[] = [];
	const seen = new Set<StatePath>();
	for (const leaf of projection.activeLeaves) {
		let path = ast.states[leaf]?.parent;
		while (path !== undefined) {
			const node = ast.states[path];
			if (node === undefined) {
				throw new Error(`Broken parent chain: state ${path} not found`);
			}
			if (node.kind === "parallel" && !seen.has(path)) {
				seen.add(path);
				candidates.push({ path, target: siblingPath(node, node.onDone) });
			}
			path = node.parent;
		}
	}
	candidates.sort((a, b) => b.path.length - a.path.length);
	return candidates.find(({ path }) => {
		const leaves = projection.activeLeaves.filter((leaf) => isOrUnder(leaf, path));
		return leaves.length > 0 && leaves.every((leaf) => ast.states[leaf]?.kind === "final");
	});
}

function siblingPath(node: StateAst, target: StateId): StatePath {
	return node.parent === undefined ? target : `${node.parent}.${target}`;
}

function assertActiveActionUid(ast: ChartAst, stateId: StatePath, actual: ActionUID, operation: string): void {
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
