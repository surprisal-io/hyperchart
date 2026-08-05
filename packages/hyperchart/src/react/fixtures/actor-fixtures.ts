import { z } from "zod";
import { agent, actor, arg, call, chart, failed, final, item, map, message, protocol, receive, reply, send } from "../../core/dsl.js";
import type { DurableLogRecord, ActorMessageEnvelope } from "../../core/durable_events.js";
import { explainReplay } from "../../core/replay_check.js";
import type { ActorDeclarationAst, CallStateAst, ChartAst, SendStateAst } from "../../core/types.js";
import { hyperchartRunFromRuntime } from "../../host/adapters.js";
import type { HyperchartRunInfo } from "../../host/models.js";
import {
	Editor,
	EditorProtocol,
	actorInspectorAst,
	actorInspectorInspectResult,
	actorInspectorRecords,
} from "./actor-runtime-fixtures.js";
import { storyScenario } from "./story-scenario.js";

const now = 1_783_000_000_000;
const stamp = (seqId: number) => ({ parentId: seqId === 1 ? null : seqId - 1, seqId, timestamp: now + seqId * 1_000 });

function actorDefinition(ast: ChartAst, path: string): ActorDeclarationAst {
	const definition = ast.actors[path];
	if (definition === undefined) throw new Error(`missing actor declaration ${path}`);
	return definition;
}
function messageContract(ast: ChartAst, declaration: string, event: string) {
	const contract = actorDefinition(ast, declaration).protocol[event];
	if (contract === undefined) throw new Error(`missing actor message ${declaration}.${event}`);
	return contract;
}
function sourceState(ast: ChartAst, path: string): SendStateAst | CallStateAst {
	const state = ast.states[path];
	if (state?.kind !== "send" && state?.kind !== "call") throw new Error(`missing actor source ${path}`);
	return state;
}
function created(ast: ChartAst, declarationPath: string, occurrence: string, seqId: number, owner?: string, resolvedInput?: unknown): DurableLogRecord {
	const definition = actorDefinition(ast, declarationPath);
	return { type: "actor_created", declaration: declarationPath, occurrence, generation: 1, ...(owner === undefined ? {} : { owner }), input: resolvedInput ?? definition.inputValue, definition, ...stamp(seqId) };
}
function envelope(ast: ChartAst, definitionPath: string, producerState: string, messageId: string, batchIndex: number, callId?: string): ActorMessageEnvelope {
	const definition = sourceState(ast, definitionPath);
	const input = definition.kind === "call"
		? definition.input
		: Array.isArray(definition.inputs)
			? definition.inputs[batchIndex]
			: definition.input;
	if (input === undefined) throw new Error(`missing concrete actor input ${definitionPath}[${batchIndex}]`);
	return { messageId, event: definition.event, input, producerState, producerVisit: 1, batchIndex, ...(callId === undefined ? {} : { callId }) };
}
function enqueue(ast: ChartAst, sourcePath: string, occurrence: string, event: string, messages: ActorMessageEnvelope[], seqId: number, definitionPath = sourcePath, generation = 1): DurableLogRecord {
	const definition = sourceState(ast, definitionPath);
	const targetDeclaration = definition.to;
	return {
		type: "actor_messages_enqueued", occurrence, generation,
		source: { producerState: sourcePath, kind: definition.kind, definition, targetDeclaration, event, inputSchema: messageContract(ast, targetDeclaration, event).input },
		messages, ...stamp(seqId),
	};
}
function buildRun(name: string, ast: ChartAst, inspect: typeof actorInspectorInspectResult, records: DurableLogRecord[], status: "running" | "failed" = "running", replayWarnings?: string[]): HyperchartRunInfo {
	const replay = explainReplay(ast, records);
	if (replay.broken !== undefined || replay.prefixEnd !== records.length || replay.stale.length > 0 || replay.skipped.length > 0) throw new Error(`invalid actor story ${name}: ${JSON.stringify(replay)}`);
	return hyperchartRunFromRuntime(inspect, ast, records, {
		runId: `actor:${name}`,
		status: { runId: `actor:${name}`, chartId: ast.id, state: status, startedAt: now, updatedAt: now + records.length * 1_000, ...(replayWarnings === undefined ? {} : { replayWarnings }) },
		cwd: "/workspace", createdAt: now, updatedAt: now + records.length * 1_000,
	});
}

