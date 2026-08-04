import { z } from "zod";
import {
	agent,
	actor,
	call,
	chart,
	failed,
	final,
	message,
	protocol,
	receive,
	reply,
	send,
} from "../../core/dsl.js";
import type { DurableLogRecord } from "../../core/durable_events.js";
import type { ChartAst, ChartCst } from "../../core/types.js";
import { storyScenario } from "./story-scenario.js";

export const EditorProtocol = protocol({
	APPLY: message({
		input: z.object({ patch: z.string() }).strict(),
		replies: {
			APPLIED: z.object({ commit: z.string() }).strict(),
			REJECTED: z.object({ reason: z.string() }).strict(),
		},
	}),
	REVIEW: message({
		input: z.object({
			revision: z.object({
				commit: z.string(),
				files: z.array(z.object({
					path: z.string(),
					changes: z.object({ additions: z.number().int(), deletions: z.number().int() }).strict(),
				}).strict()),
			}).strict(),
			policy: z.object({ requiredChecks: z.array(z.string()), minimumCoverage: z.number() }).strict(),
			reviewers: z.array(z.object({ name: z.string(), role: z.enum(["owner", "security", "quality"]) }).strict()),
		}).strict(),
		replies: {
			APPROVED: z.object({
				approval: z.object({ reviewer: z.string(), timestamp: z.string() }).strict(),
				checks: z.record(z.string(), z.enum(["passed", "waived"])),
			}).strict(),
			CHANGES_REQUESTED: z.object({
				summary: z.string(),
				comments: z.array(z.object({
					path: z.string(), line: z.number().int(), severity: z.enum(["warning", "blocking"]), message: z.string(),
				}).strict()),
			}).strict(),
		},
	}),
	ARCHIVE: message({
		input: z.object({
			destination: z.enum(["local", "remote"]),
			commits: z.array(z.string()),
			manifest: z.record(z.string(), z.object({ checksum: z.string(), bytes: z.number().int() }).strict()),
			retention: z.object({ days: z.number().int(), legalHold: z.boolean() }).strict(),
		}).strict(),
	}),
});

export const Editor = actor({
	input: z.object({ file: z.string() }).strict(),
	protocol: EditorProtocol,
	initial: "idle",
	states: {
		idle: receive({ on: { APPLY: "apply", REVIEW: "review", ARCHIVE: "archive" } }),
		apply: {
			kind: "state",
			action: agent("actor-editor", {
				task: "Apply the accepted patch inside the actor occurrence.",
				reply: z.object({ commit: z.string() }).strict(),
			}),
			transitions: { DONE: "settle" },
		},
		settle: reply({ target: "idle", event: "APPLIED", output: { commit: "storybook-commit" } }),
		review: {
			kind: "state",
			action: agent("actor-reviewer", {
				task: "Review the accepted revision, policy, and reviewer roster.",
				reply: z.object({ reviewer: z.string(), timestamp: z.string() }).strict(),
			}),
			transitions: { DONE: "approve" },
		},
		approve: reply({
			target: "idle",
			event: "APPROVED",
			output: { approval: { reviewer: "quality-bot", timestamp: "2026-08-04T16:00:00Z" }, checks: { tests: "passed" } },
		}),
		archive: reply({ target: "idle" }),
	},
});

const editor = Editor({ file: "src/index.ts" });

