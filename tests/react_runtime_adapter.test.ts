import { describe, expect, it } from "vitest";
import { agent, arg, chart, compound, final, map, parallel, tsImport } from "../src/core/dsl.js";
import { actionUidKey } from "../src/core/action_uid.js";
import { normalizeChartConfig } from "../src/core/normalize.js";
import { templatePath } from "../src/core/paths.js";
import type { ChartAst, ChartCst, StatePath } from "../src/core/types.js";
import type { DurableLogRecord } from "../src/core/durable_events.js";
import { hyperchartRunFromInspectResult, hyperchartRunFromRuntime, hyperchartRunFromToolDetails } from "../src/host/adapters.js";
import { inspectChartAst } from "../src/core/inspect.js";

function ast(cst: ChartCst): ChartAst {
	const parsed = normalizeChartConfig(cst, { path: "test.chart.ts" });
	expect(parsed.ok).toBe(true);
	if (!parsed.ok) throw new Error("invalid chart");
	return parsed.ast;
}

function actionUid(chartAst: ChartAst, statePath: StatePath) {
	const state = chartAst.states[templatePath(statePath)];
	if (state?.kind !== "state") throw new Error(`not an action state: ${statePath}`);
	return { ...state.action.uid, state: statePath };
}

function baseRecord(seqId: number, timestamp = seqId * 1000) {
	return { seqId, parentId: seqId === 1 ? null : seqId - 1, timestamp };
}