const baseEditorRecords: DurableLogRecord[] = [
	{ type: "args", args: {}, ...stamp(1) },
	created(actorInspectorAst, "@editor", "@editor", 2),
];

export const actorIdleRun = buildRun("idle", actorInspectorAst, actorInspectorInspectResult, baseEditorRecords);

export const actorBusyFifoRun = buildRun("busy-fifo", actorInspectorAst, actorInspectorInspectResult, actorInspectorRecords(actorInspectorAst));

const callEditor = Editor({ file: "src/index.ts" });
const callScenario = storyScenario(chart({ kind: "chart", id: "actor-call-story", actors: { editor: callEditor }, initial: "apply", states: { apply: call({ to: callEditor, event: "APPLY", input: { patch: "follow-up" }, transitions: { APPLIED: "done", REJECTED: "done" } }), done: final() } }));
export const actorCallAst = callScenario.ast;
const callAst = actorCallAst;
const callBaseRecords: DurableLogRecord[] = [{ type: "args", args: {}, ...stamp(1) }, created(callAst, "@editor", "@editor", 2)];
const callMessage = envelope(callAst, "apply", "apply", "apply:1:0", 0, "apply:1");
const pendingCallRecords: DurableLogRecord[] = [
	...callBaseRecords,
	enqueue(callAst, "apply", "@editor", "APPLY", [callMessage], 3),
];
export const actorPendingCallRun = callScenario.runtimeRun(pendingCallRecords, { runId: "actor:pending-call", status: { state: "running", updatedAt: now + 3_000 }, cwd: "/workspace", createdAt: now, updatedAt: now + 3_000 });

const applyReply = messageContract(callAst, "@editor", "APPLY").reply;
if (applyReply.kind !== "named") throw new Error("expected named APPLY reply");
const editorDefinition = actorDefinition(callAst, "@editor");
const editorApply = editorDefinition.states.apply;
if (editorApply?.kind !== "state") throw new Error("expected editor apply action");
const editorSettle = editorDefinition.states.settle;
if (editorSettle?.kind !== "reply" || editorSettle.event === undefined || editorSettle.output === undefined) throw new Error("expected concrete named editor reply");
const appliedSchema = applyReply.schemas[editorSettle.event];
if (appliedSchema === undefined) throw new Error(`missing ${editorSettle.event} schema`);
const editorApplyUid = { ...editorApply.action.uid, state: "@editor.apply" };
export const actorNamedReplyRecords: DurableLogRecord[] = [
	...pendingCallRecords,
	{ type: "actor_message", kind: "accepted", occurrence: "@editor", messageId: callMessage.messageId, receiveState: "@editor.idle", ...stamp(4) },
	{ type: "state_action", kind: "invoke", actionUid: editorApplyUid, definition: editorApply.action, ...stamp(5) },
	{ type: "state_action", kind: "complete", actionUid: editorApplyUid, event: { type: "DONE" }, ...stamp(6) },
	{ type: "actor_message", kind: "replied", occurrence: "@editor", messageId: callMessage.messageId, message: editorSettle.message, replyEvent: editorSettle.event, output: editorSettle.output, schema: appliedSchema, ...stamp(7) },
];
export const actorNamedReplyRun = callScenario.runtimeRun(actorNamedReplyRecords, { runId: "actor:named-reply", status: { state: "running", updatedAt: now + 7_000 }, cwd: "/workspace", createdAt: now, updatedAt: now + 7_000 });