/** A real authoring fixture shared by actor boards, adapter stories, and structural tests. */
export const actorInspectorChart: ChartCst = chart({
	kind: "chart",
	id: "actor-inspector-ui",
	actors: { editor },
	initial: "queue",
	states: {
		queue: send({
			to: editor,
			event: "APPLY",
			inputs: [{ patch: "patch-0" }],
			target: "queue-review",
		}),
		"queue-review": send({
			to: editor,
			event: "REVIEW",
			input: {
				revision: {
					commit: "abc1234",
					files: [
						{ path: "src/editor.ts", changes: { additions: 42, deletions: 7 } },
						{ path: "tests/editor.test.ts", changes: { additions: 31, deletions: 2 } },
					],
				},
				policy: { requiredChecks: ["typecheck", "unit", "replay"], minimumCoverage: 0.9 },
				reviewers: [
					{ name: "Mira", role: "owner" },
					{ name: "Sol", role: "quality" },
				],
			},
			target: "queue-archive",
		}),
		"queue-archive": send({
			to: editor,
			event: "ARCHIVE",
			input: {
				destination: "remote",
				commits: ["abc1234", "def5678"],
				manifest: {
					"dist/editor.js": { checksum: "sha256:81f5", bytes: 18_432 },
					"dist/editor.d.ts": { checksum: "sha256:29ab", bytes: 2_048 },
				},
				retention: { days: 90, legalHold: false },
			},
			target: "apply-call",
		}),
		"apply-call": call({
			to: editor,
			event: "APPLY",
			input: { patch: "follow-up patch" },
			transitions: { APPLIED: "done", REJECTED: "failed" },
		}),
		done: final(),
		failed: failed(),
	},
});

const actorInspectorScenario = storyScenario(actorInspectorChart, "storybook:actor-inspector-ui");
export const actorInspectorAst = actorInspectorScenario.ast;
const actorStoryTimestamp = 1_700_000_000_000;

/**
 * Durable facts leave the first batch item inside the actor action and the remaining items in FIFO order.
 * This intentionally exercises the runtime adapter rather than hand-authoring React models.
 */
export function actorInspectorRecords(ast: ChartAst): DurableLogRecord[] {
	const declaration = ast.actors["@editor"];
	const queue = ast.states.queue;
	const queueReview = ast.states["queue-review"];
	const queueArchive = ast.states["queue-archive"];
	const applyCall = ast.states["apply-call"];
	const action = declaration?.states.apply;
	const applyInputSchema = declaration?.protocol.APPLY?.input;
	const reviewInputSchema = declaration?.protocol.REVIEW?.input;
	const archiveInputSchema = declaration?.protocol.ARCHIVE?.input;
	if (declaration === undefined || queue?.kind !== "send" || !Array.isArray(queue.inputs) || queueReview?.kind !== "send" || queueReview.input === undefined || queueArchive?.kind !== "send" || queueArchive.input === undefined || applyCall?.kind !== "call" || action?.kind !== "state" || applyInputSchema === undefined || reviewInputSchema === undefined || archiveInputSchema === undefined) {
		throw new Error("actor inspector fixture did not normalize to the expected actor graph");
	}
	return [
		{ type: "args", args: {}, parentId: null, seqId: 1, timestamp: actorStoryTimestamp + 1 },
		{
			type: "actor_created",
			declaration: "@editor",
			logicalOccurrence: "@editor",
			occurrence: "@editor",
			generation: 1,
			input: { file: "src/index.ts" },
			definition: declaration,
			parentId: 1,
			seqId: 2,
			timestamp: actorStoryTimestamp + 2,
		},
		{
			type: "actor_messages_enqueued",
			occurrence: "@editor",
			generation: 1,
			source: {
				producerState: "queue",
				kind: "send",
				definition: queue,
				targetDeclaration: "@editor",
				event: "APPLY",
				inputSchema: applyInputSchema,
			},
			messages: queue.inputs.map((input, index) => ({
				messageId: `queue:1:${index}`,
				event: "APPLY",
				input,
				producerState: "queue",
				producerVisit: 1,
				batchIndex: index,
			})),
			parentId: 2,
			seqId: 3,
			timestamp: actorStoryTimestamp + 3,
		},
		{
			type: "actor_messages_enqueued",
			occurrence: "@editor",
			generation: 1,
			source: {
				producerState: "queue-review",
				kind: "send",
				definition: queueReview,
				targetDeclaration: "@editor",
				event: queueReview.event,
				inputSchema: reviewInputSchema,
			},
			messages: [{ messageId: "queue-review:1:0", event: queueReview.event, input: queueReview.input, producerState: "queue-review", producerVisit: 1, batchIndex: 0 }],
			parentId: 3,
			seqId: 4,
			timestamp: actorStoryTimestamp + 4,
		},
		{
			type: "actor_messages_enqueued",
			occurrence: "@editor",
			generation: 1,
			source: {
				producerState: "queue-archive",
				kind: "send",
				definition: queueArchive,
				targetDeclaration: "@editor",
				event: queueArchive.event,
				inputSchema: archiveInputSchema,
			},
			messages: [{ messageId: "queue-archive:1:0", event: queueArchive.event, input: queueArchive.input, producerState: "queue-archive", producerVisit: 1, batchIndex: 0 }],
			parentId: 4,
			seqId: 5,
			timestamp: actorStoryTimestamp + 5,
		},
		{
			type: "actor_messages_enqueued",
			occurrence: "@editor",
			generation: 1,
			source: {
				producerState: "apply-call",
				kind: "call",
				definition: applyCall,
				targetDeclaration: "@editor",
				event: applyCall.event,
				inputSchema: applyInputSchema,
			},
			messages: [{
				messageId: "apply-call:1:0",
				event: applyCall.event,
				input: applyCall.input,
				producerState: "apply-call",
				producerVisit: 1,
				batchIndex: 0,
				callId: "apply-call:1",
			}],
			parentId: 5,
			seqId: 6,
			timestamp: actorStoryTimestamp + 6,
		},
		{
			type: "actor_message",
			kind: "accepted",
			occurrence: "@editor",
			messageId: "queue:1:0",
			receiveState: "@editor.idle",
			parentId: 6,
			seqId: 7,
			timestamp: actorStoryTimestamp + 7,
		},
		{
			type: "state_action",
			kind: "invoke",
			actionUid: { ...action.action.uid, state: "@editor.apply" },
			definition: action.action,
			parentId: 7,
			seqId: 8,
			timestamp: actorStoryTimestamp + 8,
		},
	];
}

