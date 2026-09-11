import { expect, it } from "vitest";
import { agent, chart, final, normalizeChartConfig, tsImport } from "../packages/hyperchart/src/index.js";
import type { ChartAst, DurableLogRecord } from "../packages/hyperchart/src/index.js";
import { createBranchProjection, projectBranch } from "../packages/hyperchart/src/core/projection.js";
import { explainReplay } from "../packages/hyperchart/src/core/replay_check.js";

function ast(validated: boolean): ChartAst {
	const parsed = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "validation-provenance",
			initial: "work",
			states: {
				work: {
					kind: "state",
					action: agent("worker", validated ? { validation: { guard: tsImport("./checks.js", "ok") } } : {}),
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		}),
	);
	if (!parsed.ok) {
		throw new Error(JSON.stringify(parsed.diagnostics));
	}
	return parsed.ast;
}

it("pins agent validation and recovery policy in the invoke definition", () => {
	const original = ast(true);
	const current = ast(false);
	const state = original.states.work;
	if (state?.kind !== "state" || state.action.kind !== "agent" || state.action.validation === undefined) {
		throw new Error("expected validated agent");
	}
	const uid = state.action.uid;
	const records: DurableLogRecord[] = [
		{ type: "args", args: {}, parentId: null, seqId: 1, branchId: "main", timestamp: 1 },
		{
			type: "state_action",
			kind: "invoke",
			actionUid: uid,
			sessionId: "session",
			definition: state.action,
			parentId: 1,
			seqId: 2,
			branchId: "main",
			timestamp: 2,
		},
		{
			type: "state_action",
			kind: "complete",
			actionUid: uid,
			event: { type: "DONE" },
			parentId: 2,
			seqId: 3,
			branchId: "main",
			timestamp: 3,
		},
		{
			type: "state_action",
			kind: "validated",
			actionUid: uid,
			event: { type: "DONE" },
			guard: state.action.validation.guard,
			outcome: true,
			parentId: 3,
			seqId: 4,
			branchId: "main",
			timestamp: 4,
		},
	];
	const projected = projectBranch(createBranchProjection(original), original, records);
	expect(projected.activeLeaves).toEqual(["done"]);
	expect(state.action.onFail).toEqual({ nudge: 2, restart: 1 });
	expect(explainReplay(current, records).stale).toEqual(
		expect.arrayContaining([expect.objectContaining({ reason: "guard_removed" })]),
	);
});