// Structured drain is intentionally SEND-only and nested. The root graph only
// shows the owning compound; opening it reveals the waiting final, whose blocker
// link navigates to the otherwise hidden actor. A call would block the producer
// and would therefore be the wrong visual/runtime state.
const DrainProtocol = protocol({ RECORD: message({ input: z.object({ path: z.string() }).strict() }) });
const DrainWorker = actor({
	input: z.object({}).strict(),
	protocol: DrainProtocol,
	initial: "idle",
	states: { idle: receive({ on: { RECORD: "settle" } }), settle: reply({ target: "idle" }) },
});
const drainWorker = DrainWorker({});
const drainScenario = storyScenario(chart({
	kind: "chart",
	id: "actor-structured-drain-story",
	initial: "phase",
	states: {
		phase: {
			kind: "compound",
			actors: { worker: drainWorker },
			initial: "dispatch",
			onDone: "done",
			states: {
				dispatch: send({
					to: drainWorker,
					event: "RECORD",
					inputs: [
						{ path: "one.log" },
						{ path: "two.log" },
						{ path: "three.log" },
						{ path: "four.log" },
					],
					target: "finished",
				}),
				finished: final(),
			},
		},
		done: final(),
	},
}));
const drainAst = drainScenario.ast;
const drainDispatch = sourceState(drainAst, "phase.dispatch");
if (drainDispatch.kind !== "send" || !Array.isArray(drainDispatch.inputs)) throw new Error("expected structured-drain batch send");
const drainMessages = drainDispatch.inputs.map((_, index) => envelope(drainAst, "phase.dispatch", "phase.dispatch", `phase.dispatch:1:${index}`, index));
const drainingRecords: DurableLogRecord[] = [
	{ type: "args", args: {}, ...stamp(1) },
	created(drainAst, "phase.@worker", "phase.@worker", 2, "phase"),
	enqueue(drainAst, "phase.dispatch", "phase.@worker", "RECORD", drainMessages, 3),
	{ type: "actor_message", kind: "accepted", occurrence: "phase.@worker", messageId: drainMessages[0]!.messageId, receiveState: "phase.@worker.idle", ...stamp(4) },
	{ type: "actor_scope", kind: "closing", occurrence: "phase.@worker", ...stamp(5) },
];
export const actorDrainingRun = drainScenario.runtimeRun(drainingRecords, {
	runId: "actor:draining",
	status: { state: "running", updatedAt: now + 5_000 },
	cwd: "/workspace",
	createdAt: now,
	updatedAt: now + 5_000,
});

const failureRecords: DurableLogRecord[] = [
	...pendingCallRecords,
	{ type: "actor_message", kind: "accepted", occurrence: "@editor", messageId: callMessage.messageId, receiveState: "@editor.idle", ...stamp(4) },
	{ type: "failure_intent", origin: "@editor.apply", error: "Reply failed exact protocol validation", ...stamp(5) },
];
export const actorFailureRun = callScenario.runtimeRun(failureRecords, { runId: "actor:failure", status: { state: "failed", updatedAt: now + 5_000 }, cwd: "/workspace", createdAt: now, updatedAt: now + 5_000 });

