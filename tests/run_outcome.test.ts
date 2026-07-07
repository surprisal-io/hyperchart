import { describe, expect, it } from "vitest";
import { normalizeChartConfig } from "../src/index.js";
import { agent, chart, final } from "../src/core/dsl.js";
import type { DurableLogRecord } from "../src/core/durable_events.js";
import type { ActionUID, ChartAst, StateActionAst } from "../src/core/types.js";
import { createMachine, type MachineState } from "../src/core/machine.js";
import { createBranchProjection, projectBranch } from "../src/core/projection.js";
import { terminalStateForFinalMachine } from "../src/runtime/generic/run_outcome.js";

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
	it("classifies a terminal FAILED completion as a failed run", () => {
		const machineAst = ast(
			chart({
				kind: "chart",
				id: "failure-route",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker"), transitions: { DONE: "done", FAILED: "failed" } },
					done: final(),
					failed: final(),
				},
			}),
		);
		const uid = { chart: "failure-route", state: "work", action: "agent" };
		const log: DurableLogRecord[] = [
			{ type: "state_action", kind: "invoke", actionUid: uid, definition: definitionForUid(uid), parentId: 0, seqId: 1, timestamp: 1 },
			{
				type: "state_action",
				kind: "complete",
				actionUid: uid,
				event: { type: "FAILED", error: "boom" },
				parentId: 1,
				seqId: 2,
				timestamp: 2,
			},
		];

		expect(terminalStateForFinalMachine(stateFromLog(machineAst, log), log)).toBe("failed");
	});

	it("keeps recovered workflows complete when a later success reaches done", () => {
		const machineAst = ast(
			chart({
				kind: "chart",
				id: "recovered-route",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker"), transitions: { DONE: "done", FAILED: "recover" } },
					recover: { kind: "state", action: agent("fixer"), transitions: { DONE: "done", FAILED: "failed" } },
					done: final(),
					failed: final(),
				},
			}),
		);
		const work = { chart: "recovered-route", state: "work", action: "agent" };
		const recover = { chart: "recovered-route", state: "recover", action: "agent" };
		const log: DurableLogRecord[] = [
			{ type: "state_action", kind: "invoke", actionUid: work, definition: definitionForUid(work), parentId: 0, seqId: 1, timestamp: 1 },
			{
				type: "state_action",
				kind: "complete",
				actionUid: work,
				event: { type: "FAILED", error: "boom" },
				parentId: 1,
				seqId: 2,
				timestamp: 2,
			},
			{ type: "state_action", kind: "invoke", actionUid: recover, definition: definitionForUid(recover), parentId: 2, seqId: 3, timestamp: 3 },
			{
				type: "state_action",
				kind: "complete",
				actionUid: recover,
				event: { type: "DONE" },
				parentId: 3,
				seqId: 4,
				timestamp: 4,
			},
		];

		expect(terminalStateForFinalMachine(stateFromLog(machineAst, log), log)).toBe("complete");
	});
});
