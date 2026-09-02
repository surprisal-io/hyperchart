import { describe, expect, it } from "vitest";
import { normalizeChartConfig } from "../packages/hyperchart/src/index.js";
import { agent, chart, failed, final } from "../packages/hyperchart/src/core/dsl.js";
import type { DurableLogRecord } from "../packages/hyperchart/src/core/durable_events.js";
import type { ActionUID, ChartAst, StateActionAst } from "../packages/hyperchart/src/core/types.js";
import { createMachine, type MachineState } from "../packages/hyperchart/src/core/machine.js";
import { createBranchProjection, projectBranch } from "../packages/hyperchart/src/core/projection.js";
import { finalMachineFailureMessage, terminalStateForFinalMachine } from "../packages/hyperchart/src/runtime/generic/run_outcome.js";

function ast(config: Parameters<typeof normalizeChartConfig>[0]): ChartAst {
	const result = normalizeChartConfig(config);
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.ast;
}

function stateFromLog(ast: ChartAst, log: readonly DurableLogRecord[]): MachineState {
	return createMachine(ast, projectBranch(createBranchProjection(ast), ast, log));
}

function definitionForUid(uid: ActionUID): StateActionAst {
	return { kind: "agent", uid, name: "test-worker" };
}

describe("run outcome", () => {
	it("classifies durable global failure intent as a failed run", () => {
		const machineAst = ast(
			chart({
				kind: "chart",
				id: "failure-route",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker"), transitions: { DONE: "done" } },
					done: final(),
					failed: failed(),
				},
			}),
		);
		const uid = { chart: "failure-route", state: "work", action: "agent" };
		const log: DurableLogRecord[] = [
			{ type: "state_action", kind: "invoke", sessionId: "session-id", actionUid: uid, definition: definitionForUid(uid), parentId: 0, seqId: 1, branchId: "main", timestamp: 1 },
			{ type: "failure_intent", origin: "work", error: "boom", parentId: 1, seqId: 2, branchId: "main", timestamp: 2 },
		];

		const state = stateFromLog(machineAst, log);
		expect(terminalStateForFinalMachine(state)).toBe("failed");
		expect(finalMachineFailureMessage(state, log)).toBe("boom");
	});

	it("ignores unrelated structured FAILED errors even for an explicitly failed terminal", () => {
		const completeAst = ast(chart({ kind: "chart", id: "complete", initial: "done", states: { done: final() } }));
		const failedAst = ast(chart({ kind: "chart", id: "failed", initial: "failed", states: { failed: failed() } }));
		const uid = { chart: "failed", state: "work", action: "agent" };
		const log: DurableLogRecord[] = [{
			type: "state_action",
			kind: "complete",
			actionUid: uid,
			event: { type: "FAILED", error: { message: "boom", code: 7 } },
			parentId: 0,
			seqId: 1,
			branchId: "main", timestamp: 1,
		}];

		expect(finalMachineFailureMessage(stateFromLog(failedAst, []), log)).toBe("chart reached failed terminal state 'failed'");
		expect(finalMachineFailureMessage(stateFromLog(completeAst, []), log)).toBeUndefined();
	});

	it("does not invent an error when a domain recovery later enters an explicit failed terminal", () => {
		const machineAst = ast(
			chart({
				kind: "chart",
				id: "stale-error-route",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker"), transitions: { NEEDS_RECOVERY: "recover" } },
					recover: { kind: "state", action: agent("fixer"), transitions: { DONE: "failed" } },
					failed: failed(),
				},
			}),
		);
		const work = { chart: "stale-error-route", state: "work", action: "agent" };
		const recover = { chart: "stale-error-route", state: "recover", action: "agent" };
		const log: DurableLogRecord[] = [
			{ type: "state_action", kind: "invoke", sessionId: "session-id", actionUid: work, definition: definitionForUid(work), parentId: 0, seqId: 1, branchId: "main", timestamp: 1 },
			{ type: "state_action", kind: "complete", actionUid: work, event: { type: "NEEDS_RECOVERY" }, parentId: 1, seqId: 2, branchId: "main", timestamp: 2 },
			{ type: "state_action", kind: "invoke", sessionId: "session-id", actionUid: recover, definition: definitionForUid(recover), parentId: 2, seqId: 3, branchId: "main", timestamp: 3 },
			{ type: "state_action", kind: "complete", actionUid: recover, event: { type: "DONE" }, parentId: 3, seqId: 4, branchId: "main", timestamp: 4 },
		];

		expect(finalMachineFailureMessage(stateFromLog(machineAst, log), log)).toBe("chart reached failed terminal state 'failed'");
	});

	it("keeps recovered workflows complete when a later success reaches done", () => {
		const machineAst = ast(
			chart({
				kind: "chart",
				id: "recovered-route",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker"), transitions: { DONE: "done", NEEDS_RECOVERY: "recover" } },
					recover: { kind: "state", action: agent("fixer"), transitions: { DONE: "done", GIVE_UP: "failed" } },
					done: final(),
					failed: failed(),
				},
			}),
		);
		const work = { chart: "recovered-route", state: "work", action: "agent" };
		const recover = { chart: "recovered-route", state: "recover", action: "agent" };
		const log: DurableLogRecord[] = [
			{ type: "state_action", kind: "invoke", sessionId: "session-id", actionUid: work, definition: definitionForUid(work), parentId: 0, seqId: 1, branchId: "main", timestamp: 1 },
			{
				type: "state_action",
				kind: "complete",
				actionUid: work,
				event: { type: "NEEDS_RECOVERY" },
				parentId: 1,
				seqId: 2,
				branchId: "main", timestamp: 2,
			},
			{ type: "state_action", kind: "invoke", sessionId: "session-id", actionUid: recover, definition: definitionForUid(recover), parentId: 2, seqId: 3, branchId: "main", timestamp: 3 },
			{
				type: "state_action",
				kind: "complete",
				actionUid: recover,
				event: { type: "DONE" },
				parentId: 3,
				seqId: 4,
				branchId: "main", timestamp: 4,
			},
		];

		expect(terminalStateForFinalMachine(stateFromLog(machineAst, log))).toBe("complete");
	});
});