const ChangedEditor = actor({
	input: z.object({ file: z.string(), revision: z.number().optional() }).strict(),
	protocol: EditorProtocol,
	initial: "idle",
	states: {
		idle: receive({ on: { APPLY: "apply", REVIEW: "review-settle", ARCHIVE: "archive-settle" } }),
		apply: { kind: "state", action: agent("actor-editor", { task: "Apply the accepted patch inside the actor occurrence.", reply: z.object({ commit: z.string() }).strict() }), transitions: { DONE: "settle" } },
		settle: reply({ target: "idle", event: "APPLIED", output: { commit: "storybook-commit" } }),
		"review-settle": reply({ target: "idle", event: "APPROVED", output: { approval: { reviewer: "quality-bot", timestamp: "2026-08-04T16:00:00Z" }, checks: { tests: "passed" } } }),
		"archive-settle": reply({ target: "idle" }),
	},
});
const changedEditor = ChangedEditor({ file: "src/index.ts" });
const changedActorScenario = storyScenario(chart({
	kind: "chart",
	id: "actor-inspector-ui",
	actors: { editor: changedEditor },
	initial: "queue",
	states: {
		queue: send({ to: changedEditor, event: "APPLY", inputs: [{ patch: "first patch" }, { patch: "second patch" }], target: "apply-call" }),
		"apply-call": call({ to: changedEditor, event: "APPLY", input: { patch: "follow-up patch" }, transitions: { APPLIED: "done", REJECTED: "failed" } }),
		done: final(),
		failed: failed(),
	},
}), "storybook:actor-inspector-ui-changed");
const compatibility = explainReplay(changedActorScenario.ast, baseEditorRecords);
if (compatibility.broken === undefined && compatibility.stale.length === 0 && compatibility.skipped.length === 0) {
	throw new Error("broken replay story must be backed by a genuine compatibility finding");
}
const compatibilityWarnings = [
	...(compatibility.broken === undefined ? [] : [`Broken replay at seq ${compatibility.broken.seqId}: ${compatibility.broken.error}`]),
	...compatibility.stale.map((finding) => `Stale replay at seq ${finding.seqId}: ${finding.reason}`),
	...compatibility.skipped.map((finding) => `Skipped replay at seq ${finding.seqId}: ${finding.reason}`),
];
export const actorBrokenReplayRun = hyperchartRunFromRuntime(
	changedActorScenario.inspect,
	changedActorScenario.ast,
	baseEditorRecords,
	{ runId: "actor:broken-replay", status: { state: "failed", updatedAt: now + 2_000, replayWarnings: compatibilityWarnings }, cwd: "/workspace", createdAt: now, updatedAt: now + 2_000 },
);

const AuditProtocol = protocol({ RECORD: message({ input: z.object({ path: z.string() }).strict() }) });
const Auditor = actor({ input: z.object({}).strict(), protocol: AuditProtocol, initial: "idle", states: { idle: receive({ on: { RECORD: "settle" } }), settle: reply({ target: "idle" }) } });
const auditor = Auditor({});
const auditScenario = storyScenario(chart({ kind: "chart", id: "actor-send-void-story", actors: { auditor }, initial: "record", states: { record: send({ to: auditor, event: "RECORD", input: { path: "audit.log" }, target: "done" }), done: final() } }));
const auditAst = auditScenario.ast;
const auditMessage = envelope(auditAst, "record", "record", "record:1:0", 0);
const auditRecords: DurableLogRecord[] = [
	{ type: "args", args: {}, ...stamp(1) }, created(auditAst, "@auditor", "@auditor", 2), enqueue(auditAst, "record", "@auditor", "RECORD", [auditMessage], 3),
	{ type: "actor_message", kind: "accepted", occurrence: "@auditor", messageId: auditMessage.messageId, receiveState: "@auditor.idle", ...stamp(4) },
	{ type: "actor_message", kind: "replied", occurrence: "@auditor", messageId: auditMessage.messageId, message: "RECORD", ...stamp(5) },
	{ type: "actor_message", kind: "settled", occurrence: "@auditor", messageId: auditMessage.messageId, ...stamp(6) },
	{ type: "actor_scope", kind: "closing", occurrence: "@auditor", ...stamp(7) }, { type: "actor_scope", kind: "stopped", occurrence: "@auditor", ...stamp(8) },
];
export const actorSendVoidRun = auditScenario.runtimeRun(auditRecords, { runId: "actor:send-void", status: { state: "complete", updatedAt: now + 8_000 }, cwd: "/workspace", createdAt: now, updatedAt: now + 8_000 });

