import { agent, chart, final, script, user } from "../../core/dsl.js";
import type { DurableLogRecord } from "../../core/durable_events.js";
import type { ChartCst } from "../../core/types.js";
import { storyScenario } from "./story-scenario.js";

const FIXTURE_NOW = Date.UTC(2026, 6, 7, 22, 45, 0);
const STARTED_AT = FIXTURE_NOW - 900_000;
const args = { topic: "Google I/O 2026: most important recent announcements", audience: "executives" };

/**
 * The canonical Inspector/Dialog fixture. Every rendered state, edge, action definition,
 * and static source block is adapted from this normalized chart rather than hand-authored
 * as React view-model data.
 */
export const inspectorDialogChart: ChartCst = chart({
	kind: "chart",
	id: "deck-director",
	args: {
		topic: { description: "Research topic" },
		audience: { description: "Report audience" },
	},
	initial: "research-plan",
	states: {
		"research-plan": {
			kind: "state",
			action: agent("deck-source-scout", { task: "Create a report plan and source buckets." }),
			transitions: { DONE: "source-research" },
		},
		"source-research": {
			kind: "state",
			action: agent("deck-source-scout", { task: "Collect official, market, and developer evidence." }),
			transitions: { DONE: "narrative-plan" },
		},
		"narrative-plan": {
			kind: "state",
			action: agent("deck-narrative-synthesizer", { task: "Synthesize verified research into narrative beats." }),
			transitions: { DONE: "visual-review" },
		},
		"visual-review": {
			kind: "state",
			action: agent("deck-vision-scout", { task: "Check visual consistency, unsupported numbers, and data references." }),
			transitions: { DONE: "approval" },
		},
		approval: {
			kind: "state",
			action: user({ prompt: "Approve the verified report for rendering." }),
			transitions: { APPROVED: "render-report" },
		},
		"render-report": {
			kind: "state",
			action: script("node", ["scripts/render-report.mjs", "--format", "html"]),
			transitions: { DONE: "done" },
		},
		done: final(),
	},
});

const inspectorDialogScenario = storyScenario(inspectorDialogChart, "storybook:inspector-dialog");
export const inspectorDialogAst = inspectorDialogScenario.ast;
export const inspectorDialogInspectResult = inspectorDialogScenario.inspect;

function timestamp(seqId: number): number {
	return STARTED_AT + seqId * 1_000;
}

function actionRecord(
	statePath: string,
	kind: "invoke" | "complete",
	seqId: number,
	event?: string,
): DurableLogRecord {
	const state = inspectorDialogAst.states[statePath];
	if (state?.kind !== "state") throw new Error(`expected action state at ${statePath}`);
	const session = {
		parentId: seqId === 1 ? null : seqId - 1,
		seqId,
		branchId: "main", timestamp: timestamp(seqId),
	};
	if (kind === "invoke") {
		return {
			type: "state_action",
			kind: "invoke",
			actionUid: state.action.uid,
			definition: state.action,
			...session,
		};
	}
	if (event === undefined) throw new Error(`completion event is required for ${statePath}`);
	return {
		type: "state_action",
		kind: "complete",
		actionUid: state.action.uid,
		event: { type: event },
		...session,
	};
}

const commonRecords: DurableLogRecord[] = [
	{ type: "args", args, parentId: null, seqId: 1, branchId: "main", timestamp: timestamp(1) },
	actionRecord("research-plan", "invoke", 2),
	actionRecord("research-plan", "complete", 3, "DONE"),
	actionRecord("source-research", "invoke", 4),
	actionRecord("source-research", "complete", 5, "DONE"),
	actionRecord("narrative-plan", "invoke", 6),
	actionRecord("narrative-plan", "complete", 7, "DONE"),
];

/** Durable facts for an active run currently executing visual-review. */
export const runningRunRecords: DurableLogRecord[] = [
	...commonRecords,
	actionRecord("visual-review", "invoke", 8),
];

/** Durable prefix paused at an explicit user-input boundary. */
export const blockedRunRecords: DurableLogRecord[] = [
	...runningRunRecords,
	actionRecord("visual-review", "complete", 9, "DONE"),
	actionRecord("approval", "invoke", 10),
];

/** Complete production-shaped execution through the authored final state. */
export const completedRunRecords: DurableLogRecord[] = [
	...blockedRunRecords,
	actionRecord("approval", "complete", 11, "APPROVED"),
	actionRecord("render-report", "invoke", 12),
	actionRecord("render-report", "complete", 13, "DONE"),
];

/** The same active history followed by production-shaped fail-fast intent. */
export const failedRunRecords: DurableLogRecord[] = [
	...runningRunRecords,
	{
		type: "failure_intent",
		origin: "visual-review",
		error: "Visual validation rejected unsupported evidence.",
		parentId: 8,
		seqId: 9,
		branchId: "main", timestamp: timestamp(9),
	},
];

export const inspectRun = inspectorDialogScenario.staticRun({
	runId: "inspect:deck-director",
	cwd: "/Users/demo/Work/pi-hyperchart",
	createdAt: FIXTURE_NOW,
	updatedAt: FIXTURE_NOW,
});

export const runningRun = inspectorDialogScenario.runtimeRun(
	runningRunRecords,
	{
		runId: "deck-director-20260707-224500",
		status: {
			runId: "deck-director-20260707-224500",
			chartId: inspectorDialogAst.id,
			state: "running",
			pid: 42420,
			startedAt: STARTED_AT,
			updatedAt: timestamp(8),
		},
		cwd: "/Users/demo/Work/pi-hyperchart",
		branchWorkspace: "/Users/demo/.pi/hyperchart-runs/deck-director-20260707-224500/workspaces/main",
		createdAt: STARTED_AT,
		updatedAt: timestamp(8),
		description: "Google I/O 2026 announcement narrative deck",
	},
);

export const blockedRun = inspectorDialogScenario.runtimeRun(
	blockedRunRecords,
	{
		runId: "deck-director-approval-blocked",
		status: { runId: "deck-director-approval-blocked", chartId: inspectorDialogAst.id, state: "running", startedAt: STARTED_AT, updatedAt: timestamp(10) },
		cwd: "/Users/demo/Work/pi-hyperchart",
		createdAt: STARTED_AT,
		updatedAt: timestamp(10),
	},
);

export const completedRun = inspectorDialogScenario.runtimeRun(
	completedRunRecords,
	{
		runId: "deck-director-completed",
		status: { runId: "deck-director-completed", chartId: inspectorDialogAst.id, state: "complete", startedAt: STARTED_AT, updatedAt: timestamp(13) },
		cwd: "/Users/demo/Work/pi-hyperchart",
		createdAt: STARTED_AT,
		updatedAt: timestamp(13),
	},
);

export const failedRun = inspectorDialogScenario.runtimeRun(
	failedRunRecords,
	{
		runId: "deck-director-20260706-234626",
		status: {
			runId: "deck-director-20260706-234626",
			chartId: inspectorDialogAst.id,
			state: "failed",
			startedAt: STARTED_AT,
			updatedAt: timestamp(11),
		},
		cwd: "/Users/demo/Work/pi-hyperchart",
		createdAt: STARTED_AT,
		updatedAt: timestamp(11),
		description: "Google I/O 2026 announcement narrative deck",
	},
);

export const allRuns = [runningRun, failedRun, inspectRun];
export const allRunStripRuns = [runningRun, completedRun, blockedRun, failedRun, inspectRun];
