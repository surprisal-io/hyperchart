import { describe, expect, it } from "vitest";
import { normalizeChartConfig } from "../packages/hyperchart/src/index.js";
import { agent, arg, chart, final, failed, map, tsAction, tsImport } from "../packages/hyperchart/src/core/dsl.js";
import type {
	ActionUID,
	ChartAst,
	ChartCst,
	DurableLogRecord,
	StateActionAst,
} from "../packages/hyperchart/src/index.js";
import { buildRunView } from "../packages/pi-hyperchart/src/tui/run_view.js";

function make(config: ChartCst): ChartAst {
	const result = normalizeChartConfig(config);
	if (!result.ok) {
		throw new Error(JSON.stringify(result.diagnostics));
	}
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
					action: agent(
						"worker",
						validate ? { validation: { guard: tsImport("./check.js", "ok"), onFail: { nudge: 2, restart: 0 } } } : {},
					),
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
	return {
		type: "state_action",
		kind: "invoke",
		sessionId: "session-id",
		actionUid,
		definition: definitionForUid(actionUid),
		parentId: seqId - 1,
		seqId,
		branchId: "main",
		timestamp,
	};
}

function definitionForUid(uid: ActionUID): StateActionAst {
	return { kind: "agent", uid, name: "test-worker", onFail: { nudge: 2, restart: 1 } };
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

	it("preserves imported function action identity in the TUI graph", () => {
		const ast = make(
			chart({
				kind: "chart",
				id: "view-function",
				initial: "score",
				states: {
					score: { kind: "state", action: tsAction("./score.mjs", "score"), transitions: { DONE: "done" } },
					done: final(),
				},
			}),
		);
		const state = ast.states.score;
		if (state?.kind !== "state") {
			throw new Error("expected score state");
		}
		const log: DurableLogRecord[] = [
			{
				type: "state_action",
				kind: "invoke",
				sessionId: "function-session",
				actionUid: state.action.uid,
				definition: state.action,
				parentId: null,
				seqId: 1,
				branchId: "main",
				timestamp: 100,
			},
		];

		const view = buildRunView(ast, log, 200);
		expect(view.graph.find((row) => row.path === "score")).toMatchObject({
			status: "running",
			action: "tsAction:./score.mjs#score",
		});
	});

	it("shows durable validation recovery reason", () => {
		const uid = { chart: "view-linear", state: "work", action: "agent" };
		const guard = { kind: "tsImport", module: "./check.js", export: "ok" } as const;
		const baseDefinition = definitionForUid(uid);
		if (baseDefinition.kind !== "agent") {
			throw new Error("expected agent");
		}
		const definition: StateActionAst = { ...baseDefinition, validation: { guard, onFail: { nudge: 2, restart: 1 } } };
		const log: DurableLogRecord[] = [
			{
				type: "state_action",
				kind: "invoke",
				sessionId: "session-id",
				actionUid: uid,
				definition,
				parentId: null,
				seqId: 1,
				branchId: "main",
				timestamp: 100,
			},
			{
				type: "state_action",
				kind: "complete",
				actionUid: uid,
				event: { type: "DONE" },
				parentId: 1,
				seqId: 2,
				branchId: "main",
				timestamp: 200,
			},
			{
				type: "state_action",
				kind: "validated",
				actionUid: uid,
				event: { type: "DONE" },
				guard,
				outcome: { ok: false, reason: "try again" },
				parentId: 2,
				seqId: 3,
				branchId: "main",
				timestamp: 300,
			},
			{
				type: "state_action",
				kind: "retry",
				actionUid: uid,
				failure: { kind: "validation", message: "try again" },
				scope: "validation",
				mode: "nudge",
				previousSessionId: "session-id",
				resultingSessionId: "session-id",
				nudgeAttempt: 1,
				restartAttempt: 0,
				parentId: 3,
				seqId: 4,
				branchId: "main",
				timestamp: 400,
			},
		];

		const view = buildRunView(linearChart(true), log, 1000);

		expect(view.pending).toEqual([
			{ path: "work", phase: "running", sinceMs: 900, rejections: 1, reason: "try again" },
		]);
		expect(view.graph.find((row) => row.path === "work")).toMatchObject({
			status: "running",
			rejections: 1,
			reason: "try again",
			event: "DONE",
		});
	});

	it("expands spawned map instances", () => {
		const uid = { chart: "view-map", state: "fanout#a.work", action: "agent" };
		const log: DurableLogRecord[] = [
			{ type: "args", args: { items: { a: 1, b: 2 } }, parentId: null, seqId: 1, branchId: "main", timestamp: 100 },
			{
				type: "spawned",
				path: "fanout",
				instances: { a: 1, b: 2 },
				parentId: 1,
				seqId: 2,
				branchId: "main",
				timestamp: 200,
			},
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