const ReentryProtocol = protocol({ RECORD: message({ input: z.object({ path: z.string() }).strict() }) });
const ReentryActor = actor({
	input: z.object({ journal: z.string(), retentionDays: z.number().int() }).strict(),
	protocol: ReentryProtocol,
	initial: "idle",
	states: { idle: receive({ on: { RECORD: "settle" } }), settle: reply({ target: "idle" }) },
});
const reentryActor = ReentryActor({ journal: "audit.log", retentionDays: 30 });
const reentryScenario = storyScenario(chart({
	kind: "chart",
	id: "actor-reentry-story",
	initial: "phase",
	states: {
		phase: {
			kind: "compound",
			actors: { auditor: reentryActor },
			initial: "record",
			onDone: "between",
			states: {
				record: send({ to: reentryActor, event: "RECORD", input: { path: "audit.log" }, target: "finished" }),
				finished: final(),
			},
		},
		between: { kind: "state", action: agent("chooser"), transitions: { AGAIN: "phase", DONE: "done" } },
		done: final(),
	},
}));
const reentryAst = reentryScenario.ast;
const reentryDefinition = actorDefinition(reentryAst, "phase.@auditor");
const reentryAction = reentryAst.states.between;
if (reentryAction?.kind !== "state") throw new Error("expected reentry chooser state");
const reentryMessage1 = envelope(reentryAst, "phase.record", "phase.record", "phase.record:message:1:0", 0);
const reentryMessage2 = { ...envelope(reentryAst, "phase.record", "phase.record", "phase.record:message:2:0", 0), producerVisit: 2 };
const reentryMessage3 = { ...envelope(reentryAst, "phase.record", "phase.record", "phase.record:message:3:0", 0), producerVisit: 3 };
const reentryRecords: DurableLogRecord[] = [
	{ type: "actor_created", declaration: "phase.@auditor", occurrence: "phase.@auditor", generation: 1, owner: "phase", input: reentryDefinition.inputValue, definition: reentryDefinition, ...stamp(1) },
	enqueue(reentryAst, "phase.record", "phase.@auditor", "RECORD", [reentryMessage1], 2),
	{ type: "actor_message", kind: "accepted", occurrence: "phase.@auditor", messageId: reentryMessage1.messageId, receiveState: "phase.@auditor.idle", ...stamp(3) },
	{ type: "actor_scope", kind: "closing", occurrence: "phase.@auditor", ...stamp(4) },
	{ type: "actor_message", kind: "replied", occurrence: "phase.@auditor", messageId: reentryMessage1.messageId, message: "RECORD", ...stamp(5) },
	{ type: "actor_message", kind: "settled", occurrence: "phase.@auditor", messageId: reentryMessage1.messageId, ...stamp(6) },
	{ type: "actor_scope", kind: "stopped", occurrence: "phase.@auditor", ...stamp(7) },
	{ type: "state_action", kind: "invoke", actionUid: reentryAction.action.uid, definition: reentryAction.action, ...stamp(8) },
	{ type: "state_action", kind: "complete", actionUid: reentryAction.action.uid, event: { type: "AGAIN" }, ...stamp(9) },
	{ type: "actor_created", declaration: "phase.@auditor", occurrence: "phase.@auditor~2", generation: 2, owner: "phase", input: reentryDefinition.inputValue, definition: reentryDefinition, ...stamp(10) },
	enqueue(reentryAst, "phase.record", "phase.@auditor~2", "RECORD", [reentryMessage2], 11, "phase.record", 2),
	{ type: "actor_message", kind: "accepted", occurrence: "phase.@auditor~2", messageId: reentryMessage2.messageId, receiveState: "phase.@auditor~2.idle", ...stamp(12) },
	{ type: "actor_scope", kind: "closing", occurrence: "phase.@auditor~2", ...stamp(13) },
	{ type: "actor_message", kind: "replied", occurrence: "phase.@auditor~2", messageId: reentryMessage2.messageId, message: "RECORD", ...stamp(14) },
	{ type: "actor_message", kind: "settled", occurrence: "phase.@auditor~2", messageId: reentryMessage2.messageId, ...stamp(15) },
	{ type: "actor_scope", kind: "stopped", occurrence: "phase.@auditor~2", ...stamp(16) },
	{ type: "state_action", kind: "invoke", actionUid: reentryAction.action.uid, definition: reentryAction.action, ...stamp(17) },
	{ type: "state_action", kind: "complete", actionUid: reentryAction.action.uid, event: { type: "AGAIN" }, ...stamp(18) },
	{ type: "actor_created", declaration: "phase.@auditor", occurrence: "phase.@auditor~3", generation: 3, owner: "phase", input: reentryDefinition.inputValue, definition: reentryDefinition, ...stamp(19) },
	enqueue(reentryAst, "phase.record", "phase.@auditor~3", "RECORD", [reentryMessage3], 20, "phase.record", 3),
	{ type: "actor_message", kind: "accepted", occurrence: "phase.@auditor~3", messageId: reentryMessage3.messageId, receiveState: "phase.@auditor~3.idle", ...stamp(21) },
	{ type: "actor_scope", kind: "closing", occurrence: "phase.@auditor~3", ...stamp(22) },
	{ type: "actor_message", kind: "replied", occurrence: "phase.@auditor~3", messageId: reentryMessage3.messageId, message: "RECORD", ...stamp(23) },
	{ type: "actor_message", kind: "settled", occurrence: "phase.@auditor~3", messageId: reentryMessage3.messageId, ...stamp(24) },
	{ type: "actor_scope", kind: "stopped", occurrence: "phase.@auditor~3", ...stamp(25) },
	{ type: "state_action", kind: "invoke", actionUid: reentryAction.action.uid, definition: reentryAction.action, ...stamp(26) },
];
export const actorReentryRun = reentryScenario.runtimeRun(reentryRecords, { runId: "actor:reentry", status: { state: "running", updatedAt: now + 26_000 }, cwd: "/workspace", createdAt: now, updatedAt: now + 26_000 });

