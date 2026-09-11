import { agent, chart, final, user } from "../../core/dsl.js";
import type { DurableLogRecord } from "../../core/durable_events.js";
import { actionAt, storyScenario } from "./story-scenario.js";
import { capturedStorySchedule } from "./capture-story-schedule.js";

const stamp = (seqId: number) => ({
	seqId,
	parentId: seqId === 1 ? null : seqId - 1,
	branchId: "main",
	timestamp: Date.UTC(2026, 7, 31, 19) + seqId * 1_000,
});
export const plainScenario = storyScenario(
	chart({
		kind: "chart",
		id: "records-without-input",
		initial: "approval",
		states: {
			approval: {
				kind: "state",
				action: user({ prompt: "Continue?", options: ["CONTINUE"] }),
				transitions: { CONTINUE: "work" },
			},
			work: {
				kind: "state",
				action: agent("worker", { task: "Continue without state input." }),
				transitions: { DONE: "done" },
			},
			done: final(),
		},
	}),
);
const approval = actionAt(plainScenario.ast, "approval");
const work = actionAt(plainScenario.ast, "work");
const prefixSchedule: DurableLogRecord[] = [
	{ type: "args", args: {}, ...stamp(1) },
	{
		type: "state_action",
		kind: "invoke",
		sessionId: "approval-session",
		actionUid: approval.uid,
		definition: approval,
		...stamp(2),
	},
	{
		type: "user_interaction",
		kind: "opened",
		actionUid: approval.uid,
		phaseSeqId: 2,
		prompt: "Continue?",
		options: ["CONTINUE"],
		events: ["CONTINUE"],
		...stamp(3),
	},
];
const stateSchedule: DurableLogRecord[] = [
	...prefixSchedule,
	{
		type: "user_interaction",
		kind: "resolved",
		gateSeqId: 3,
		actionUid: approval.uid,
		event: { type: "CONTINUE" },
		...stamp(4),
	},
	{
		type: "state_action",
		kind: "invoke",
		sessionId: "work-session",
		actionUid: work.uid,
		definition: work,
		...stamp(5),
	},
];
export const plainPrefix = capturedStorySchedule(plainScenario.ast, prefixSchedule);
export const plainStateRecords = capturedStorySchedule(plainScenario.ast, stateSchedule);
