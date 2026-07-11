import { describe, expect, it } from "vitest";
import { agent, arg, chart, compound, event, final, input, map, parallel, t, tsImport } from "../src/core/dsl.js";
import { z } from "zod";
import { actionUidKey } from "../src/core/action_uid.js";
import { normalizeChartConfig } from "../src/core/normalize.js";
import { templatePath } from "../src/core/paths.js";
import type { ChartAst, ChartCst, StatePath } from "../src/core/types.js";
import type { DurableLogRecord } from "../src/core/durable_events.js";
import {
	hyperchartRunFromInspectResult,
	hyperchartRunFromRuntime,
	hyperchartRunFromToolDetails,
} from "../src/host/adapters.js";
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
		const chartAst = ast(
			chart({
				kind: "chart",
				id: "static",
				initial: "work",
				states: { work: { kind: "state", action: agent("worker"), transitions: { DONE: "done" } }, done: final() },
			}),
		);
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
		const chartAst = ast(
			chart({
				kind: "chart",
				id: "tool-details",
				initial: "work",
				states: { work: { kind: "state", action: agent("worker"), transitions: { DONE: "done" } }, done: final() },
			}),
		);
		const inspector = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, [
			{ type: "args", args: {}, ...baseRecord(1) },
		]);
		expect(hyperchartRunFromToolDetails({ inspector })).toBe(inspector);
		expect(hyperchartRunFromToolDetails(inspector)).toBe(inspector);
	});

	it("maps completed action runtime data and taken transition", () => {
		const chartAst = ast(
			chart({
				kind: "chart",
				id: "simple",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker"), transitions: { DONE: "done", FAILED: "failed" } },
					done: final(),
					failed: final(),
				},
			}),
		);
		const records: DurableLogRecord[] = [
			{ type: "args", args: { topic: "runtime" }, ...baseRecord(1) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: actionUid(chartAst, "work"),
				definition: (chartAst.states.work as Extract<ChartAst["states"][string], { kind: "state" }>).action,
				...baseRecord(2),
			},
			{
				type: "state_action",
				kind: "complete",
				actionUid: actionUid(chartAst, "work"),
				event: { type: "DONE", output: { ok: true } },
				...baseRecord(3),
			},
		];
		const run = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records, {
			status: { runId: "run", state: "complete", pid: 123, startedAt: 1000, updatedAt: 3000 },
			cwd: "/tmp/project",
		});
		const work = run.states.find((state) => state.id === "work");
		expect(run.mode).toBe("run");
		expect(run.args).toEqual({ topic: "runtime" });
		expect(run.pid).toBe(123);
		expect(run.cwd).toBe("/tmp/project");
		expect(work).toMatchObject({ status: "done", startedAt: 2000, endedAt: 3000, completedEvent: "DONE", attempts: 1 });
		expect(work?.transitions?.find((transition) => transition.event === "DONE")?.taken).toBe(true);
	});

	it("reconstructs resolved inputs and invocation details for every visit", () => {
		const chartAst = ast(
			chart({
				kind: "chart",
				id: "visit-history",
				initial: "work",
				states: {
					work: {
						kind: "state",
						input: { feedback: z.string().default("initial") },
						action: agent("worker", { task: t`Topic ${arg("topic")}; feedback ${input("feedback")}` }),
						transitions: {
							AGAIN: { target: "work", input: { feedback: event("feedback") } },
							DONE: "done",
						},
					},
					done: final(),
				},
			}),
		);
		const uid = actionUid(chartAst, "work");
		const definition = (chartAst.states.work as Extract<ChartAst["states"][string], { kind: "state" }>).action;
		const records: DurableLogRecord[] = [
			{ type: "args", args: { topic: "runtime" }, ...baseRecord(1) },
			{ type: "state_action", kind: "invoke", actionUid: uid, definition, ...baseRecord(2) },
			{
				type: "state_action",
				kind: "complete",
				actionUid: uid,
				event: { type: "AGAIN", output: { feedback: "second" } },
				...baseRecord(3),
			},
			{ type: "state_action", kind: "invoke", actionUid: uid, definition, ...baseRecord(4) },
		];
		const work = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records).states.find(
			(state) => state.id === "work",
		);
		expect(work?.visits).toBe(2);
		expect(work?.visitHistory).toMatchObject([
			{
				visit: 1,
				invokeSeqId: 2,
				status: "done",
				completedEvent: "AGAIN",
				inputs: { feedback: "initial" },
				invocation: { kind: "agent", task: "Topic runtime; feedback initial" },
			},
			{
				visit: 2,
				invokeSeqId: 4,
				status: "running",
				inputs: { feedback: "second" },
				invocation: { kind: "agent", task: "Topic runtime; feedback second" },
			},
		]);
	});

	it("marks downstream completions stale after a state is revisited", () => {
		const chartAst = ast(
			chart({
				kind: "chart",
				id: "stale-downstream",
				initial: "start",
				states: {
					start: { kind: "state", action: agent("start"), transitions: { DONE: "review" } },
					review: { kind: "state", action: agent("review"), transitions: { DONE: "publish" } },
					publish: { kind: "state", action: agent("publish"), transitions: { RETRY: "review", DONE: "done" } },
					done: final(),
				},
			}),
		);
		const definition = (stateId: string) =>
			(chartAst.states[stateId] as Extract<ChartAst["states"][string], { kind: "state" }>).action;
		const records: DurableLogRecord[] = [
			{ type: "args", args: {}, ...baseRecord(1) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: actionUid(chartAst, "start"),
				definition: definition("start"),
				...baseRecord(2),
			},
			{
				type: "state_action",
				kind: "complete",
				actionUid: actionUid(chartAst, "start"),
				event: { type: "DONE" },
				...baseRecord(3),
			},
			{
				type: "state_action",
				kind: "invoke",
				actionUid: actionUid(chartAst, "review"),
				definition: definition("review"),
				...baseRecord(4),
			},
			{
				type: "state_action",
				kind: "complete",
				actionUid: actionUid(chartAst, "review"),
				event: { type: "DONE" },
				...baseRecord(5),
			},
			{
				type: "state_action",
				kind: "invoke",
				actionUid: actionUid(chartAst, "publish"),
				definition: definition("publish"),
				...baseRecord(6),
			},
			{
				type: "state_action",
				kind: "complete",
				actionUid: actionUid(chartAst, "publish"),
				event: { type: "RETRY" },
				...baseRecord(7),
			},
			{
				type: "state_action",
				kind: "invoke",
				actionUid: actionUid(chartAst, "review"),
				definition: definition("review"),
				...baseRecord(8),
			},
		];
		const run = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records);
		expect(run.states.find((state) => state.id === "start")?.status).toBe("done");
		expect(run.states.find((state) => state.id === "review")?.status).toBe("running");
		const publish = run.states.find((state) => state.id === "publish");
		expect(publish?.status).toBe("stale");
		expect(publish?.completedEvent).toBe("RETRY");
		expect(publish?.transitions?.find((transition) => transition.event === "RETRY")?.taken).toBeUndefined();
	});

	it("marks completed states stale across compound re-entry control flow", () => {
		const chartAst = ast(
			chart({
				kind: "chart",
				id: "compound-stale",
				initial: "review",
				states: {
					review: compound({
						initial: "check",
						onDone: "publish",
						states: {
							check: { kind: "state", action: agent("check"), transitions: { DONE: "done" } },
							done: final(),
						},
					}),
					publish: { kind: "state", action: agent("publish"), transitions: { RETRY: "review", DONE: "done" } },
					done: final(),
				},
			}),
		);
		const checkUid = actionUid(chartAst, "review.check");
		const publishUid = actionUid(chartAst, "publish");
		const records: DurableLogRecord[] = [
			{ type: "args", args: {}, ...baseRecord(1) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: checkUid,
				definition: (chartAst.states["review.check"] as Extract<ChartAst["states"][string], { kind: "state" }>).action,
				...baseRecord(2),
			},
			{ type: "state_action", kind: "complete", actionUid: checkUid, event: { type: "DONE" }, ...baseRecord(3) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: publishUid,
				definition: (chartAst.states.publish as Extract<ChartAst["states"][string], { kind: "state" }>).action,
				...baseRecord(4),
			},
			{ type: "state_action", kind: "complete", actionUid: publishUid, event: { type: "RETRY" }, ...baseRecord(5) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: checkUid,
				definition: (chartAst.states["review.check"] as Extract<ChartAst["states"][string], { kind: "state" }>).action,
				...baseRecord(6),
			},
		];
		const run = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records);
		expect(run.states.find((state) => state.id === "review.check")?.status).toBe("running");
		expect(run.states.find((state) => state.id === "publish")?.status).toBe("stale");
	});

	it("marks completed states stale across map re-entry control flow", () => {
		const chartAst = ast(
			chart({
				kind: "chart",
				id: "map-stale",
				initial: "items",
				states: {
					items: map({
						over: arg("items"),
						initial: "work",
						onDone: "publish",
						states: {
							work: { kind: "state", action: agent("work"), transitions: { DONE: "done" } },
							done: final(),
						},
					}),
					publish: { kind: "state", action: agent("publish"), transitions: { RETRY: "items", DONE: "done" } },
					done: final(),
				},
			}),
		);
		const workerUid = actionUid(chartAst, "items#a.work");
		const publishUid = actionUid(chartAst, "publish");
		const workerDefinition = (chartAst.states["items.work"] as Extract<ChartAst["states"][string], { kind: "state" }>)
			.action;
		const publishDefinition = (chartAst.states.publish as Extract<ChartAst["states"][string], { kind: "state" }>)
			.action;
		const records: DurableLogRecord[] = [
			{ type: "args", args: { items: { a: "first" } }, ...baseRecord(1) },
			{ type: "spawned", path: "items", instances: { a: "first" }, ...baseRecord(2) },
			{ type: "state_action", kind: "invoke", actionUid: workerUid, definition: workerDefinition, ...baseRecord(3) },
			{ type: "state_action", kind: "complete", actionUid: workerUid, event: { type: "DONE" }, ...baseRecord(4) },
			{ type: "state_action", kind: "invoke", actionUid: publishUid, definition: publishDefinition, ...baseRecord(5) },
			{ type: "state_action", kind: "complete", actionUid: publishUid, event: { type: "RETRY" }, ...baseRecord(6) },
			{ type: "spawned", path: "items", instances: { a: "second" }, ...baseRecord(7) },
			{ type: "state_action", kind: "invoke", actionUid: workerUid, definition: workerDefinition, ...baseRecord(8) },
		];
		const run = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records);
		expect(run.states.find((state) => state.id === "items#a.work")?.status).toBe("running");
		expect(run.states.find((state) => state.id === "publish")?.status).toBe("stale");
		expect(run.states.find((state) => state.id === "items#a.work")?.visitHistory?.at(-1)?.mapItem).toEqual({
			key: "a",
			value: "second",
		});
	});

	it("keeps current map generation done while invalidating only downstream prior work", () => {
		const chartAst = ast(
			chart({
				kind: "chart",
				id: "map-generation-status",
				initial: "items",
				states: {
					items: map({
						over: arg("items"),
						initial: "design",
						onDone: "gate",
						states: {
							design: { kind: "state", action: agent("design"), transitions: { READY: "write" } },
							write: { kind: "state", action: agent("write"), transitions: { DONE: "done" } },
							done: final(),
						},
					}),
					gate: { kind: "state", action: agent("gate"), transitions: { RETRY: "items", PASS: "done" } },
					done: final(),
				},
			}),
		);
		const definition = (path: string) =>
			(chartAst.states[templatePath(path)] as Extract<ChartAst["states"][string], { kind: "state" }>).action;
		const invoke = (path: string, seqId: number): DurableLogRecord => ({
			type: "state_action",
			kind: "invoke",
			actionUid: actionUid(chartAst, path),
			definition: definition(path),
			...baseRecord(seqId),
		});
		const complete = (path: string, eventType: string, seqId: number): DurableLogRecord => ({
			type: "state_action",
			kind: "complete",
			actionUid: actionUid(chartAst, path),
			event: { type: eventType },
			...baseRecord(seqId),
		});
		const instances = { a: "Alpha", b: "Beta" };
		const records: DurableLogRecord[] = [
			{ type: "args", args: { items: instances }, ...baseRecord(1) },
			{ type: "spawned", path: "items", instances, ...baseRecord(2) },
			invoke("items#a.design", 3),
			complete("items#a.design", "READY", 4),
			invoke("items#a.write", 5),
			complete("items#a.write", "DONE", 6),
			invoke("items#b.design", 7),
			complete("items#b.design", "READY", 8),
			invoke("items#b.write", 9),
			complete("items#b.write", "DONE", 10),
			invoke("gate", 11),
			complete("gate", "RETRY", 12),
			{ type: "spawned", path: "items", instances, ...baseRecord(13) },
			invoke("items#a.design", 14),
			complete("items#a.design", "READY", 15),
			invoke("items#a.write", 16),
			complete("items#a.write", "DONE", 17),
			invoke("items#b.design", 18),
			complete("items#b.design", "READY", 19),
			invoke("items#b.write", 20),
			complete("items#b.write", "DONE", 21),
			invoke("gate", 22),
		];
		const run = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records);
		for (const path of [
			"items#a.design",
			"items#a.write",
			"items#a.done",
			"items#b.design",
			"items#b.write",
			"items#b.done",
		]) {
			expect(run.states.find((state) => state.id === path)?.status, path).toBe("done");
		}
		const mapState = run.states.find((state) => state.id === "items");
		expect(mapState?.status).toBe("done");
		expect(mapState?.mapConfig?.items).toMatchObject([
			{ key: "a", status: "done", visits: [1, 2] },
			{ key: "b", status: "done", visits: [1, 2] },
		]);
		expect(run.states.find((state) => state.id === "gate")?.status).toBe("running");
	});

	it("marks completed states stale across parallel re-entry control flow", () => {
		const chartAst = ast(
			chart({
				kind: "chart",
				id: "parallel-stale",
				initial: "fan",
				states: {
					fan: parallel({
						states: {
							left: compound({
								initial: "work",
								states: {
									work: { kind: "state", action: agent("left"), transitions: { DONE: "done" } },
									done: final(),
								},
							}),
							right: compound({
								initial: "work",
								states: {
									work: { kind: "state", action: agent("right"), transitions: { DONE: "done" } },
									done: final(),
								},
							}),
						},
						onDone: "publish",
					}),
					publish: { kind: "state", action: agent("publish"), transitions: { RETRY: "fan", DONE: "done" } },
					done: final(),
				},
			}),
		);
		const leftUid = actionUid(chartAst, "fan.left.work");
		const rightUid = actionUid(chartAst, "fan.right.work");
		const publishUid = actionUid(chartAst, "publish");
		const definition = (stateId: string) =>
			(chartAst.states[stateId] as Extract<ChartAst["states"][string], { kind: "state" }>).action;
		const records: DurableLogRecord[] = [
			{ type: "args", args: {}, ...baseRecord(1) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: leftUid,
				definition: definition("fan.left.work"),
				...baseRecord(2),
			},
			{
				type: "state_action",
				kind: "invoke",
				actionUid: rightUid,
				definition: definition("fan.right.work"),
				...baseRecord(3),
			},
			{ type: "state_action", kind: "complete", actionUid: leftUid, event: { type: "DONE" }, ...baseRecord(4) },
			{ type: "state_action", kind: "complete", actionUid: rightUid, event: { type: "DONE" }, ...baseRecord(5) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: publishUid,
				definition: definition("publish"),
				...baseRecord(6),
			},
			{ type: "state_action", kind: "complete", actionUid: publishUid, event: { type: "RETRY" }, ...baseRecord(7) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: leftUid,
				definition: definition("fan.left.work"),
				...baseRecord(8),
			},
			{
				type: "state_action",
				kind: "invoke",
				actionUid: rightUid,
				definition: definition("fan.right.work"),
				...baseRecord(9),
			},
		];
		const run = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records);
		expect(run.states.find((state) => state.id === "publish")?.status).toBe("stale");
		expect(run.states.find((state) => state.id === "fan")?.subProgress).toEqual({
			done: 0,
			running: 2,
			failed: 0,
			total: 2,
		});
	});

	it("closes timed-out and scope-exited visits", () => {
		const timedAst = ast(
			chart({
				kind: "chart",
				id: "timed-visits",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: agent("work"),
						after: { delayMs: 10, target: "timeout" },
						transitions: { DONE: "done" },
					},
					timeout: final(),
					done: final(),
				},
			}),
		);
		const timedUid = actionUid(timedAst, "work");
		const timedRun = hyperchartRunFromRuntime(inspectChartAst(timedAst), timedAst, [
			{ type: "args", args: {}, ...baseRecord(1) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: timedUid,
				definition: (timedAst.states.work as Extract<ChartAst["states"][string], { kind: "state" }>).action,
				...baseRecord(2),
			},
			{ type: "state_action", kind: "timer_fired", actionUid: timedUid, ...baseRecord(3) },
		]);
		expect(timedRun.states.find((state) => state.id === "work")?.visitHistory?.[0]).toMatchObject({
			status: "cancelled",
			endedAt: 3000,
			endedReason: "timed_out",
		});

		const fanAst = ast(
			chart({
				kind: "chart",
				id: "abandoned-visits",
				initial: "fan",
				states: {
					fan: parallel({
						states: {
							left: compound({
								initial: "work",
								states: {
									work: { kind: "state", action: agent("left"), transitions: { DONE: "done" } },
									done: final(),
								},
							}),
							right: compound({
								initial: "work",
								states: {
									work: { kind: "state", action: agent("right"), transitions: { DONE: "done" } },
									done: final(),
								},
							}),
						},
						transitions: { FAILED: "failed" },
						onDone: "done",
					}),
					done: final(),
					failed: final(),
				},
			}),
		);
		const leftUid = actionUid(fanAst, "fan.left.work");
		const rightUid = actionUid(fanAst, "fan.right.work");
		const fanRun = hyperchartRunFromRuntime(inspectChartAst(fanAst), fanAst, [
			{ type: "args", args: {}, ...baseRecord(1) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: leftUid,
				definition: (fanAst.states["fan.left.work"] as Extract<ChartAst["states"][string], { kind: "state" }>).action,
				...baseRecord(2),
			},
			{
				type: "state_action",
				kind: "invoke",
				actionUid: rightUid,
				definition: (fanAst.states["fan.right.work"] as Extract<ChartAst["states"][string], { kind: "state" }>).action,
				...baseRecord(3),
			},
			{
				type: "state_action",
				kind: "complete",
				actionUid: rightUid,
				event: { type: "FAILED", error: "stop" },
				...baseRecord(4),
			},
		]);
		expect(fanRun.states.find((state) => state.id === "fan.left.work")?.visitHistory?.[0]).toMatchObject({
			status: "cancelled",
			endedAt: 4000,
			endedReason: "scope_exit",
		});
		expect(fanRun.states.find((state) => state.id === "fan.right.work")?.visitHistory?.[0]).toMatchObject({
			status: "failed",
			endedAt: 4000,
			completedEvent: "FAILED",
		});
	});

	it("maps run-level status errors and replay warnings", () => {
		const chartAst = ast(
			chart({
				kind: "chart",
				id: "run-issues",
				initial: "work",
				states: { work: { kind: "state", action: agent("worker"), transitions: { DONE: "done" } }, done: final() },
			}),
		);
		const run = hyperchartRunFromRuntime(
			inspectChartAst(chartAst),
			chartAst,
			[{ type: "args", args: {}, ...baseRecord(1) }],
			{
				status: {
					runId: "run",
					state: "failed",
					error: "runner crashed",
					exitCode: 1,
					replayWarnings: ["Replay warning: stale provenance"],
					updatedAt: 3000,
				},
			},
		);
		expect(run.issues).toMatchObject([
			{
				severity: "error",
				kind: "run_failed",
				source: "status",
				message: "runner crashed",
				payload: { exitCode: 1 },
				timestamp: 3000,
			},
			{
				severity: "warning",
				kind: "replay_warning",
				source: "status",
				message: "Replay warning: stale provenance",
				timestamp: 3000,
			},
		]);
	});

	it("maps failed action runtime data and taken failure transition", () => {
		const chartAst = ast(
			chart({
				kind: "chart",
				id: "failed-action",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker"), transitions: { DONE: "done", FAILED: "failed" } },
					done: final(),
					failed: final(),
				},
			}),
		);
		const uid = actionUid(chartAst, "work");
		const records: DurableLogRecord[] = [
			{ type: "args", args: {}, ...baseRecord(1) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: uid,
				definition: (chartAst.states.work as Extract<ChartAst["states"][string], { kind: "state" }>).action,
				...baseRecord(2),
			},
			{
				type: "state_action",
				kind: "complete",
				actionUid: uid,
				event: { type: "FAILED", error: "boom" },
				...baseRecord(3),
			},
		];
		const work = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records).states.find(
			(state) => state.id === "work",
		);
		expect(work).toMatchObject({ status: "failed", completedEvent: "FAILED", attempts: 1, endedAt: 3000 });
		expect(work?.issues).toMatchObject([
			{
				severity: "error",
				kind: "action_failed",
				source: "durable_log",
				message: "boom",
				stateId: "work",
				seqId: 3,
				timestamp: 3000,
				payload: "boom",
			},
		]);
		expect(work?.transitions?.find((transition) => transition.event === "FAILED")?.taken).toBe(true);
	});

	it("keeps structured failed action payloads readable and inspectable", () => {
		const chartAst = ast(
			chart({
				kind: "chart",
				id: "structured-failure",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker"), transitions: { FAILED: "failed" } },
					failed: final(),
				},
			}),
		);
		const uid = actionUid(chartAst, "work");
		const payload = { code: 2, signal: null, stderr: "first line\nlast line" };
		const records: DurableLogRecord[] = [
			{ type: "args", args: {}, ...baseRecord(1) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: uid,
				definition: (chartAst.states.work as Extract<ChartAst["states"][string], { kind: "state" }>).action,
				...baseRecord(2),
			},
			{
				type: "state_action",
				kind: "complete",
				actionUid: uid,
				event: { type: "FAILED", error: payload },
				...baseRecord(3),
			},
		];
		const work = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records).states.find(
			(state) => state.id === "work",
		);
		expect(work?.issues?.[0]).toMatchObject({
			severity: "error",
			kind: "action_failed",
			message: "Script exited with code 2: last line",
			payload,
		});
	});

	it("maps validation attempts from durable validation records", () => {
		const chartAst = ast(
			chart({
				kind: "chart",
				id: "validated",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: agent("worker"),
						validate: tsImport("./check.js", "ok"),
						retries: 2,
						transitions: { DONE: "done", FAILED: "failed" },
					},
					done: final(),
					failed: final(),
				},
			}),
		);
		const uid = actionUid(chartAst, "work");
		const records: DurableLogRecord[] = [
			{ type: "args", args: {}, ...baseRecord(1) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: uid,
				definition: (chartAst.states.work as Extract<ChartAst["states"][string], { kind: "state" }>).action,
				...baseRecord(2),
			},
			{ type: "state_action", kind: "complete", actionUid: uid, event: { type: "DONE" }, ...baseRecord(3) },
			{
				type: "state_action",
				kind: "validated",
				actionUid: uid,
				event: { type: "DONE" },
				guard: tsImport("./check.js", "ok"),
				outcome: { ok: false, reason: "no" },
				...baseRecord(4),
			},
		];
		const work = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records).states.find(
			(state) => state.id === "work",
		);
		expect(work?.guard).toEqual({ kind: "tsImport", module: "./check.js", export: "ok" });
		expect(work?.retry).toEqual({ max: 2 });
		expect(work?.validationAttempts).toBe(1);
		expect(work?.validation?.latestRejectedReason).toBe("no");
		expect(work?.issues).toMatchObject([
			{
				severity: "warning",
				kind: "validation_rejected",
				message: "no",
				source: "durable_log",
				stateId: "work",
				seqId: 4,
				timestamp: 4000,
				payload: { ok: false, reason: "no" },
			},
		]);
		expect(work?.status).toBe("running");
		expect(work?.endedAt).toBeUndefined();
		expect(work?.completedEvent).toBeUndefined();
		expect(work?.transitions?.find((transition) => transition.event === "DONE")?.taken).toBeUndefined();

		const acceptedRecords: DurableLogRecord[] = [
			...records,
			{ type: "state_action", kind: "complete", actionUid: uid, event: { type: "DONE" }, ...baseRecord(5) },
			{
				type: "state_action",
				kind: "validated",
				actionUid: uid,
				event: { type: "DONE" },
				guard: tsImport("./check.js", "ok"),
				outcome: true,
				...baseRecord(6),
			},
		];
		const accepted = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, acceptedRecords).states.find(
			(state) => state.id === "work",
		);
		expect(accepted).toMatchObject({ status: "done", endedAt: 6000, completedEvent: "DONE" });
		expect(accepted?.transitions?.find((transition) => transition.event === "DONE")?.taken).toBe(true);
	});

	it("shows retry-exhausted validation rejection as a failed transition", () => {
		const chartAst = ast(
			chart({
				kind: "chart",
				id: "rejected-terminal",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: agent("worker"),
						validate: tsImport("./check.js", "ok"),
						retries: 0,
						transitions: { DONE: "done", FAILED: "failed" },
					},
					done: final(),
					failed: final(),
				},
			}),
		);
		const uid = actionUid(chartAst, "work");
		const records: DurableLogRecord[] = [
			{ type: "args", args: {}, ...baseRecord(1) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: uid,
				definition: (chartAst.states.work as Extract<ChartAst["states"][string], { kind: "state" }>).action,
				...baseRecord(2),
			},
			{ type: "state_action", kind: "complete", actionUid: uid, event: { type: "DONE" }, ...baseRecord(3) },
			{
				type: "state_action",
				kind: "validated",
				actionUid: uid,
				event: { type: "DONE" },
				guard: tsImport("./check.js", "ok"),
				outcome: { ok: false, reason: "no" },
				...baseRecord(4),
			},
		];
		const work = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records).states.find(
			(state) => state.id === "work",
		);
		expect(work).toMatchObject({ status: "failed", endedAt: 4000, completedEvent: "FAILED" });
		expect(work?.transitions?.find((transition) => transition.event === "FAILED")?.taken).toBe(true);
		expect(work?.transitions?.find((transition) => transition.event === "DONE")?.taken).toBeUndefined();
	});

	it("maps spawned map instances, item values, item progress, and materialized workers", () => {
		const chartAst = ast(
			chart({
				kind: "chart",
				id: "mapped",
				initial: "items",
				states: {
					items: map({
						over: arg("items"),
						initial: "work",
						onDone: "done",
						states: {
							work: { kind: "state", action: agent("worker"), transitions: { DONE: "done", FAILED: "failed" } },
							done: final(),
							failed: final(),
						},
					}),
					done: final(),
				},
			}),
		);
		const uidA = actionUid(chartAst, "items#a.work");
		const uidB = actionUid(chartAst, "items#b.work");
		const uidC = actionUid(chartAst, "items#c.work");
		const instances = { a: { title: "Alpha", summary: "first" }, b: { title: "Beta" }, c: { title: "Gamma" } };
		const records: DurableLogRecord[] = [
			{ type: "args", args: { items: instances }, ...baseRecord(1) },
			{ type: "spawned", path: "items", instances, ...baseRecord(2) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: uidA,
				definition: (chartAst.states["items.work"] as Extract<ChartAst["states"][string], { kind: "state" }>).action,
				...baseRecord(3),
			},
			{ type: "state_action", kind: "complete", actionUid: uidA, event: { type: "DONE" }, ...baseRecord(4) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: uidB,
				definition: (chartAst.states["items.work"] as Extract<ChartAst["states"][string], { kind: "state" }>).action,
				...baseRecord(5),
			},
			{
				type: "state_action",
				kind: "invoke",
				actionUid: uidC,
				definition: (chartAst.states["items.work"] as Extract<ChartAst["states"][string], { kind: "state" }>).action,
				...baseRecord(6),
			},
			{
				type: "state_action",
				kind: "complete",
				actionUid: uidC,
				event: { type: "FAILED", error: "bad item" },
				...baseRecord(7),
			},
		];
		const run = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records);
		expect(run.states.filter((state) => state.id.startsWith("items."))).toEqual([]);
		const mapState = run.states.find((state) => state.id === "items");
		expect(mapState?.mapConfig?.items).toMatchObject([
			{ key: "a", label: "Alpha", summary: "first", status: "done", value: { title: "Alpha", summary: "first" }, visits: [1] },
			{ key: "b", label: "Beta", status: "running", value: { title: "Beta" }, visits: [1] },
			{ key: "c", label: "Gamma", status: "failed", value: { title: "Gamma" }, visits: [1] },
		]);
		expect(mapState?.visits).toBe(1);
		expect(mapState?.mapConfig?.visitHistory).toEqual([
			{ visit: 1, spawnSeqId: 2, startedAt: 2000, instances },
		]);
		expect(mapState?.subProgress).toEqual({ done: 1, running: 1, failed: 1, total: 3 });
		const itemBWorker = run.states.find((state) => state.id === "items#b.work");
		const itemCWorker = run.states.find((state) => state.id === "items#c.work");
		expect(itemBWorker).toMatchObject({ status: "running", mapKey: "b", mapItemLabel: "Beta" });
		expect(itemBWorker?.transitions?.find((transition) => transition.event === "DONE")?.target).toBe("items#b.done");
		expect(itemCWorker).toMatchObject({ status: "failed", mapKey: "c", mapItemLabel: "Gamma" });
		expect(itemCWorker?.transitions?.find((transition) => transition.event === "FAILED")?.target).toBe(
			"items#c.failed",
		);
		expect(itemCWorker?.issues?.[0]).toMatchObject({ kind: "action_failed", message: "bad item" });
		expect(mapState?.mapConfig?.items?.find((item) => item.key === "c")?.issueCount).toBe(1);
	});

	it("derives UI-only map visit history from repeated spawned facts", () => {
		const chartAst = ast(
			chart({
				kind: "chart",
				id: "map-visits",
				initial: "items",
				states: {
					items: map({
						over: arg("items"),
						initial: "work",
						onDone: "gate",
						states: {
							work: { kind: "state", action: agent("worker"), transitions: { DONE: "done" } },
							done: final(),
						},
					}),
					gate: { kind: "state", action: agent("gate"), transitions: { REDO: "items", PASS: "done" } },
					done: final(),
				},
			}),
		);
		const firstInstances = { a: { title: "Alpha" }, b: { title: "Beta v1" } };
		const secondInstances = { b: { title: "Beta v2" }, c: { title: "Gamma" } };
		const itemUid = actionUid(chartAst, "items#a.work");
		const secondItemUid = actionUid(chartAst, "items#b.work");
		const gateUid = actionUid(chartAst, "gate");
		const itemDefinition = (chartAst.states["items.work"] as Extract<ChartAst["states"][string], { kind: "state" }>).action;
		const gateDefinition = (chartAst.states.gate as Extract<ChartAst["states"][string], { kind: "state" }>).action;
		const records: DurableLogRecord[] = [
			{ type: "args", args: { items: firstInstances }, ...baseRecord(1) },
			{ type: "spawned", path: "items", instances: firstInstances, ...baseRecord(2) },
			{ type: "state_action", kind: "invoke", actionUid: itemUid, definition: itemDefinition, ...baseRecord(3) },
			{ type: "state_action", kind: "complete", actionUid: itemUid, event: { type: "DONE" }, ...baseRecord(4) },
			{ type: "state_action", kind: "invoke", actionUid: secondItemUid, definition: itemDefinition, ...baseRecord(5) },
			{ type: "state_action", kind: "complete", actionUid: secondItemUid, event: { type: "DONE" }, ...baseRecord(6) },
			{ type: "state_action", kind: "invoke", actionUid: gateUid, definition: gateDefinition, ...baseRecord(7) },
			{ type: "state_action", kind: "complete", actionUid: gateUid, event: { type: "REDO" }, ...baseRecord(8) },
			{ type: "spawned", path: "items", instances: secondInstances, ...baseRecord(9) },
		];

		const mapState = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records).states.find(
			(state) => state.id === "items",
		);
		expect(mapState?.visits).toBe(2);
		expect(mapState?.mapConfig?.visitHistory).toEqual([
			{ visit: 1, spawnSeqId: 2, startedAt: 2000, instances: firstInstances },
			{ visit: 2, spawnSeqId: 9, startedAt: 9000, instances: secondInstances },
		]);
		expect(mapState?.mapConfig?.items).toMatchObject([
			{ key: "a", label: "Alpha", status: "stale", visits: [1] },
			{ key: "b", label: "Beta v2", visits: [1, 2] },
			{ key: "c", label: "Gamma", visits: [2] },
		]);
		expect(mapState?.subProgress).toEqual({ done: 0, running: 2, failed: 0, total: 2 });
	});

	it("materializes nested map workers from concrete spawn paths", () => {
		const chartAst = ast(
			chart({
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
			}),
		);
		const nestedUid = actionUid(chartAst, "outer#a.inner#x.work");
		const records: DurableLogRecord[] = [
			{ type: "args", args: { outer: { a: {} }, inner: { x: { title: "Nested" } } }, ...baseRecord(1) },
			{ type: "spawned", path: "outer", instances: { a: {} }, ...baseRecord(2) },
			{ type: "spawned", path: "outer#a.inner", instances: { x: { title: "Nested" } }, ...baseRecord(3) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: nestedUid,
				definition: (chartAst.states["outer.inner.work"] as Extract<ChartAst["states"][string], { kind: "state" }>)
					.action,
				...baseRecord(4),
			},
		];

		const run = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records);
		const worker = run.states.find((state) => state.id === "outer#a.inner#x.work");
		expect(run.states.find((state) => state.id === "outer#a.inner")).toMatchObject({ type: "map" });
		expect(run.states.some((state) => state.id === "outer#a.inner.work")).toBe(false);
		expect(worker).toMatchObject({ status: "running", mapKey: "x", mapItemLabel: "Nested" });
		expect(worker?.transitions?.find((transition) => transition.event === "DONE")?.target).toBe("outer#a.inner#x.done");
	});

	it("rebases parallel branch scopes inside materialized map instances", () => {
		const chartAst = ast(
			chart({
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
									left: compound({
										initial: "work",
										states: {
											work: { kind: "state", action: agent("left"), transitions: { DONE: "done" } },
											done: final(),
										},
									}),
									right: compound({
										initial: "work",
										states: {
											work: { kind: "state", action: agent("right"), transitions: { DONE: "done" } },
											done: final(),
										},
									}),
								},
								onDone: "done",
							}),
							done: final(),
						},
					}),
					done: final(),
				},
			}),
		);
		const leftUid = actionUid(chartAst, "items#a.fan.left.work");
		const rightUid = actionUid(chartAst, "items#a.fan.right.work");
		const records: DurableLogRecord[] = [
			{ type: "args", args: { items: { a: {} } }, ...baseRecord(1) },
			{ type: "spawned", path: "items", instances: { a: {} }, ...baseRecord(2) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: leftUid,
				definition: (chartAst.states["items.fan.left.work"] as Extract<ChartAst["states"][string], { kind: "state" }>)
					.action,
				...baseRecord(3),
			},
			{ type: "state_action", kind: "complete", actionUid: leftUid, event: { type: "DONE" }, ...baseRecord(4) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: rightUid,
				definition: (chartAst.states["items.fan.right.work"] as Extract<ChartAst["states"][string], { kind: "state" }>)
					.action,
				...baseRecord(5),
			},
		];
		const fan = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records, {
			sessionProgress: {
				sessions: { [actionUidKey(rightUid)]: { actionUid: rightUid, status: "failed", error: "right failed" } },
			},
		}).states.find((state) => state.id === "items#a.fan");
		expect(fan?.parallelConfig?.branches).toMatchObject([
			{ id: "items#a.fan.left" },
			{ id: "items#a.fan.right", issueCount: 1 },
		]);
		expect(fan?.subProgress).toEqual({ done: 1, running: 1, failed: 0, total: 2 });
	});

	it("maps parallel branch progress and static branch previews", () => {
		const chartAst = ast(
			chart({
				kind: "chart",
				id: "parallel-run",
				initial: "fan",
				states: {
					fan: parallel({
						states: {
							left: compound({
								initial: "work",
								states: {
									work: {
										kind: "state",
										action: agent("left-agent", { task: "Left task" }),
										transitions: { DONE: "done" },
									},
									done: final(),
								},
							}),
							right: compound({
								initial: "work",
								states: {
									work: {
										kind: "state",
										action: agent("right-agent", { task: "Right task" }),
										transitions: { DONE: "done" },
									},
									done: final(),
								},
							}),
						},
						onDone: "done",
					}),
					done: final(),
				},
			}),
		);
		const leftUid = actionUid(chartAst, "fan.left.work");
		const rightUid = actionUid(chartAst, "fan.right.work");
		const records: DurableLogRecord[] = [
			{ type: "args", args: {}, ...baseRecord(1) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: leftUid,
				definition: (chartAst.states["fan.left.work"] as Extract<ChartAst["states"][string], { kind: "state" }>).action,
				...baseRecord(2),
			},
			{ type: "state_action", kind: "complete", actionUid: leftUid, event: { type: "DONE" }, ...baseRecord(3) },
			{
				type: "state_action",
				kind: "invoke",
				actionUid: rightUid,
				definition: (chartAst.states["fan.right.work"] as Extract<ChartAst["states"][string], { kind: "state" }>)
					.action,
				...baseRecord(4),
			},
		];
		const fan = hyperchartRunFromRuntime(inspectChartAst(chartAst), chartAst, records, {
			sessionProgress: {
				sessions: {
					[actionUidKey(rightUid)]: {
						actionUid: rightUid,
						actionName: "right-agent",
						status: "failed",
						error: "right branch session failed",
						lastActivityAt: 5000,
					},
				},
			},
		}).states.find((state) => state.id === "fan");
		expect(fan?.parallelConfig?.branches).toMatchObject([
			{ id: "fan.left", agent: "left-agent", taskPreview: "Left task" },
			{ id: "fan.right", agent: "right-agent", taskPreview: "Right task", issueCount: 1 },
		]);
		expect(fan?.subProgress).toEqual({ done: 1, running: 1, failed: 0, total: 2 });
	});

	it("maps failed session progress to the matching state only in run mode", () => {
		const chartAst = ast(
			chart({
				kind: "chart",
				id: "session-failure",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker"), transitions: { DONE: "done", FAILED: "failed" } },
					done: final(),
					failed: final(),
				},
			}),
		);
		const uid = actionUid(chartAst, "work");
		const run = hyperchartRunFromRuntime(
			inspectChartAst(chartAst),
			chartAst,
			[{ type: "args", args: {}, ...baseRecord(1) }],
			{
				sessionProgress: {
					sessions: {
						[actionUidKey(uid)]: {
							actionUid: uid,
							actionName: "worker",
							status: "failed",
							error: "session crashed",
							startedAt: 1000,
							lastActivityAt: 2500,
							turnCount: 3,
							toolCount: 4,
						},
					},
				},
			},
		);
		const work = run.states.find((state) => state.id === "work");
		expect(work?.issues).toMatchObject([
			{
				severity: "error",
				kind: "session_failed",
				source: "session_progress",
				message: "session crashed",
				stateId: "work",
				timestamp: 2500,
			},
		]);
	});
});