const mapEditor = Editor({ file: item("file") });
const mapScenario = storyScenario(chart({ kind: "chart", id: "actor-map-story", args: { projects: {} }, initial: "projects", states: { projects: map({ over: arg("projects"), actors: { editor: mapEditor }, initial: "apply", onDone: "done", states: { apply: call({ to: mapEditor, event: "APPLY", input: { patch: "p" }, transitions: { APPLIED: "finished", REJECTED: "finished" } }), finished: final() } }), done: final() } }));
const mapAst = mapScenario.ast;
const mapCallA = envelope(mapAst, "projects.apply", "projects#a.apply", "projects#a.apply:1:0", 0, "projects#a.apply:1");
const mapCallB = envelope(mapAst, "projects.apply", "projects#b.apply", "projects#b.apply:1:0", 0, "projects#b.apply:1");
const mapInstances = { a: { file: "a.ts" }, b: { file: "b.ts" } };
const mapRecords: DurableLogRecord[] = [
	{ type: "args", args: { projects: mapInstances }, ...stamp(1) },
	{ type: "spawned", path: "projects", instances: mapInstances, ...stamp(2) },
	created(mapAst, "projects.@editor", "projects#a.@editor", 3, "projects#a", mapInstances.a),
	created(mapAst, "projects.@editor", "projects#b.@editor", 4, "projects#b", mapInstances.b),
	enqueue(mapAst, "projects#a.apply", "projects#a.@editor", "APPLY", [mapCallA], 5, "projects.apply"),
	enqueue(mapAst, "projects#b.apply", "projects#b.@editor", "APPLY", [mapCallB], 6, "projects.apply"),
	{ type: "actor_message", kind: "accepted", occurrence: "projects#b.@editor", messageId: mapCallB.messageId, receiveState: "projects#b.@editor.idle", ...stamp(7) },
];
export const actorMapPartialRun = mapScenario.runtimeRun(mapRecords.slice(0, 3), { runId: "actor:map-partial", status: { state: "running", updatedAt: now + 3_000 }, cwd: "/workspace", createdAt: now, updatedAt: now + 3_000 });
export const actorMapLocalRun = mapScenario.runtimeRun(mapRecords, { runId: "actor:map-local", status: { state: "running", updatedAt: now + 4_000 }, cwd: "/workspace", createdAt: now, updatedAt: now + 4_000 });

