import type { ActionUID, ChartAst, ChartEvent, SchemaAst, StateAst, StatePath, TransitionAst } from "./types.js";
import type { DurableLogRecord } from "./durable_events.js";
import { actionUidKey } from "./action_uid.js";
import {
	childPath,
	lastSegmentKey,
	matchesDeclaredUid,
	nodeAt,
	parentPath,
	siblingPath,
	stripLastKey,
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
					for (const key of keys) applyInputsForEntry(projection, ast, `${record.path}#${key}`);
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
						if (projection.activeLeaves.includes(record.actionUid.state)) {
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
						if (projection.activeLeaves.includes(record.actionUid.state)) {
							assertActiveActionUid(ast, record.actionUid.state, record.actionUid, "complete");
							const state = nodeAt(ast, record.actionUid.state);
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
						if (projection.activeLeaves.includes(record.actionUid.state)) {
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
						const node = nodeAt(ast, record.actionUid.state);
						const retries = node?.kind === "state" ? node.retries : undefined;
						const validationAttempts = validating.validationAttempts + 1;
						if (retries !== undefined && validationAttempts > retries) {
							// The budget is exhausted: the rejection is terminal and becomes a FAILED
							// transition. The entry deliberately stays pending — the exit sweep reports it
							// abandoned, so the machine cancels the still-running session.
							applyTransition(projection, ast, record.actionUid.state, "FAILED", abandoned);
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
	const state = nodeAt(ast, leaf);
	if (state?.kind !== "state" || state.after === undefined) {
		throw new Error(`No after transition in state ${leaf}`);
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
	const handler = findHandler(ast, fromLeaf, eventType);
	if (!handler) {
		throw new Error(`No transition for event type ${eventType} in state ${fromLeaf}`);
	}
	const target = siblingPath(handler.path, handler.transition.target);
	if (event !== undefined) {
		applyInputsForEntry(projection, ast, target, handler.transition, event);
	}
	exitAndEnter(projection, ast, handler.path, target, abandoned);
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
		if (projection.activeLeaves.includes(pending.actionUid.state)) {
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
// container through onDone — nothing is logged, replay recomputes the whole chain. A final in a
// region stays as-is: it marks the region complete for the join.
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
			return enterState(ast, siblingPath(parent, container.onDone));
		}
	}
	return [path];
}

// A parallel — or a map fan-out — is complete when every active leaf under it is final; its
// onDone then replaces them. Innermost first, repeated until stable — completing one may
// complete an outer.
function completeParallels(projection: BranchProjection, ast: ChartAst): void {
	for (;;) {
		const done = findCompletedParallel(projection, ast);
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
		return leaves.length > 0 && leaves.every((leaf) => nodeAt(ast, leaf)?.kind === "final");
	});
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

function assertActiveActionUid(ast: ChartAst, stateId: StatePath, actual: ActionUID, operation: string): void {
	const state = nodeAt(ast, stateId);
	if (state?.kind !== "state") {
		throw new Error(`Cannot ${operation} action for non-action state ${stateId}`);
	}
	if (!matchesDeclaredUid(actual, state.action.uid)) {
		throw new Error(`Invalid action ${operation} for state ${stateId}`);
	}
}

function sameActionUid(left: ActionUID, right: ActionUID): boolean {
	return left.chart === right.chart && left.state === right.state && left.action === right.action;
}
