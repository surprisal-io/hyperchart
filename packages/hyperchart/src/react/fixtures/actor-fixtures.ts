import { z } from "zod";
import { agent, actor, actorPool, arg, call, callBatch, chart, failed, final, item, map, message, protocol, receive, reply, self, send, sendBatch } from "../../core/dsl.js";
import type { DurableLogRecord, ActorMessageEnvelope } from "../../core/durable_events.js";
import { explainReplay } from "../../core/replay_check.js";
import type { ActorDeclarationAst, ActorEndpointDeclarationAst, CallStateAst, CallBatchStateAst, ChartAst, SendStateAst, SendBatchStateAst } from "../../core/types.js";
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
const stamp = (seqId: number) => ({ parentId: seqId === 1 ? null : seqId - 1, seqId, branchId: "main", timestamp: now + seqId * 1_000 });

function endpointDefinition(ast: ChartAst, path: string): ActorEndpointDeclarationAst {
	const definition = ast.actors[path];
	if (definition === undefined) throw new Error(`missing actor endpoint declaration ${path}`);
	return definition;
}
function actorDefinition(ast: ChartAst, path: string): ActorDeclarationAst {
	const definition = endpointDefinition(ast, path);
	if (definition.kind !== "actor") throw new Error(`missing ordinary actor declaration ${path}`);
	return definition;
}
function messageContract(ast: ChartAst, declaration: string, event: string) {
	const contract = endpointDefinition(ast, declaration).protocol[event];
	if (contract === undefined) throw new Error(`missing actor message ${declaration}.${event}`);
	return contract;
}
function sourceState(ast: ChartAst, path: string): SendStateAst | SendBatchStateAst | CallStateAst | CallBatchStateAst {
	const state = ast.states[path];
	if (state?.kind !== "send" && state?.kind !== "sendBatch" && state?.kind !== "call" && state?.kind !== "callBatch") throw new Error(`missing actor source ${path}`);
	return state;
}
function created(ast: ChartAst, declarationPath: string, occurrence: string, seqId: number, owner?: string, resolvedInput?: unknown, generation = 1): DurableLogRecord {
	const definition = endpointDefinition(ast, declarationPath);
	return { type: "actor_created", declaration: declarationPath, occurrence, generation, ...(owner === undefined ? {} : { owner }), input: resolvedInput ?? definition.inputValue, definition, ...stamp(seqId) };
}
function envelope(ast: ChartAst, definitionPath: string, producerState: string, messageId: string, batchIndex: number, callId?: string): ActorMessageEnvelope {
	const definition = sourceState(ast, definitionPath);
	const input = definition.kind === "call" || definition.kind === "send"
		? definition.input
		: Array.isArray(definition.inputs)
			? definition.inputs[batchIndex]
			: undefined;
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

const SelfProtocol = protocol({ CRAWL: message({ input: z.object({ url: z.string() }).strict() }) });
const SelfWorker = actor({
	input: z.object({}).strict(), protocol: SelfProtocol, initial: "idle",
	states: {
		idle: receive({ on: { CRAWL: "fanout" } }),
		fanout: sendBatch({ to: self(), event: "CRAWL", inputs: [{ url: "/docs" }, { url: "/about" }], target: "settle" }),
		settle: reply({ target: "idle" }),
	},
});
const selfWorkers = actorPool({ concurrency: 3, worker: SelfWorker })({});
export const actorSelfChart = chart({
	kind: "chart", id: "actor-self-send-story", actors: { workers: selfWorkers }, initial: "start",
	states: { start: send({ to: selfWorkers, event: "CRAWL", input: { url: "/" }, target: "done" }), done: final() },
});
export const actorSelfScenario = storyScenario(actorSelfChart);
export const actorSelfSendRun = actorSelfScenario.staticRun({ runId: "actor:self-send" });

const callEditor = Editor({ file: "src/index.ts" });
const callScenario = storyScenario(chart({ kind: "chart", id: "actor-call-story", actors: { editor: callEditor }, initial: "apply", states: { apply: call({ to: callEditor, event: "APPLY", input: { patch: "follow-up" }, transitions: { APPLIED: "done", REJECTED: "done" } }), done: final() } }));
export const actorCallAst = callScenario.ast;
const callAst = actorCallAst;
const callBaseRecords: DurableLogRecord[] = [{ type: "args", args: {}, ...stamp(1) }, created(callAst, "@editor", "@editor", 2)];
const callMessage = envelope(callAst, "apply", "apply", "apply:message:1:0", 0, "apply:call:1");
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
	{ type: "state_action", kind: "invoke", sessionId: "session-id", actionUid: editorApplyUid, definition: editorApply.action, ...stamp(5) },
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
				dispatch: sendBatch({
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
if (drainDispatch.kind !== "sendBatch" || !Array.isArray(drainDispatch.inputs)) throw new Error("expected structured-drain batch send");
const drainMessages = drainDispatch.inputs.map((_, index) => envelope(drainAst, "phase.dispatch", "phase.dispatch", `phase.dispatch:message:1:${index}`, index));
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
		queue: sendBatch({ to: changedEditor, event: "APPLY", inputs: [{ patch: "first patch" }, { patch: "second patch" }], target: "apply-call" }),
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
const auditMessage = envelope(auditAst, "record", "record", "record:message:1:0", 0);
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
	{ type: "state_action", kind: "invoke", sessionId: "session-id", actionUid: reentryAction.action.uid, definition: reentryAction.action, ...stamp(8) },
	{ type: "state_action", kind: "complete", actionUid: reentryAction.action.uid, event: { type: "AGAIN" }, ...stamp(9) },
	{ type: "actor_created", declaration: "phase.@auditor", occurrence: "phase.@auditor~2", generation: 2, owner: "phase", input: reentryDefinition.inputValue, definition: reentryDefinition, ...stamp(10) },
	enqueue(reentryAst, "phase.record", "phase.@auditor~2", "RECORD", [reentryMessage2], 11, "phase.record", 2),
	{ type: "actor_message", kind: "accepted", occurrence: "phase.@auditor~2", messageId: reentryMessage2.messageId, receiveState: "phase.@auditor~2.idle", ...stamp(12) },
	{ type: "actor_scope", kind: "closing", occurrence: "phase.@auditor~2", ...stamp(13) },
	{ type: "actor_message", kind: "replied", occurrence: "phase.@auditor~2", messageId: reentryMessage2.messageId, message: "RECORD", ...stamp(14) },
	{ type: "actor_message", kind: "settled", occurrence: "phase.@auditor~2", messageId: reentryMessage2.messageId, ...stamp(15) },
	{ type: "actor_scope", kind: "stopped", occurrence: "phase.@auditor~2", ...stamp(16) },
	{ type: "state_action", kind: "invoke", sessionId: "session-id", actionUid: reentryAction.action.uid, definition: reentryAction.action, ...stamp(17) },
	{ type: "state_action", kind: "complete", actionUid: reentryAction.action.uid, event: { type: "AGAIN" }, ...stamp(18) },
	{ type: "actor_created", declaration: "phase.@auditor", occurrence: "phase.@auditor~3", generation: 3, owner: "phase", input: reentryDefinition.inputValue, definition: reentryDefinition, ...stamp(19) },
	enqueue(reentryAst, "phase.record", "phase.@auditor~3", "RECORD", [reentryMessage3], 20, "phase.record", 3),
	{ type: "actor_message", kind: "accepted", occurrence: "phase.@auditor~3", messageId: reentryMessage3.messageId, receiveState: "phase.@auditor~3.idle", ...stamp(21) },
	{ type: "actor_scope", kind: "closing", occurrence: "phase.@auditor~3", ...stamp(22) },
	{ type: "actor_message", kind: "replied", occurrence: "phase.@auditor~3", messageId: reentryMessage3.messageId, message: "RECORD", ...stamp(23) },
	{ type: "actor_message", kind: "settled", occurrence: "phase.@auditor~3", messageId: reentryMessage3.messageId, ...stamp(24) },
	{ type: "actor_scope", kind: "stopped", occurrence: "phase.@auditor~3", ...stamp(25) },
	{ type: "state_action", kind: "invoke", sessionId: "session-id", actionUid: reentryAction.action.uid, definition: reentryAction.action, ...stamp(26) },
];
export const actorReentryRun = reentryScenario.runtimeRun(reentryRecords, { runId: "actor:reentry", status: { state: "running", updatedAt: now + 26_000 }, cwd: "/workspace", createdAt: now, updatedAt: now + 26_000 });

const mapEditor = Editor({ file: item("file") });
const mapScenario = storyScenario(chart({ kind: "chart", id: "actor-map-story", args: { projects: {} }, initial: "projects", states: { projects: map({ over: arg("projects"), actors: { editor: mapEditor }, initial: "apply", onDone: "done", states: { apply: call({ to: mapEditor, event: "APPLY", input: { patch: "p" }, transitions: { APPLIED: "finished", REJECTED: "finished" } }), finished: final() } }), done: final() } }));
const mapAst = mapScenario.ast;
const mapCallA = envelope(mapAst, "projects.apply", "projects#a.apply", "projects#a.apply:message:1:0", 0, "projects#a.apply:call:1");
const mapCallB = envelope(mapAst, "projects.apply", "projects#b.apply", "projects#b.apply:message:1:0", 0, "projects#b.apply:call:1");
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

const PoolWorkProtocol = protocol({
	WORK: message({ input: z.object({ id: z.number(), label: z.string() }).strict(), reply: z.object({ id: z.number(), receipt: z.string() }).strict() }),
});
const PoolWorker = actor({
	input: z.object({ lane: z.string() }).strict(),
	protocol: PoolWorkProtocol,
	initial: "idle",
	states: {
		idle: receive({ on: { WORK: "work" } }),
		work: { kind: "state", action: agent("pool-worker", { task: "Process the assigned pool item.", reply: z.object({ id: z.number(), receipt: z.string() }).strict() }), transitions: { DONE: "settle" } },
		settle: reply({ target: "idle", output: { id: 0, receipt: "storybook" } }),
	},
});
const PoolTemplate = actorPool({ concurrency: 2, worker: PoolWorker });
const storyPool = PoolTemplate({ lane: "storybook" });
export const actorPoolChart = chart({
	kind: "chart",
	id: "actor-pool-story",
	actors: { workers: storyPool },
	initial: "batch",
	states: {
		batch: callBatch({
			to: storyPool,
			event: "WORK",
			inputs: [
				{ id: 0, label: "alpha-with-a-long-value-for-narrow-layout" },
				{ id: 1, label: "beta" },
				{ id: 2, label: "gamma" },
				{ id: 3, label: "delta" },
			],
			target: "done",
		}),
		done: final(),
	},
});
const poolScenario = storyScenario(actorPoolChart);
export const actorPoolAst = poolScenario.ast;
const poolDefinition = endpointDefinition(actorPoolAst, "@workers");
if (poolDefinition.kind !== "actorPool") throw new Error("expected pool story declaration");
const poolAction = poolDefinition.worker.states.work;
if (poolAction?.kind !== "state") throw new Error("expected pool worker action");
const poolReply = poolDefinition.worker.states.settle;
if (poolReply?.kind !== "reply") throw new Error("expected pool worker reply");
const poolReplyContract = messageContract(actorPoolAst, "@workers", "WORK").reply;
if (poolReplyContract.kind !== "single") throw new Error("expected single pool reply schema");
const poolSource = sourceState(actorPoolAst, "batch");
if (poolSource.kind !== "callBatch" || !Array.isArray(poolSource.inputs)) throw new Error("expected pool callBatch story");
const poolMessages = poolSource.inputs.map((_, index) => envelope(actorPoolAst, "batch", "batch", `batch:message:1:${index}`, index, "batch:call:1"));
const poolWorkerUid = (index: number) => ({ ...poolAction.action.uid, state: poolAction.action.uid.state.replace(".$worker.", `.$worker-${index}.`) });
const poolAccepted = (messageIndex: number, workerIndex: number, seqId: number): DurableLogRecord => ({
	type: "actor_message", kind: "accepted", occurrence: "@workers", messageId: poolMessages[messageIndex]!.messageId,
	receiveState: `@workers.$worker-${workerIndex}.idle`, workerIndex, ...stamp(seqId),
});
const poolInvoked = (workerIndex: number, seqId: number): DurableLogRecord => ({
	type: "state_action", kind: "invoke", sessionId: "session-id", actionUid: poolWorkerUid(workerIndex), definition: poolAction.action, ...stamp(seqId),
});
const poolCompleted = (workerIndex: number, messageIndex: number, seqId: number): DurableLogRecord => ({
	type: "state_action", kind: "complete", actionUid: poolWorkerUid(workerIndex), event: { type: "DONE", output: { id: messageIndex, receipt: `receipt-${messageIndex}` } }, ...stamp(seqId),
});
const poolReplied = (messageIndex: number, workerIndex: number, seqId: number): DurableLogRecord => ({
	type: "actor_message", kind: "replied", occurrence: "@workers", messageId: poolMessages[messageIndex]!.messageId, message: "WORK",
	output: { id: messageIndex, receipt: `receipt-${messageIndex}` }, schema: poolReplyContract.schema, workerIndex, ...stamp(seqId),
});
const poolSettled = (messageIndex: number, workerIndex: number, seqId: number): DurableLogRecord => ({
	type: "actor_message", kind: "settled", occurrence: "@workers", messageId: poolMessages[messageIndex]!.messageId, workerIndex, ...stamp(seqId),
});
const poolBaseRecords: DurableLogRecord[] = [
	{ type: "args", args: {}, ...stamp(1) },
	created(actorPoolAst, "@workers", "@workers", 2),
];
const poolEnqueuedRecords: DurableLogRecord[] = [
	...poolBaseRecords,
	enqueue(actorPoolAst, "batch", "@workers", "WORK", poolMessages, 3),
];
export const actorPoolBusyRecords: DurableLogRecord[] = [
	...poolEnqueuedRecords,
	poolAccepted(0, 0, 4),
	poolAccepted(1, 1, 5),
	poolInvoked(0, 6),
	poolInvoked(1, 7),
	poolCompleted(1, 1, 8),
];
const poolPartialRecords: DurableLogRecord[] = [
	...actorPoolBusyRecords,
	poolReplied(1, 1, 9),
	poolSettled(1, 1, 10),
];
const poolCompleteRecords: DurableLogRecord[] = [
	...poolPartialRecords,
	poolAccepted(2, 1, 11),
	poolInvoked(1, 12),
	poolCompleted(1, 2, 13),
	poolReplied(2, 1, 14),
	poolSettled(2, 1, 15),
	poolCompleted(0, 0, 16),
	poolReplied(0, 0, 17),
	poolSettled(0, 0, 18),
	poolAccepted(3, 0, 19),
	poolInvoked(0, 20),
	poolCompleted(0, 3, 21),
	poolReplied(3, 0, 22),
	poolSettled(3, 0, 23),
	{ type: "actor_batch_call_resolved", callId: "batch:call:1", callerState: "batch", messageIds: poolMessages.map((message) => message.messageId), ...stamp(24) },
	{ type: "actor_scope", kind: "closing", occurrence: "@workers", ...stamp(25) },
	{ type: "actor_scope", kind: "stopped", occurrence: "@workers", ...stamp(26) },
];
const poolSessionProgress = {
	updatedAt: now + 23_000,
	sessions: {
		"actor-pool-story:@workers.$worker-0.work:work:1:6": { actionUid: poolWorkerUid(0), visit: 1, status: "completed", startedAt: now + 6_000, completedAt: now + 16_000, model: "storybook/pool-worker", turnCount: 2, lastMessage: "Finished alpha." },
		"actor-pool-story:@workers.$worker-1.work:work:1:7": { actionUid: poolWorkerUid(1), visit: 1, status: "completed", startedAt: now + 7_000, completedAt: now + 8_000, model: "storybook/pool-worker", turnCount: 1, lastMessage: "Finished beta first." },
		"actor-pool-story:@workers.$worker-1.work:work:2:12": { actionUid: poolWorkerUid(1), visit: 2, status: "completed", startedAt: now + 12_000, completedAt: now + 13_000, model: "storybook/pool-worker", turnCount: 1, lastMessage: "Reused worker for gamma." },
	},
};
export const actorPoolIdleRun = poolScenario.runtimeRun(poolBaseRecords, { runId: "actor:pool-idle", status: { state: "running", updatedAt: now + 2_000 }, cwd: "/workspace", createdAt: now, updatedAt: now + 2_000 });
export const actorPoolBusyRun = poolScenario.runtimeRun(actorPoolBusyRecords, { runId: "actor:pool-busy", status: { state: "running", updatedAt: now + 8_000 }, cwd: "/workspace", createdAt: now, updatedAt: now + 8_000, sessionProgress: poolSessionProgress });
export const actorPoolPartialBatchRun = poolScenario.runtimeRun(poolPartialRecords, { runId: "actor:pool-partial", status: { state: "running", updatedAt: now + 10_000 }, cwd: "/workspace", createdAt: now, updatedAt: now + 10_000, sessionProgress: poolSessionProgress });
export const actorPoolOutOfOrderRun = poolScenario.runtimeRun(poolCompleteRecords, { runId: "actor:pool-complete", status: { state: "complete", updatedAt: now + 26_000 }, cwd: "/workspace", createdAt: now, updatedAt: now + 26_000, sessionProgress: poolSessionProgress });

const crowdedPool = PoolTemplate({ lane: "crowded" });
export const actorPoolCrowdedChart = chart({
	kind: "chart",
	id: "actor-pool-crowded-story",
	actors: { workers: crowdedPool },
	initial: "batch",
	states: {
		batch: callBatch({
			to: crowdedPool,
			event: "WORK",
			inputs: [
				{ id: 0, label: "queued-item-0" }, { id: 1, label: "queued-item-1" },
				{ id: 2, label: "queued-item-2" }, { id: 3, label: "queued-item-3" },
				{ id: 4, label: "queued-item-4" }, { id: 5, label: "queued-item-5" },
				{ id: 6, label: "queued-item-6" }, { id: 7, label: "queued-item-7" },
				{ id: 8, label: "queued-item-8" }, { id: 9, label: "queued-item-9" },
			],
			target: "done",
		}),
		done: final(),
	},
});
const crowdedScenario = storyScenario(actorPoolCrowdedChart);
const crowdedAst = crowdedScenario.ast;
const crowdedDefinition = endpointDefinition(crowdedAst, "@workers");
if (crowdedDefinition.kind !== "actorPool") throw new Error("expected crowded pool declaration");
const crowdedAction = crowdedDefinition.worker.states.work;
if (crowdedAction?.kind !== "state") throw new Error("expected crowded pool worker action");
const crowdedReplyContract = messageContract(crowdedAst, "@workers", "WORK").reply;
if (crowdedReplyContract.kind !== "single") throw new Error("expected crowded pool reply schema");
const crowdedSource = sourceState(crowdedAst, "batch");
if (crowdedSource.kind !== "callBatch" || !Array.isArray(crowdedSource.inputs)) throw new Error("expected crowded pool callBatch");
const crowdedMessages = crowdedSource.inputs.map((_, index) => envelope(crowdedAst, "batch", "batch", `batch:message:1:${index}`, index, "batch:call:1"));
const crowdedWorkerUid = (index: number) => ({ ...crowdedAction.action.uid, state: crowdedAction.action.uid.state.replace(".$worker.", `.$worker-${index}.`) });
const crowdedAccepted = (messageIndex: number, workerIndex: number, seqId: number): DurableLogRecord => ({
	type: "actor_message", kind: "accepted", occurrence: "@workers", messageId: crowdedMessages[messageIndex]!.messageId,
	receiveState: `@workers.$worker-${workerIndex}.idle`, workerIndex, ...stamp(seqId),
});
const crowdedInvoked = (workerIndex: number, seqId: number): DurableLogRecord => ({
	type: "state_action", kind: "invoke", sessionId: "session-id", actionUid: crowdedWorkerUid(workerIndex), definition: crowdedAction.action, ...stamp(seqId),
});
const crowdedCompleted = (workerIndex: number, messageIndex: number, seqId: number): DurableLogRecord => ({
	type: "state_action", kind: "complete", actionUid: crowdedWorkerUid(workerIndex), event: { type: "DONE", output: { id: messageIndex, receipt: `receipt-${messageIndex}` } }, ...stamp(seqId),
});
const crowdedReplied = (messageIndex: number, workerIndex: number, seqId: number): DurableLogRecord => ({
	type: "actor_message", kind: "replied", occurrence: "@workers", messageId: crowdedMessages[messageIndex]!.messageId, message: "WORK",
	output: { id: messageIndex, receipt: `receipt-${messageIndex}` }, schema: crowdedReplyContract.schema, workerIndex, ...stamp(seqId),
});
const crowdedSettled = (messageIndex: number, workerIndex: number, seqId: number): DurableLogRecord => ({
	type: "actor_message", kind: "settled", occurrence: "@workers", messageId: crowdedMessages[messageIndex]!.messageId, workerIndex, ...stamp(seqId),
});
export const actorPoolCrowdedRecords: DurableLogRecord[] = [
	{ type: "args", args: {}, ...stamp(1) },
	created(crowdedAst, "@workers", "@workers", 2),
	enqueue(crowdedAst, "batch", "@workers", "WORK", crowdedMessages, 3),
	crowdedAccepted(0, 0, 4),
	crowdedAccepted(1, 1, 5),
	crowdedInvoked(0, 6),
	crowdedInvoked(1, 7),
	crowdedCompleted(0, 0, 8),
	crowdedReplied(0, 0, 9),
	crowdedSettled(0, 0, 10),
	crowdedCompleted(1, 1, 11),
	crowdedReplied(1, 1, 12),
	crowdedSettled(1, 1, 13),
	crowdedAccepted(2, 0, 14),
	crowdedAccepted(3, 1, 15),
	crowdedInvoked(0, 16),
	crowdedInvoked(1, 17),
	crowdedCompleted(0, 2, 18),
	crowdedReplied(2, 0, 19),
	crowdedSettled(2, 0, 20),
	crowdedCompleted(1, 3, 21),
	crowdedReplied(3, 1, 22),
	crowdedSettled(3, 1, 23),
	crowdedAccepted(4, 0, 24),
	crowdedAccepted(5, 1, 25),
	crowdedInvoked(0, 26),
	crowdedInvoked(1, 27),
];
export const actorPoolCrowdedRun = crowdedScenario.runtimeRun(actorPoolCrowdedRecords, {
	runId: "actor:pool-crowded",
	status: { state: "running", updatedAt: now + 27_000 },
	cwd: "/workspace",
	createdAt: now,
	updatedAt: now + 27_000,
});

const drainingPool = PoolTemplate({ lane: "drain" });
const poolDrainScenario = storyScenario(chart({
	kind: "chart", id: "actor-pool-drain-story", initial: "phase",
	states: {
		phase: { kind: "compound", actors: { workers: drainingPool }, initial: "dispatch", onDone: "done", states: {
			dispatch: sendBatch({ to: drainingPool, event: "WORK", inputs: [
				{ id: 0, label: "alpha-with-a-long-value-for-narrow-layout" },
				{ id: 1, label: "beta" },
				{ id: 2, label: "gamma" },
				{ id: 3, label: "delta" },
			], target: "finished" }),
			finished: final(),
		} },
		done: final(),
	},
}));
const poolDrainAst = poolDrainScenario.ast;
const poolDrainSource = sourceState(poolDrainAst, "phase.dispatch");
if (poolDrainSource.kind !== "sendBatch" || !Array.isArray(poolDrainSource.inputs)) throw new Error("expected pool drain sendBatch");
const poolDrainMessages = poolDrainSource.inputs.map((_, index) => envelope(poolDrainAst, "phase.dispatch", "phase.dispatch", `phase.dispatch:message:1:${index}`, index));
const poolDrainRecords: DurableLogRecord[] = [
	{ type: "args", args: {}, ...stamp(1) },
	created(poolDrainAst, "phase.@workers", "phase.@workers", 2, "phase"),
	enqueue(poolDrainAst, "phase.dispatch", "phase.@workers", "WORK", poolDrainMessages, 3),
	{ type: "actor_message", kind: "accepted", occurrence: "phase.@workers", messageId: poolDrainMessages[0]!.messageId, receiveState: "phase.@workers.$worker-0.idle", workerIndex: 0, ...stamp(4) },
	{ type: "actor_message", kind: "accepted", occurrence: "phase.@workers", messageId: poolDrainMessages[1]!.messageId, receiveState: "phase.@workers.$worker-1.idle", workerIndex: 1, ...stamp(5) },
	{ type: "actor_scope", kind: "closing", occurrence: "phase.@workers", ...stamp(6) },
];
export const actorPoolDrainingRun = poolDrainScenario.runtimeRun(poolDrainRecords, { runId: "actor:pool-draining", status: { state: "running", updatedAt: now + 6_000 }, cwd: "/workspace", createdAt: now, updatedAt: now + 6_000 });

const MapPoolTemplate = actorPool({ concurrency: 2, worker: PoolWorker });
const mapPool = MapPoolTemplate({ lane: item("lane") });
const mapPoolScenario = storyScenario(chart({
	kind: "chart", id: "actor-pool-map-reentry-story", args: { projects: {} }, initial: "projects",
	states: {
		projects: map({ over: arg("projects"), actors: { workers: mapPool }, initial: "dispatch", onDone: "between", states: {
			dispatch: send({ to: mapPool, event: "WORK", input: { id: 0, label: "map-generation-work" }, target: "hold" }),
			hold: { kind: "state", action: agent("pool-map-hold"), transitions: { FINISH: "finished" } },
			finished: final(),
		} }),
		between: { kind: "state", action: agent("pool-map-loop"), transitions: { AGAIN: "projects", DONE: "done" } },
		done: final(),
	},
}));
const mapPoolAst = mapPoolScenario.ast;
const mapPoolInput = { lane: "map-a" };
const mapPoolBetween = mapPoolAst.states.between;
const mapPoolHold = mapPoolAst.states["projects.hold"];
const mapPoolDispatch = sourceState(mapPoolAst, "projects.dispatch");
const mapPoolDefinition = endpointDefinition(mapPoolAst, "projects.@workers");
if (mapPoolBetween?.kind !== "state" || mapPoolHold?.kind !== "state" || mapPoolDefinition.kind !== "actorPool") throw new Error("expected map pool loop actions");
const mapPoolWorkerAction = mapPoolDefinition.worker.states.work;
if (mapPoolWorkerAction?.kind !== "state") throw new Error("expected map pool worker action");
const mapPoolReply = messageContract(mapPoolAst, "projects.@workers", "WORK").reply;
if (mapPoolReply.kind !== "single") throw new Error("expected map pool reply schema");
const mapPoolHoldUid = { ...mapPoolHold.action.uid, state: "projects#a.hold" };
const mapPoolWorkerUid = { ...mapPoolWorkerAction.action.uid, state: "projects#a.@workers.$worker-0.work" };
const mapPoolMessage = envelope(mapPoolAst, "projects.dispatch", "projects#a.dispatch", "projects#a.dispatch:message:1:0", 0);
const mapPoolRecords: DurableLogRecord[] = [
	{ type: "args", args: { projects: { a: mapPoolInput } }, ...stamp(1) },
	{ type: "spawned", path: "projects", instances: { a: mapPoolInput }, ...stamp(2) },
	created(mapPoolAst, "projects.@workers", "projects#a.@workers", 3, "projects#a", mapPoolInput),
	enqueue(mapPoolAst, "projects#a.dispatch", "projects#a.@workers", mapPoolDispatch.event, [mapPoolMessage], 4, "projects.dispatch"),
	{ type: "actor_message", kind: "accepted", occurrence: "projects#a.@workers", messageId: mapPoolMessage.messageId, receiveState: "projects#a.@workers.$worker-0.idle", workerIndex: 0, ...stamp(5) },
	{ type: "state_action", kind: "invoke", sessionId: "session-id", actionUid: mapPoolWorkerUid, definition: mapPoolWorkerAction.action, ...stamp(6) },
	{ type: "state_action", kind: "complete", actionUid: mapPoolWorkerUid, event: { type: "DONE", output: { id: 0, receipt: "map-generation-receipt" } }, ...stamp(7) },
	{ type: "actor_message", kind: "replied", occurrence: "projects#a.@workers", messageId: mapPoolMessage.messageId, message: "WORK", output: { id: 0, receipt: "map-generation-receipt" }, schema: mapPoolReply.schema, workerIndex: 0, ...stamp(8) },
	{ type: "actor_message", kind: "settled", occurrence: "projects#a.@workers", messageId: mapPoolMessage.messageId, workerIndex: 0, ...stamp(9) },
	{ type: "state_action", kind: "invoke", sessionId: "session-id", actionUid: mapPoolHoldUid, definition: mapPoolHold.action, ...stamp(10) },
	{ type: "state_action", kind: "complete", actionUid: mapPoolHoldUid, event: { type: "FINISH" }, ...stamp(11) },
	{ type: "actor_scope", kind: "closing", occurrence: "projects#a.@workers", ...stamp(12) },
	{ type: "actor_scope", kind: "stopped", occurrence: "projects#a.@workers", ...stamp(13) },
	{ type: "state_action", kind: "invoke", sessionId: "session-id", actionUid: mapPoolBetween.action.uid, definition: mapPoolBetween.action, ...stamp(14) },
	{ type: "state_action", kind: "complete", actionUid: mapPoolBetween.action.uid, event: { type: "AGAIN" }, ...stamp(15) },
	{ type: "spawned", path: "projects", instances: { a: mapPoolInput }, ...stamp(16) },
	created(mapPoolAst, "projects.@workers", "projects#a.@workers~2", 17, "projects#a", mapPoolInput, 2),
];
export const actorPoolMapReentryRun = mapPoolScenario.runtimeRun(mapPoolRecords, { runId: "actor:pool-map-reentry", status: { state: "running", updatedAt: now + 17_000 }, cwd: "/workspace", createdAt: now, updatedAt: now + 17_000 });

export const allActorPoolRuns = [
	actorPoolIdleRun,
	actorPoolBusyRun,
	actorPoolPartialBatchRun,
	actorPoolOutOfOrderRun,
	actorPoolDrainingRun,
	actorPoolMapReentryRun,
];

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
const overflowScenario = storyScenario(chart({ kind: "chart", id: "actor-overflow-story", actors: { overflow: overflowActor }, initial: "queue", states: { queue: sendBatch({ to: overflowActor, event: "PROCESS_WITH_A_LONG_PROTOCOL_EVENT_NAME", inputs: Array.from({ length: 50 }, (_, index) => overflowInput(index)) as [ReturnType<typeof overflowInput>, ...ReturnType<typeof overflowInput>[]], target: "done" }), done: final() } }));
const overflowAst = overflowScenario.ast;
const overflowQueue = sourceState(overflowAst, "queue");
if (overflowQueue.kind !== "sendBatch" || !Array.isArray(overflowQueue.inputs)) throw new Error("expected overflow batch send state");
const overflowMessages = overflowQueue.inputs.map((_, index) => envelope(overflowAst, "queue", "queue", `queue:message:1:${index}`, index));
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