const OverflowProtocol = protocol({
	PROCESS_WITH_A_LONG_PROTOCOL_EVENT_NAME: message({
		input: z.object({
			field1: z.string(), field2: z.string(), field3: z.string(), field4: z.string(),
			field5: z.string(), field6: z.string(), field7: z.string(), field8: z.string(),
		}).strict(),
		replies: {
			OUTCOME_1: z.object({ result: z.string() }), OUTCOME_2: z.object({ result: z.string() }),
			OUTCOME_3: z.object({ result: z.string() }), OUTCOME_4: z.object({ result: z.string() }),
			OUTCOME_5: z.object({ result: z.string() }), OUTCOME_6: z.object({ result: z.string() }),
		},
	}),
});
const OverflowActor = actor({
	input: z.object({ file: z.string() }).strict(),
	protocol: OverflowProtocol,
	initial: "idle",
	states: {
		idle: receive({ on: { PROCESS_WITH_A_LONG_PROTOCOL_EVENT_NAME: "settle" } }),
		settle: reply({ target: "idle", event: "OUTCOME_1", output: { result: "accepted" } }),
	},
});
const overflowInput = (index: number) => ({
	field1: `value-${index}-1`, field2: `value-${index}-2`, field3: `value-${index}-3`, field4: `value-${index}-4`,
	field5: `value-${index}-5`, field6: `value-${index}-6`, field7: `value-${index}-7`, field8: `value-${index}-8`,
});
const overflowActor = OverflowActor({ file: "overflow.ts" });
const overflowScenario = storyScenario(chart({ kind: "chart", id: "actor-overflow-story", actors: { overflow: overflowActor }, initial: "queue", states: { queue: send({ to: overflowActor, event: "PROCESS_WITH_A_LONG_PROTOCOL_EVENT_NAME", inputs: Array.from({ length: 50 }, (_, index) => overflowInput(index)), target: "done" }), done: final() } }));
const overflowAst = overflowScenario.ast;
const overflowQueue = sourceState(overflowAst, "queue");
if (overflowQueue.kind !== "send" || !Array.isArray(overflowQueue.inputs)) throw new Error("expected overflow batch send state");
const overflowMessages = overflowQueue.inputs.map((_, index) => envelope(overflowAst, "queue", "queue", `queue:1:${index}`, index));
const overflowRecords: DurableLogRecord[] = [
	{ type: "args", args: {}, ...stamp(1) },
	created(overflowAst, "@overflow", "@overflow", 2),
	enqueue(overflowAst, "queue", "@overflow", "PROCESS_WITH_A_LONG_PROTOCOL_EVENT_NAME", overflowMessages, 3),
];
export const actorOverflowRun = overflowScenario.runtimeRun(overflowRecords, { runId: "actor:overflow", status: { state: "running", updatedAt: now + 3_000 }, cwd: "/workspace", createdAt: now, updatedAt: now + 3_000 });

// Dialog navigation is intentionally visual-state driven. Semantic fixtures above
// remain available to focused tests and card stories without duplicating full dialogs.
export const allActorRuns = [
	actorIdleRun,
	actorBusyFifoRun,
	actorReentryRun,
	actorDrainingRun,
	actorFailureRun,
	actorBrokenReplayRun,
];
