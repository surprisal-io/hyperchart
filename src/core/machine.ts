import type {
	ChartEvent,
	ActionStateAst,
	ActionUID,
	AgentActionAst,
	ChartAst,
	GuardOutcome,
	GuardRef,
	InputRef,
	OnReject,
	TemplateAst,
	UserActionAst,
} from "./types.js";
import type { DurableLogRecord } from "./durable_events.js";
import { hasTransition, isFinalState, projectBranch, type BranchProjection, type PendingAction } from "./projection.js";

export type MachineState = {
	ast: ChartAst;
	projection: BranchProjection;
	// Ids of effects already dispatched in this machine lifetime. Guards against dispatching the
	// same invoke/run/validation/feedback twice; starts empty on restart, so unfinished work
	// re-runs.
	dispatched: Set<EffectId>;
};

export type EffectId = string;

// A spawn-ready subagent call: the definition name and frontmatter overrides live in `action`;
// the fields below are the templated parameters rendered into final text by the machine.
export type AgentEffect = Readonly<{
	kind: "agent";
	id: EffectId;
	actionUid: ActionUID;
	action: AgentActionAst;
	task?: string;
	output?: string;
	reads?: readonly string[];
}>;

export type UserEffect = Readonly<{
	kind: "user";
	id: EffectId;
	actionUid: ActionUID;
	action: UserActionAst;
	prompt: string;
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
		...missingInvokes(state).map(invokeAppend),
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

function actionUidKey(actionUid: ActionUID): string {
	return `${actionUid.chart}:${actionUid.state}:${actionUid.action}`;
}

// Every pending action's effect answers the log record that started its phase: invoke → run the
// action, complete → validate it, validated(false) → deliver the rejection. The record's seqId
// makes the id unique per phase, so each phase dispatches exactly once.
function pendingEffectId(pending: PendingAction): EffectId {
	return `${pending.phase}:${actionUidKey(pending.actionUid)}:${pending.seqId}`;
}

// All effects a pending action currently wants: its phase effect, plus — while running under a
// deadline — the timer racing it.
function pendingEffects(state: MachineState, pending: PendingAction): Effect[] {
	const ast = state.ast;
	const effects = [pendingEffect(state, pending)];
	if (pending.phase === "running") {
		const node = ast.states[pending.actionUid.state];
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
	return `timer:${actionUidKey(pending.actionUid)}:${pending.seqId}`;
}

function pendingEffect(state: MachineState, pending: PendingAction): Effect {
	const node = state.ast.states[pending.actionUid.state];
	if (node?.kind !== "state" || !sameActionUid(pending.actionUid, node.action.uid)) {
		throw new Error(`Pending action does not match the chart in state ${pending.actionUid.state}`);
	}
	const id = pendingEffectId(pending);
	switch (pending.phase) {
		case "running": {
			if (node.action.kind === "agent") {
				const action = node.action;
				return {
					kind: "agent",
					id,
					actionUid: pending.actionUid,
					action,
					...(action.task === undefined ? {} : { task: renderTemplate(state, action.task, node.id) }),
					...(action.output === undefined ? {} : { output: renderTemplate(state, action.output, node.id) }),
					...(action.reads === undefined
						? {}
						: { reads: action.reads.map((read) => renderTemplate(state, read, node.id)) }),
				};
			}
			return {
				kind: "user",
				id,
				actionUid: pending.actionUid,
				action: node.action,
				prompt: renderTemplate(state, node.action.prompt, node.id),
			};
		}
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
				{ kind: "cancel", id: `cancel:${event.effectId}`, actionUid: running.actionUid },
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
					id: `cancel:${pendingEffectId(pending)}`,
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
	const actionId = effectIdToActionUid(effectId);
	if (!actionId) {
		return `Invalid effectId ${effectId}`;
	}
	const pending = machine.projection.pendingActions.find((el) => sameActionUid(el.actionUid, actionId));
	if (!pending) {
		return null;
	}
	if (pending.phase === "validating") {
		return `Validation already in flight for ${effectId}`;
	}
	const curState = machine.ast.states[actionId.state];
	if (curState?.kind !== "state") {
		return `State ${actionId.state} is not actionable`;
	}
	return { actionUid: actionId, state: curState };
}

// The machine decides when actions start: an invoke record is due for every active action-leaf
// whose action is not pending yet. This covers the initial state, every transition target and
// all parallel regions — the runtime never initiates anything on its own. The id carries no
// seqId, but between two entries into the same state the action is always pending, so the
// dispatch marker is dropped in between.
function missingInvokes(state: MachineState): ActionUID[] {
	const missing: ActionUID[] = [];
	for (const leaf of state.projection.activeLeaves) {
		const node = state.ast.states[leaf];
		if (node?.kind !== "state") continue;
		const actionUid = node.action.uid;
		if (!state.projection.pendingActions.some((entry) => sameActionUid(entry.actionUid, actionUid))) {
			missing.push(actionUid);
		}
	}
	return missing;
}

// Templates are rendered, never logged: the same args/results facts always render to the same
// text, so a restarted machine hands the agent an identical call. A ref into a missing
// arg/result is a chart-ordering bug — fail loud.
function renderTemplate(state: MachineState, template: TemplateAst, stateId: string): string {
	const parts: string[] = [template.strings[0] ?? ""];
	template.refs.forEach((ref, index) => {
		const value = resolveRef(state, ref, stateId);
		parts.push(typeof value === "string" ? value : JSON.stringify(value));
		parts.push(template.strings[index + 1] ?? "");
	});
	return parts.join("");
}

function resolveRef(state: MachineState, ref: InputRef, stateId: string): unknown {
	if (ref.kind === "arg") {
		const args = state.projection.args;
		if (args === undefined || !(ref.name in args)) {
			throw new Error(`Template in state ${stateId}: no argument '${ref.name}'`);
		}
		return args[ref.name];
	}
	if (!(ref.state in state.projection.results)) {
		throw new Error(`Template in state ${stateId}: no result for state ${ref.state}`);
	}
	let current: unknown = state.projection.results[ref.state];
	if (ref.path === undefined) {
		return current;
	}
	for (const segment of ref.path.split(".")) {
		if (typeof current !== "object" || current === null || !(segment in current)) {
			throw new Error(`Template in state ${stateId}: result of ${ref.state} has no '${ref.path}'`);
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