describe("React runtime adapter", () => {
	it("keeps static inspect mode static", () => {
		const chartAst = ast(chart({ kind: "chart", id: "static", initial: "work", states: { work: { kind: "state", action: agent("worker"), transitions: { DONE: "done" } }, done: final() } }));
		const run = hyperchartRunFromInspectResult(inspectChartAst(chartAst));
		expect(run.mode).toBe("static");
		expect(run.definitionSource).toContain("chart(");
		expect(run.states.find((state) => state.id === "work")?.definitionSource).toContain("work:");
		expect(run.states.find((state) => state.id === "work")?.status).toBe("pending");
		expect(run.states.find((state) => state.id === "work")?.validationAttempts).toBeUndefined();
		expect(run.issues).toBeUndefined();
		expect(run.states.find((state) => state.id === "work")?.issues).toBeUndefined();
	});

	it("unwraps runtime inspector models from tool details", () => {
		const chartAst = ast(chart({ kind: "chart", id: "tool-details", initial: "work", states: { work: { kind: "state", action: agent("worker"), transitions: { DONE: "done" } }, done: final() } }));
		const inspector = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, [{ type: "args", args: {}, ...baseRecord(1) }]);
		expect(hyperchartRunFromToolDetails({ inspector })).toBe(inspector);
		expect(hyperchartRunFromToolDetails(inspector)).toBe(inspector);
	});

	it("maps completed action runtime data and taken transition", () => {
		const chartAst = ast(chart({ kind: "chart", id: "simple", initial: "work", states: { work: { kind: "state", action: agent("worker"), transitions: { DONE: "done", FAILED: "failed" } }, done: final(), failed: final() } }));
		const records: DurableLogRecord[] = [
			{ type: "args", args: { topic: "runtime" }, ...baseRecord(1) },
			{ type: "state_action", kind: "invoke", actionUid: actionUid(chartAst, "work"), definition: (chartAst.states.work as Extract<ChartAst["states"][string], { kind: "state" }>).action, ...baseRecord(2) },
			{ type: "state_action", kind: "complete", actionUid: actionUid(chartAst, "work"), event: { type: "DONE", output: { ok: true } }, ...baseRecord(3) },
		];
		const run = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records, { status: { runId: "run", state: "complete", pid: 123, startedAt: 1000, updatedAt: 3000 }, cwd: "/tmp/project" });
		const work = run.states.find((state) => state.id === "work");
		expect(run.mode).toBe("run");
		expect(run.args).toEqual({ topic: "runtime" });
		expect(run.pid).toBe(123);
		expect(run.cwd).toBe("/tmp/project");
		expect(work).toMatchObject({ status: "done", startedAt: 2000, endedAt: 3000, completedEvent: "DONE", attempts: 1 });
		expect(work?.transitions?.find((transition) => transition.event === "DONE")?.taken).toBe(true);
	});

	it("maps run-level status errors and replay warnings", () => {
		const chartAst = ast(chart({ kind: "chart", id: "run-issues", initial: "work", states: { work: { kind: "state", action: agent("worker"), transitions: { DONE: "done" } }, done: final() } }));
		const run = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, [{ type: "args", args: {}, ...baseRecord(1) }], {
			status: { runId: "run", state: "failed", error: "runner crashed", exitCode: 1, replayWarnings: ["Replay warning: stale provenance"], updatedAt: 3000 },
		});
		expect(run.issues).toMatchObject([
			{ severity: "error", kind: "run_failed", source: "status", message: "runner crashed", payload: { exitCode: 1 }, timestamp: 3000 },
			{ severity: "warning", kind: "replay_warning", source: "status", message: "Replay warning: stale provenance", timestamp: 3000 },
		]);
	});

	it("maps failed action runtime data and taken failure transition", () => {
		const chartAst = ast(chart({ kind: "chart", id: "failed-action", initial: "work", states: { work: { kind: "state", action: agent("worker"), transitions: { DONE: "done", FAILED: "failed" } }, done: final(), failed: final() } }));
		const uid = actionUid(chartAst, "work");
		const records: DurableLogRecord[] = [
			{ type: "args", args: {}, ...baseRecord(1) },
			{ type: "state_action", kind: "invoke", actionUid: uid, definition: (chartAst.states.work as Extract<ChartAst["states"][string], { kind: "state" }>).action, ...baseRecord(2) },
			{ type: "state_action", kind: "complete", actionUid: uid, event: { type: "FAILED", error: "boom" }, ...baseRecord(3) },
		];
		const work = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records).states.find((state) => state.id === "work");
		expect(work).toMatchObject({ status: "failed", completedEvent: "FAILED", attempts: 1, endedAt: 3000 });
		expect(work?.issues).toMatchObject([{ severity: "error", kind: "action_failed", source: "durable_log", message: "boom", stateId: "work", seqId: 3, timestamp: 3000, payload: "boom" }]);
		expect(work?.transitions?.find((transition) => transition.event === "FAILED")?.taken).toBe(true);
	});

	it("keeps structured failed action payloads readable and inspectable", () => {
		const chartAst = ast(chart({ kind: "chart", id: "structured-failure", initial: "work", states: { work: { kind: "state", action: agent("worker"), transitions: { FAILED: "failed" } }, failed: final() } }));
		const uid = actionUid(chartAst, "work");
		const payload = { code: 2, signal: null, stderr: "first line\nlast line" };
		const records: DurableLogRecord[] = [
			{ type: "args", args: {}, ...baseRecord(1) },
			{ type: "state_action", kind: "invoke", actionUid: uid, definition: (chartAst.states.work as Extract<ChartAst["states"][string], { kind: "state" }>).action, ...baseRecord(2) },
			{ type: "state_action", kind: "complete", actionUid: uid, event: { type: "FAILED", error: payload }, ...baseRecord(3) },
		];
		const work = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records).states.find((state) => state.id === "work");
		expect(work?.issues?.[0]).toMatchObject({ severity: "error", kind: "action_failed", message: "Script exited with code 2: last line", payload });
	});

	it("maps validation attempts from durable validation records", () => {
		const chartAst = ast(chart({ kind: "chart", id: "validated", initial: "work", states: { work: { kind: "state", action: agent("worker"), validate: tsImport("./check.js", "ok"), retries: 2, transitions: { DONE: "done", FAILED: "failed" } }, done: final(), failed: final() } }));
		const uid = actionUid(chartAst, "work");
		const records: DurableLogRecord[] = [
			{ type: "args", args: {}, ...baseRecord(1) },
			{ type: "state_action", kind: "invoke", actionUid: uid, definition: (chartAst.states.work as Extract<ChartAst["states"][string], { kind: "state" }>).action, ...baseRecord(2) },
			{ type: "state_action", kind: "complete", actionUid: uid, event: { type: "DONE" }, ...baseRecord(3) },
			{ type: "state_action", kind: "validated", actionUid: uid, event: { type: "DONE" }, guard: tsImport("./check.js", "ok"), outcome: { ok: false, reason: "no" }, ...baseRecord(4) },
		];
		const work = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records).states.find((state) => state.id === "work");
		expect(work?.guard).toEqual({ kind: "tsImport", module: "./check.js", export: "ok" });
		expect(work?.retry).toEqual({ max: 2 });
		expect(work?.validationAttempts).toBe(1);
		expect(work?.validation?.latestRejectedReason).toBe("no");
		expect(work?.issues).toMatchObject([{ severity: "warning", kind: "validation_rejected", message: "no", source: "durable_log", stateId: "work", seqId: 4, timestamp: 4000, payload: { ok: false, reason: "no" } }]);
		expect(work?.status).toBe("running");
		expect(work?.endedAt).toBeUndefined();
		expect(work?.completedEvent).toBeUndefined();
		expect(work?.transitions?.find((transition) => transition.event === "DONE")?.taken).toBeUndefined();

		const acceptedRecords: DurableLogRecord[] = [
			...records,
			{ type: "state_action", kind: "complete", actionUid: uid, event: { type: "DONE" }, ...baseRecord(5) },
			{ type: "state_action", kind: "validated", actionUid: uid, event: { type: "DONE" }, guard: tsImport("./check.js", "ok"), outcome: true, ...baseRecord(6) },
		];
		const accepted = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, acceptedRecords).states.find((state) => state.id === "work");
		expect(accepted).toMatchObject({ status: "done", endedAt: 6000, completedEvent: "DONE" });
		expect(accepted?.transitions?.find((transition) => transition.event === "DONE")?.taken).toBe(true);
	});

	it("shows retry-exhausted validation rejection as a failed transition", () => {
		const chartAst = ast(chart({ kind: "chart", id: "rejected-terminal", initial: "work", states: { work: { kind: "state", action: agent("worker"), validate: tsImport("./check.js", "ok"), retries: 0, transitions: { DONE: "done", FAILED: "failed" } }, done: final(), failed: final() } }));
		const uid = actionUid(chartAst, "work");
		const records: DurableLogRecord[] = [
			{ type: "args", args: {}, ...baseRecord(1) },
			{ type: "state_action", kind: "invoke", actionUid: uid, definition: (chartAst.states.work as Extract<ChartAst["states"][string], { kind: "state" }>).action, ...baseRecord(2) },
			{ type: "state_action", kind: "complete", actionUid: uid, event: { type: "DONE" }, ...baseRecord(3) },
			{ type: "state_action", kind: "validated", actionUid: uid, event: { type: "DONE" }, guard: tsImport("./check.js", "ok"), outcome: { ok: false, reason: "no" }, ...baseRecord(4) },
		];
		const work = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records).states.find((state) => state.id === "work");
		expect(work).toMatchObject({ status: "failed", endedAt: 4000, completedEvent: "FAILED" });
		expect(work?.transitions?.find((transition) => transition.event === "FAILED")?.taken).toBe(true);
		expect(work?.transitions?.find((transition) => transition.event === "DONE")?.taken).toBeUndefined();
	});

	it("maps spawned map instances, item values, item progress, and materialized workers", () => {
		const chartAst = ast(chart({ kind: "chart", id: "mapped", initial: "items", states: { items: map({ over: arg("items"), initial: "work", onDone: "done", states: { work: { kind: "state", action: agent("worker"), transitions: { DONE: "done", FAILED: "failed" } }, done: final(), failed: final() } }), done: final() } }));
		const uidA = actionUid(chartAst, "items#a.work");
		const uidB = actionUid(chartAst, "items#b.work");
		const uidC = actionUid(chartAst, "items#c.work");
		const instances = { a: { title: "Alpha", summary: "first" }, b: { title: "Beta" }, c: { title: "Gamma" } };
		const records: DurableLogRecord[] = [
			{ type: "args", args: { items: instances }, ...baseRecord(1) },
			{ type: "spawned", path: "items", instances, ...baseRecord(2) },
			{ type: "state_action", kind: "invoke", actionUid: uidA, definition: (chartAst.states["items.work"] as Extract<ChartAst["states"][string], { kind: "state" }>).action, ...baseRecord(3) },
			{ type: "state_action", kind: "complete", actionUid: uidA, event: { type: "DONE" }, ...baseRecord(4) },
			{ type: "state_action", kind: "invoke", actionUid: uidB, definition: (chartAst.states["items.work"] as Extract<ChartAst["states"][string], { kind: "state" }>).action, ...baseRecord(5) },
			{ type: "state_action", kind: "invoke", actionUid: uidC, definition: (chartAst.states["items.work"] as Extract<ChartAst["states"][string], { kind: "state" }>).action, ...baseRecord(6) },
			{ type: "state_action", kind: "complete", actionUid: uidC, event: { type: "FAILED", error: "bad item" }, ...baseRecord(7) },
		];
		const run = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records);
		const mapState = run.states.find((state) => state.id === "items");
		expect(mapState?.mapConfig?.items).toMatchObject([
			{ key: "a", label: "Alpha", summary: "first", status: "done", value: { title: "Alpha", summary: "first" } },
			{ key: "b", label: "Beta", status: "running", value: { title: "Beta" } },
			{ key: "c", label: "Gamma", status: "failed", value: { title: "Gamma" } },
		]);
		expect(mapState?.subProgress).toEqual({ done: 1, running: 1, failed: 1, total: 3 });
		const itemBWorker = run.states.find((state) => state.id === "items#b.work");
		const itemCWorker = run.states.find((state) => state.id === "items#c.work");
		expect(itemBWorker).toMatchObject({ status: "running", mapKey: "b", mapItemLabel: "Beta" });
		expect(itemBWorker?.transitions?.find((transition) => transition.event === "DONE")?.target).toBe("items#b.done");
		expect(itemCWorker).toMatchObject({ status: "failed", mapKey: "c", mapItemLabel: "Gamma" });
		expect(itemCWorker?.transitions?.find((transition) => transition.event === "FAILED")?.target).toBe("items#c.failed");
		expect(itemCWorker?.issues?.[0]).toMatchObject({ kind: "action_failed", message: "bad item" });
		expect(mapState?.mapConfig?.items?.find((item) => item.key === "c")?.issueCount).toBe(1);
	});

	it("materializes nested map workers from concrete spawn paths", () => {
		const chartAst = ast(chart({
			kind: "chart",
			id: "nested-map",
			initial: "outer",
			states: {
				outer: map({
					over: arg("outer"),
					initial: "inner",
					onDone: "done",
					states: {
						inner: map({
							over: arg("inner"),
							initial: "work",
							onDone: "done",
							states: {
								work: { kind: "state", action: agent("nested-worker"), transitions: { DONE: "done" } },
								done: final(),
							},
						}),
						done: final(),
					},
				}),
				done: final(),
			},
		}));
		const nestedUid = actionUid(chartAst, "outer#a.inner#x.work");
		const records: DurableLogRecord[] = [
			{ type: "args", args: { outer: { a: {} }, inner: { x: { title: "Nested" } } }, ...baseRecord(1) },
			{ type: "spawned", path: "outer", instances: { a: {} }, ...baseRecord(2) },
			{ type: "spawned", path: "outer#a.inner", instances: { x: { title: "Nested" } }, ...baseRecord(3) },
			{ type: "state_action", kind: "invoke", actionUid: nestedUid, definition: (chartAst.states["outer.inner.work"] as Extract<ChartAst["states"][string], { kind: "state" }>).action, ...baseRecord(4) },
		];

		const run = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records);
		const worker = run.states.find((state) => state.id === "outer#a.inner#x.work");
		expect(run.states.find((state) => state.id === "outer#a.inner")).toMatchObject({ type: "map" });
		expect(run.states.some((state) => state.id === "outer#a.inner.work")).toBe(false);
		expect(worker).toMatchObject({ status: "running", mapKey: "x", mapItemLabel: "Nested" });
		expect(worker?.transitions?.find((transition) => transition.event === "DONE")?.target).toBe("outer#a.inner#x.done");
	});

	it("rebases parallel branch scopes inside materialized map instances", () => {
		const chartAst = ast(chart({
			kind: "chart",
			id: "mapped-parallel",
			initial: "items",
			states: {
				items: map({
					over: arg("items"),
					initial: "fan",
					onDone: "done",
					states: {
						fan: parallel({
							states: {
								left: compound({ initial: "work", states: { work: { kind: "state", action: agent("left"), transitions: { DONE: "done" } }, done: final() } }),
								right: compound({ initial: "work", states: { work: { kind: "state", action: agent("right"), transitions: { DONE: "done" } }, done: final() } }),
							},
							onDone: "done",
						}),
						done: final(),
					},
				}),
				done: final(),
			},
		}));
		const leftUid = actionUid(chartAst, "items#a.fan.left.work");
		const rightUid = actionUid(chartAst, "items#a.fan.right.work");
		const records: DurableLogRecord[] = [
			{ type: "args", args: { items: { a: {} } }, ...baseRecord(1) },
			{ type: "spawned", path: "items", instances: { a: {} }, ...baseRecord(2) },
			{ type: "state_action", kind: "invoke", actionUid: leftUid, definition: (chartAst.states["items.fan.left.work"] as Extract<ChartAst["states"][string], { kind: "state" }>).action, ...baseRecord(3) },
			{ type: "state_action", kind: "complete", actionUid: leftUid, event: { type: "DONE" }, ...baseRecord(4) },
			{ type: "state_action", kind: "invoke", actionUid: rightUid, definition: (chartAst.states["items.fan.right.work"] as Extract<ChartAst["states"][string], { kind: "state" }>).action, ...baseRecord(5) },
		];
		const fan = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records, {
			sessionProgress: { sessions: { [actionUidKey(rightUid)]: { actionUid: rightUid, status: "failed", error: "right failed" } } },
		}).states.find((state) => state.id === "items#a.fan");
		expect(fan?.parallelConfig?.branches).toMatchObject([
			{ id: "items#a.fan.left" },
			{ id: "items#a.fan.right", issueCount: 1 },
		]);
		expect(fan?.subProgress).toEqual({ done: 1, running: 1, failed: 0, total: 2 });
	});

	it("maps parallel branch progress and static branch previews", () => {
		const chartAst = ast(chart({ kind: "chart", id: "parallel-run", initial: "fan", states: { fan: parallel({ states: { left: compound({ initial: "work", states: { work: { kind: "state", action: agent("left-agent", { task: "Left task" }), transitions: { DONE: "done" } }, done: final() } }), right: compound({ initial: "work", states: { work: { kind: "state", action: agent("right-agent", { task: "Right task" }), transitions: { DONE: "done" } }, done: final() } }) }, onDone: "done" }), done: final() } }));
		const leftUid = actionUid(chartAst, "fan.left.work");
		const rightUid = actionUid(chartAst, "fan.right.work");
		const records: DurableLogRecord[] = [
			{ type: "args", args: {}, ...baseRecord(1) },
			{ type: "state_action", kind: "invoke", actionUid: leftUid, definition: (chartAst.states["fan.left.work"] as Extract<ChartAst["states"][string], { kind: "state" }>).action, ...baseRecord(2) },
			{ type: "state_action", kind: "complete", actionUid: leftUid, event: { type: "DONE" }, ...baseRecord(3) },
			{ type: "state_action", kind: "invoke", actionUid: rightUid, definition: (chartAst.states["fan.right.work"] as Extract<ChartAst["states"][string], { kind: "state" }>).action, ...baseRecord(4) },
		];
		const fan = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records, {
			sessionProgress: { sessions: { [actionUidKey(rightUid)]: { actionUid: rightUid, actionName: "right-agent", status: "failed", error: "right branch session failed", lastActivityAt: 5000 } } },
		}).states.find((state) => state.id === "fan");
		expect(fan?.parallelConfig?.branches).toMatchObject([
			{ id: "fan.left", agent: "left-agent", taskPreview: "Left task" },
			{ id: "fan.right", agent: "right-agent", taskPreview: "Right task", issueCount: 1 },
		]);
		expect(fan?.subProgress).toEqual({ done: 1, running: 1, failed: 0, total: 2 });
	});

	it("maps failed session progress to the matching state only in run mode", () => {
		const chartAst = ast(chart({ kind: "chart", id: "session-failure", initial: "work", states: { work: { kind: "state", action: agent("worker"), transitions: { DONE: "done", FAILED: "failed" } }, done: final(), failed: final() } }));
		const uid = actionUid(chartAst, "work");
		const run = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, [{ type: "args", args: {}, ...baseRecord(1) }], {
			sessionProgress: {
				sessions: {
					[actionUidKey(uid)]: { actionUid: uid, actionName: "worker", status: "failed", error: "session crashed", startedAt: 1000, lastActivityAt: 2500, turnCount: 3, toolCount: 4 },
				},
			},
		});
		const work = run.states.find((state) => state.id === "work");
		expect(work?.issues).toMatchObject([{ severity: "error", kind: "session_failed", source: "session_progress", message: "session crashed", stateId: "work", timestamp: 2500 }]);
	});
});