export const actorInspectorInspectResult = actorInspectorScenario.inspect;

export const actorStaticAdapterRun = actorInspectorScenario.staticRun({
	runId: "inspect:actor-inspector-ui",
	cwd: "/workspace",
	createdAt: 1_700_000_000_000,
	updatedAt: 1_700_000_000_000,
});

export const actorRuntimeAdapterRun = actorInspectorScenario.runtimeRun(
	actorInspectorRecords(actorInspectorAst),
	{
		runId: "run:actor-inspector-ui",
		status: {
			runId: "run:actor-inspector-ui",
			chartId: "actor-inspector-ui",
			state: "running",
			startedAt: 1_700_000_000_000,
			updatedAt: 1_700_000_005_000,
		},
		cwd: "/workspace",
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_005_000,
	},
);

const MailboxProtocol = protocol({ PING: message({ input: z.object({ value: z.string() }).strict() }) });
const MailboxWorker = actor({
	input: z.object({ channel: z.string() }).strict(),
	protocol: MailboxProtocol,
	initial: "idle",
	states: {
		idle: receive({ on: { PING: "settle" } }),
		settle: reply({ target: "idle" }),
	},
});
const mailboxWorker = MailboxWorker({ channel: "primary" });

export const mailboxReentryChart = chart({
	kind: "chart",
	id: "actor-mailbox-reentry-ui",
	initial: "phase",
	states: {
		phase: {
			kind: "compound",
			actors: { worker: mailboxWorker },
			initial: "dispatch",
			onDone: "between",
			states: {
				dispatch: send({
					to: mailboxWorker,
					event: "PING",
					inputs: [{ value: "first" }, { value: "second" }],
					target: "hold",
				}),
				hold: { kind: "state", action: agent("mailbox-holder"), transitions: { EXIT: "finished" } },
				finished: final(),
			},
		},
		between: { kind: "state", action: agent("mailbox-reentry"), transitions: { AGAIN: "phase" } },
	},
});

const mailboxReentryScenario = storyScenario(mailboxReentryChart, "storybook:actor-mailbox-reentry-ui");
export const mailboxReentryAst = mailboxReentryScenario.ast;

