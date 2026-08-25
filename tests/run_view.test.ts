import { describe, expect, it } from "vitest";
import { normalizeChartConfig } from "../packages/hyperchart/src/index.js";
import { agent, arg, chart, final, failed, map, tsImport } from "../packages/hyperchart/src/core/dsl.js";
import type { ActionUID, ChartAst, ChartCst, DurableLogRecord, StateActionAst } from "../packages/hyperchart/src/index.js";
import { buildRunView } from "../packages/pi-hyperchart/src/tui/run_view.js";

function make(config: ChartCst): ChartAst {
	const result = normalizeChartConfig(config);
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.ast;
}

function linearChart(validate = false): ChartAst {
	return make(
		chart({
			kind: "chart",
			id: "view-linear",
			initial: "work",
			states: {
				work: {
					kind: "state",
					action: agent("worker"),
					...(validate ? { validate: tsImport("./check.js", "ok"), retries: 2 } : {}),
					transitions: { DONE: "done", ERROR: "failed" },
				},
				done: final(),
				failed: failed(),
			},
		}),
	);
}

function fanoutChart(): ChartAst {
	return make(
		chart({
			kind: "chart",
			id: "view-map",
			initial: "fanout",
			states: {
				fanout: map({
					over: arg("items"),
					initial: "work",
					onDone: "done",
					states: {
						work: { kind: "state", action: agent("worker"), transitions: { OK: "done" } },
						done: final(),
					},
				}),
				done: final(),
			},
		}),
	);
}

function invoke(seqId: number, actionUid: ActionUID, timestamp = seqId * 100): DurableLogRecord {
	return { type: "state_action", kind: "invoke", sessionId: "session-id", actionUid, definition: definitionForUid(actionUid), parentId: seqId - 1, seqId, branchId: "main", timestamp };
}

function definitionForUid(uid: ActionUID): StateActionAst {
	return { kind: "agent", uid, name: "test-worker" };
}

describe("buildRunView", () => {
	it("shows active rows, pending work and tail", () => {
		const uid = { chart: "view-linear", state: "work", action: "agent" };
		const log: DurableLogRecord[] = [
			{ type: "args", args: { topic: "demo" }, parentId: null, seqId: 1, branchId: "main", timestamp: 100 },
			invoke(2, uid, 200),
		];

		const view = buildRunView(linearChart(), log, 1200);

		expect(view.chartId).toBe("view-linear");
		expect(view.final).toBe(false);
		expect(view.args).toEqual({ topic: "demo" });
		expect(view.pending).toEqual([{ path: "work", phase: "running", sinceMs: 1000 }]);
		expect(view.rows.find((row) => row.label === "work")?.status).toBe("active");
		expect(view.graph.find((row) => row.path === "work")).toMatchObject({
			status: "running",
			action: "agent:worker",
			sinceMs: 1000,
		});
		expect(view.tail.at(-1)?.text).toBe("invoke work");
	});

	it("shows rejected validation reason", () => {
		const uid = { chart: "view-linear", state: "work", action: "agent" };
		const log: DurableLogRecord[] = [
			invoke(1, uid, 100),
			{
				type: "state_action",
				kind: "complete",
				actionUid: uid,
				event: { type: "DONE" },
				parentId: 1,
				seqId: 2,
				branchId: "main", timestamp: 200,
			},
			{
				type: "state_action",
				kind: "validated",
				actionUid: uid,
				event: { type: "DONE" },
				guard: tsImport("./check.js", "ok"),
				outcome: { ok: false, reason: "try again" },
				parentId: 2,
				seqId: 3,
				branchId: "main", timestamp: 300,
			},
		];

		const view = buildRunView(linearChart(true), log, 1000);

		expect(view.pending).toEqual([{ path: "work", phase: "rejected", rejections: 1, reason: "try again" }]);
		expect(view.graph.find((row) => row.path === "work")).toMatchObject({
			status: "rejected",
			rejections: 1,
			reason: "try again",
			event: "DONE",
		});
	});

	it("expands spawned map instances", () => {
		const uid = { chart: "view-map", state: "fanout#a.work", action: "agent" };
		const log: DurableLogRecord[] = [
			{ type: "args", args: { items: { a: 1, b: 2 } }, parentId: null, seqId: 1, branchId: "main", timestamp: 100 },
			{ type: "spawned", path: "fanout", instances: { a: 1, b: 2 }, parentId: 1, seqId: 2, branchId: "main", timestamp: 200 },
			invoke(3, uid, 300),
		];

		const view = buildRunView(fanoutChart(), log, 500);

		expect(view.rows.some((row) => row.label === "#a" && row.status === "active" && row.instanceOf === "fanout")).toBe(
			true,
		);
		expect(view.rows.some((row) => row.label === "#b" && row.status === "active" && row.instanceOf === "fanout")).toBe(
			true,
		);
	});
});