export function mailboxReentryRecords(ast: ChartAst): DurableLogRecord[] {
	const declaration = ast.actors["phase.@worker"];
	const dispatch = ast.states["phase.dispatch"];
	const hold = ast.states["phase.hold"];
	const between = ast.states.between;
	const contract = declaration?.protocol.PING;
	if (declaration === undefined || dispatch?.kind !== "send" || !Array.isArray(dispatch.inputs) || hold?.kind !== "state" || between?.kind !== "state" || contract === undefined) {
		throw new Error("mailbox reentry fixture did not normalize to the expected graph");
	}
	const dispatchInputs = dispatch.inputs;
	const stamp = (seqId: number) => ({ parentId: seqId === 1 ? null : seqId - 1, seqId, timestamp: actorStoryTimestamp + 100 + seqId });
	const messages = (visit: number) => dispatchInputs.map((input, batchIndex) => ({
		messageId: `phase.dispatch:message:${visit}:${batchIndex}`,
		event: dispatch.event,
		input,
		producerState: "phase.dispatch",
		producerVisit: visit,
		batchIndex,
	}));
	const enqueue = (occurrence: string, generation: number, visit: number, seqId: number): DurableLogRecord => ({
		type: "actor_messages_enqueued",
		occurrence,
		generation,
		source: { producerState: "phase.dispatch", kind: "send", definition: dispatch, targetDeclaration: "phase.@worker", event: dispatch.event, inputSchema: contract.input },
		messages: messages(visit),
		...stamp(seqId),
	});
	const actorCreated = (occurrence: string, generation: number, seqId: number): DurableLogRecord => ({
		type: "actor_created",
		declaration: "phase.@worker",
		logicalOccurrence: "phase.@worker",
		occurrence,
		generation,
		owner: "phase",
		input: declaration.inputValue,
		definition: declaration,
		...stamp(seqId),
	});
	const first = messages(1);
	const second = messages(2);
	return [
		{ type: "args", args: {}, ...stamp(1) },
		actorCreated("phase.@worker", 1, 2),
		enqueue("phase.@worker", 1, 1, 3),
		{ type: "state_action", kind: "invoke", actionUid: hold.action.uid, definition: hold.action, ...stamp(4) },
		{ type: "actor_message", kind: "accepted", occurrence: "phase.@worker", messageId: first[0]!.messageId, receiveState: "phase.@worker.idle", ...stamp(5) },
		{ type: "actor_message", kind: "replied", occurrence: "phase.@worker", messageId: first[0]!.messageId, message: "PING", ...stamp(6) },
		{ type: "actor_message", kind: "settled", occurrence: "phase.@worker", messageId: first[0]!.messageId, ...stamp(7) },
		{ type: "actor_message", kind: "accepted", occurrence: "phase.@worker", messageId: first[1]!.messageId, receiveState: "phase.@worker.idle", ...stamp(8) },
		{ type: "actor_message", kind: "replied", occurrence: "phase.@worker", messageId: first[1]!.messageId, message: "PING", ...stamp(9) },
		{ type: "actor_message", kind: "settled", occurrence: "phase.@worker", messageId: first[1]!.messageId, ...stamp(10) },
		{ type: "state_action", kind: "complete", actionUid: hold.action.uid, event: { type: "EXIT" }, ...stamp(11) },
		{ type: "actor_scope", kind: "closing", occurrence: "phase.@worker", ...stamp(12) },
		{ type: "actor_scope", kind: "stopped", occurrence: "phase.@worker", ...stamp(13) },
		{ type: "state_action", kind: "invoke", actionUid: between.action.uid, definition: between.action, ...stamp(14) },
		{ type: "state_action", kind: "complete", actionUid: between.action.uid, event: { type: "AGAIN" }, ...stamp(15) },
		actorCreated("phase.@worker~2", 2, 16),
		enqueue("phase.@worker~2", 2, 2, 17),
		{ type: "state_action", kind: "invoke", actionUid: hold.action.uid, definition: hold.action, ...stamp(18) },
		{ type: "actor_message", kind: "accepted", occurrence: "phase.@worker~2", messageId: second[0]!.messageId, receiveState: "phase.@worker~2.idle", ...stamp(19) },
	];
}

export const mailboxReentryRun = mailboxReentryScenario.runtimeRun(mailboxReentryRecords(mailboxReentryAst), {
	runId: "actor:mailbox-reentry",
	status: { state: "running", updatedAt: actorStoryTimestamp + 119 },
	cwd: "/workspace",
	createdAt: actorStoryTimestamp + 101,
	updatedAt: actorStoryTimestamp + 119,
});
