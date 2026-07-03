import { describe, expect, it } from "vitest";
import {
	agent,
	chart,
	arg,
	compound,
	artifact,
	artifactOf,
	final,
	json,
	jsonSchema,
	normalizeChartConfig,
	parallel,
	result,
	t,
	tsImport,
} from "../src/index.js";
import { loop, start } from "../src/core/execution_loop.js";
import type {
	ActionUID,
	ChartAst,
	DurableLogRecord,
	Effect,
	GuardOutcome,
	MachineEvent,
	StateCst,
	StateId,
} from "../src/index.js";
import { failOnPullEvents, MockRuntime } from "./mock_runtime.js";

function linearAst(): ChartAst {
	const result = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "test-chart",
			initial: "start",
			states: {
				start: {
					kind: "state",
					action: agent("worker"),
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		}),
	);
	if (!result.ok) throw new Error("test chart should be valid");
	return result.ast;
}

function finalAst(): ChartAst {
	const result = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "test-chart",
			initial: "done",
			states: {
				done: final(),
			},
		}),
	);
	if (!result.ok) throw new Error("test chart should be valid");
	return result.ast;
}

function twoStepAst(): ChartAst {
	const result = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "complex-chart",
			initial: "first",
			states: {
				first: {
					kind: "state",
					action: agent("first-worker"),
					transitions: { FIRST_DONE: "second" },
				},
				second: {
					kind: "state",
					action: agent("second-worker"),
					transitions: { SECOND_DONE: "done" },
				},
				done: final(),
			},
		}),
	);
	if (!result.ok) throw new Error("test chart should be valid");
	return result.ast;
}

function validatedAst(onReject?: "resume" | "restart"): ChartAst {
	const result = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "validated-chart",
			initial: "work",
			states: {
				work: {
					kind: "state",
					action: agent("coder"),
					validate: tsImport("./checks.js", "testsPass"),
					...(onReject === undefined ? {} : { onReject }),
					transitions: { DONE: "done", FAILED: "failed" },
				},
				done: final(),
				failed: final(),
			},
		}),
	);
	if (!result.ok) throw new Error("test chart should be valid");
	return result.ast;
}

function afterAst(escalated: StateCst = final()): ChartAst {
	const result = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "timed-chart",
			initial: "work",
			states: {
				work: {
					kind: "state",
					action: agent("coder"),
					after: { delayMs: 500, target: "escalated" },
					transitions: { DONE: "done" },
				},
				done: final(),
				escalated,
			},
		}),
	);
	if (!result.ok) throw new Error("test chart should be valid");
	return result.ast;
}

function compoundAst(): ChartAst {
	const result = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "nested-chart",
			initial: "review",
			states: {
				review: compound({
					initial: "analyze",
					onDone: "deploy",
					states: {
						analyze: { kind: "state", action: agent("analyzer"), transitions: { OK: "fix" } },
						fix: { kind: "state", action: agent("fixer"), transitions: { OK: "verified" } },
						verified: final(),
					},
					transitions: { FAILED: "escalate" },
				}),
				deploy: final(),
				escalate: final(),
			},
		}),
	);
	if (!result.ok) throw new Error("test chart should be valid");
	return result.ast;
}

function parallelAst(): ChartAst {
	const region = (worker: string) =>
		compound({
			initial: "scan",
			states: {
				scan: { kind: "state" as const, action: agent(worker), transitions: { OK: "ok" } },
				ok: final(),
			},
		});
	const result = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "par-chart",
			initial: "audit",
			states: {
				audit: parallel({
					states: { security: region("security-bot"), perf: region("perf-bot") },
					onDone: "merge",
					transitions: { FAILED: "escalate" },
				}),
				merge: final(),
				escalate: final(),
			},
		}),
	);
	if (!result.ok) throw new Error("test chart should be valid");
	return result.ast;
}

function actionUid(ast: ChartAst, stateId: StateId = "start"): ActionUID {
	const state = ast.states[stateId];
	if (state?.kind !== "state") throw new Error(`state ${stateId} should be actionable`);
	return state.action.uid;
}

function meta(seqId: number) {
	return { seqId, parentId: null, timestamp: seqId };
}

function complete(uid: ActionUID, eventType: string, seqId = 1): DurableLogRecord {
	return { type: "state_action", kind: "complete", actionUid: uid, event: { type: eventType }, ...meta(seqId) };
}

function invoke(uid: ActionUID, seqId = 1): DurableLogRecord {
	return { type: "state_action", kind: "invoke", actionUid: uid, ...meta(seqId) };
}

function timerFired(uid: ActionUID, seqId = 1): DurableLogRecord {
	return { type: "state_action", kind: "timer_fired", actionUid: uid, ...meta(seqId) };
}

function validated(uid: ActionUID, eventType: string, outcome: GuardOutcome, seqId = 1): DurableLogRecord {
	return {
		type: "state_action",
		kind: "validated",
		actionUid: uid,
		event: { type: eventType },
		guard: { kind: "tsImport", module: "./checks.js", export: "testsPass" },
		outcome,
		...meta(seqId),
	};
}

function durableRecordsAdded(records: readonly DurableLogRecord[], effectId = "durable-log"): MachineEvent {
	return { kind: "durable_records_added", effectId, records };
}

describe("execution loop", () => {
	it("returns immediately when the initial state is final", async () => {
		const runtime = new MockRuntime({ ast: finalAst(), events: failOnPullEvents() });

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(runtime.effectBatches).toEqual([]);
		expect(runtime.calls).toEqual(["loadAst", "loadLogs", "eventsQueue"]);
	});

	it("projects persisted logs before processing runtime events", async () => {
		const ast = linearAst();
		const runtime = new MockRuntime({
			ast,
			logs: [complete(actionUid(ast), "DONE")],
			events: failOnPullEvents(),
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(runtime.effectBatches).toEqual([]);
	});

	it("runs effects for pending action invocations on the synthetic start event", async () => {
		const ast = linearAst();
		const uid = actionUid(ast);
		const runtime = new MockRuntime({ ast, logs: [invoke(uid)], events: [] });

		await expect(loop(runtime)).rejects.toThrow("Event queue closed before reaching a final state");

		expect(runtime.effectBatches).toHaveLength(1);
		expect(runtime.effectBatches[0]).toEqual([
			expect.objectContaining({
				kind: "agent",
				id: "running:test-chart:start:agent:1",
				actionUid: uid,
			}),
		]);
	});

	it("reaches final state through agent DONE event and durable records effect", async () => {
		const ast = linearAst();
		const uid = actionUid(ast);
		const doneEvent = { type: "DONE" };
		const events: MachineEvent[] = [];
		const sequence: string[] = [];
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(uid)],
			events,
			onRunEffects(effects) {
				const [effect] = effects;
				if (effect === undefined) throw new Error("expected effect");

				sequence.push(effect.kind);
				switch (effect.kind) {
					case "agent":
						expect(effect).toEqual(
							expect.objectContaining({
								kind: "agent",
								actionUid: uid,
							}),
						);
						events.push({ kind: "agent", effectId: effect.id, event: doneEvent });
						break;
					case "durable_records":
						expect(effect.records).toEqual([
							expect.objectContaining({
								type: "state_action",
								kind: "complete",
								actionUid: uid,
								event: doneEvent,
								parentId: 1,
								seqId: 2,
								timestamp: expect.any(Number),
							}),
						]);
						events.push(durableRecordsAdded(effect.records, effect.id));
						break;
					default:
						throw new Error(`unexpected effect kind ${effect.kind}`);
				}
			},
		});

		const state = await loop(runtime);

		expect(sequence).toEqual(["agent", "durable_records"]);
		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(state.projection.pendingActions).toEqual([]);
	});

	it("runs two agent states in sequence, machine invoking each action itself", async () => {
		const ast = twoStepAst();
		const events: MachineEvent[] = [];
		const sequence: string[] = [];
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				const [effect] = effects;
				if (effect === undefined) throw new Error("expected effect");

				switch (effect.kind) {
					case "agent": {
						sequence.push(`agent:${effect.actionUid.state}`);
						const eventType = effect.actionUid.state === "first" ? "FIRST_DONE" : "SECOND_DONE";
						events.push({ kind: "agent", effectId: effect.id, event: { type: eventType } });
						break;
					}
					case "durable_records": {
						for (const record of effect.records) {
							if (record.type === "state_action") {
								sequence.push(`${record.kind}:${record.actionUid.state}`);
							}
						}
						events.push(durableRecordsAdded(effect.records, effect.id));
						break;
					}
					default:
						throw new Error(`unexpected effect kind ${effect.kind}`);
				}
			},
		});

		const state = await loop(runtime);

		expect(sequence).toEqual([
			"invoke:first",
			"agent:first",
			"complete:first",
			"invoke:second",
			"agent:second",
			"complete:second",
		]);
		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(state.projection.pendingActions).toEqual([]);
	});

	function runValidatedChart(
		outcomes: GuardOutcome[],
		options: { onReject?: "resume" | "restart"; claim?: string } = {},
	) {
		const ast = validatedAst(options.onReject);
		const uid = actionUid(ast, "work");
		const events: MachineEvent[] = [];
		const validations: Extract<Effect, { kind: "validate" }>[] = [];
		const rejections: Extract<Effect, { kind: "rejected" }>[] = [];
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(uid)],
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						events.push({ kind: "agent", effectId: effect.id, event: { type: options.claim ?? "DONE" } });
					}
					if (effect.kind === "validate") {
						validations.push(effect);
						const outcome = outcomes.shift();
						if (outcome === undefined) throw new Error("unexpected validate effect");
						events.push({ kind: "validated", effectId: effect.id, outcome });
					}
					if (effect.kind === "rejected") {
						rejections.push(effect);
						// The action is still pending under the same effect id: retry the claim.
						events.push({ kind: "agent", effectId: effect.id, event: { type: "DONE" } });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});
		return { runtime, validations, rejections, run: loop(runtime) };
	}

	it("accepts a completion claim when validation passes", async () => {
		const { validations, rejections, run } = runValidatedChart([true]);

		const state = await run;

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(rejections).toEqual([]);
		expect(validations).toHaveLength(1);
		expect(validations[0]).toEqual(
			expect.objectContaining({
				kind: "validate",
				guard: { kind: "tsImport", module: "./checks.js", export: "testsPass" },
				event: { type: "DONE" },
			}),
		);
	});

	it("rejects a failed claim with feedback and accepts the retry", async () => {
		const { runtime, rejections, run } = runValidatedChart([{ ok: false, reason: "tests are failing" }, true]);

		const state = await run;

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(rejections).toHaveLength(1);
		expect(rejections[0]).toEqual(
			expect.objectContaining({ kind: "rejected", onReject: "resume", reason: "tests are failing" }),
		);
		// The whole validation history is durable: claim, verdict, retry, verdict.
		const records = runtime.effectBatches
			.flat()
			.flatMap((effect) => (effect.kind === "durable_records" ? [...effect.records] : []));
		expect(records.map((record) => (record.type === "state_action" ? record.kind : record.type))).toEqual([
			"complete",
			"validated",
			"complete",
			"validated",
		]);
	});

	it("carries the chart-declared restart mode in the rejected effect", async () => {
		const { rejections, run } = runValidatedChart([false, true], { onReject: "restart" });

		await run;

		expect(rejections).toHaveLength(1);
		expect(rejections[0]).toEqual(expect.objectContaining({ kind: "rejected", onReject: "restart" }));
		expect(rejections[0]?.reason).toBeUndefined();
	});

	it("lets FAILED bypass validation", async () => {
		const { validations, rejections, run } = runValidatedChart([], { claim: "FAILED" });

		const state = await run;

		expect(state.projection.activeLeaves).toEqual(["failed"]);
		expect(rejections).toEqual([]);
		expect(validations).toEqual([]);
	});

	it("replays stored verdicts without re-running the validator", async () => {
		const ast = validatedAst();
		const uid = actionUid(ast, "work");
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(uid, 1), complete(uid, "DONE", 2), validated(uid, "DONE", true, 3)],
			events: failOnPullEvents(),
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(runtime.effectBatches.flat().filter((effect) => effect.kind === "validate")).toEqual([]);
	});

	it("re-runs the validator when the log ends mid-validation", async () => {
		const ast = validatedAst();
		const uid = actionUid(ast, "work");
		const events: MachineEvent[] = [];
		const runtime = new MockRuntime({
			ast,
			// The claim was recorded but the verdict never landed (crash mid-validation).
			logs: [invoke(uid, 1), complete(uid, "DONE", 2)],
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "validate") {
						events.push({ kind: "validated", effectId: effect.id, outcome: true });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(runtime.effectBatches.flat().filter((effect) => effect.kind === "validate")).toHaveLength(1);
		// The claiming action itself was not restarted: its claim is being validated, not lost.
		expect(runtime.effectBatches.flat().filter((effect) => effect.kind === "agent")).toEqual([]);
	});

	it("invokes the initial action itself on a fresh log", async () => {
		const ast = linearAst();
		const events: MachineEvent[] = [];
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						events.push({ kind: "agent", effectId: effect.id, event: { type: "DONE" } });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		const records = runtime.effectBatches
			.flat()
			.flatMap((effect) => (effect.kind === "durable_records" ? [...effect.records] : []));
		expect(records.map((record) => (record.type === "state_action" ? record.kind : record.type))).toEqual([
			"invoke",
			"complete",
		]);
	});

	it("throws when the runtime queue closes before a final state is reached", async () => {
		const runtime = new MockRuntime({ ast: linearAst(), events: [] });

		await expect(loop(runtime)).rejects.toThrow("Event queue closed before reaching a final state");
	});

	it("does not dispatch a pending action effect twice", async () => {
		const ast = linearAst();
		const uid = actionUid(ast);
		const sessionRef: DurableLogRecord = { type: "session_ref", index: 0, file: "session.jsonl", ...meta(2) };
		// A neutral event that re-enters createMachineOutput while the action is still pending.
		const events: MachineEvent[] = [durableRecordsAdded([sessionRef], "noop")];
		const runtime = new MockRuntime({ ast, logs: [invoke(uid)], events });

		await expect(loop(runtime)).rejects.toThrow("Event queue closed before reaching a final state");

		const agentEffects = runtime.effectBatches.flat().filter((effect) => effect.kind === "agent");
		expect(agentEffects).toHaveLength(1);
	});

	it("logs the run arguments as the first fact and resolves inputs from facts", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "params-chart",
				initial: "plan",
				states: {
					plan: {
						kind: "state",
						action: agent("planner", {
							task: t`Plan a report on ${arg("topic")}.`,
							reply: jsonSchema({ type: "object", required: ["steps"], properties: {} }),
						}),
						transitions: { PLAN_READY: "build" },
					},
					build: {
						kind: "state",
						action: agent("builder", {
							task: t`Build a report on ${arg("topic")} following steps ${json(result("plan", "steps"))}.`,
							artifacts: { report: t`out/${arg("topic")}.html` },
						}),
						transitions: { BUILT: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) throw new Error("test chart should be valid");
		const ast = parsed.ast;
		const events: MachineEvent[] = [];
		const tasks: Record<string, unknown> = {};
		const outputs: Record<string, unknown> = {};
		const resultShapes: Record<string, unknown> = {};
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						tasks[effect.actionUid.state] = effect.task;
						outputs[effect.actionUid.state] = effect.artifacts;
						resultShapes[effect.actionUid.state] = effect.reply;
						const reply =
							effect.actionUid.state === "plan"
								? { type: "PLAN_READY", output: { steps: ["a", "b"] } }
								: { type: "BUILT" };
						events.push({ kind: "agent", effectId: effect.id, event: reply });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await start(runtime, { topic: "AI report" });

		expect(state.projection.activeLeaves).toEqual(["done"]);
		// args landed as the very first fact, seeded before the loop even started.
		const records = runtime.effectBatches
			.flat()
			.flatMap((effect) => (effect.kind === "durable_records" ? [...effect.records] : []));
		expect(records[0]).toEqual(expect.objectContaining({ type: "args", args: { topic: "AI report" } }));
		expect(records.filter((record) => record.type === "args")).toHaveLength(1);
		expect(state.projection.results.plan).toEqual({ steps: ["a", "b"] });
		// Templates arrive rendered: strings verbatim, non-strings as JSON — in every templated param.
		expect(tasks.plan).toBe("Plan a report on AI report.");
		expect(tasks.build).toBe('Build a report on AI report following steps ["a","b"].');
		expect(outputs.build).toEqual([{ name: "report", path: "out/AI report.html" }]);
		// The reply channel is a first-class part of the spawn request: the payload shape the
		// runtime should instruct and validate against.
		expect(resultShapes.plan).toEqual({
			kind: "jsonSchema",
			schema: { type: "object", required: ["steps"], properties: {} },
		});
		expect(resultShapes.build).toBeUndefined();
	});

	it("fileOf reads inherit the producer's rendered path and content shape", async () => {
		const shape = jsonSchema({ type: "object", required: ["claims"], properties: {} });
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "files-chart",
				initial: "writer",
				states: {
					writer: {
						kind: "state",
						action: agent("writer", { artifacts: { claims: artifact(t`out/${arg("topic")}.json`, shape) } }),
						transitions: { DONE: "reader" },
					},
					reader: {
						kind: "state",
						action: agent("reader", {
							reads: [artifactOf("writer"), artifactOf("writer", { artifact: "claims", select: "claims.approved" })],
						}),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) throw new Error("test chart should be valid");
		const events: MachineEvent[] = [];
		const outputs: Record<string, unknown> = {};
		const readsSeen: Record<string, unknown> = {};
		const runtime = new MockRuntime({
			ast: parsed.ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						outputs[effect.actionUid.state] = effect.artifacts;
						readsSeen[effect.actionUid.state] = effect.reads;
						events.push({ kind: "agent", effectId: effect.id, event: { type: "DONE" } });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await start(runtime, { topic: "ai" });

		expect(state.projection.activeLeaves).toEqual(["done"]);
		// The producer was told where to write and what shape; the consumer reads the SAME thing —
		// path re-rendered from the same facts, shape inherited from the declaration.
		expect(outputs.writer).toEqual([{ name: "claims", path: "out/ai.json", shape }]);
		// a plain read (single artifact resolved by name omission), and a narrowed read of one field
		expect(readsSeen.reader).toEqual([
			{ path: "out/ai.json", shape },
			{ path: "out/ai.json", shape, select: "claims.approved" },
		]);
	});

	it("rejects a non-primitive interpolation at the effect boundary", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "boundary-chart",
				initial: "plan",
				states: {
					plan: { kind: "state", action: agent("planner"), transitions: { PLAN_READY: "build" } },
					build: {
						kind: "state",
						// untyped ref: the object slips past TS but must not slip past the renderer
						action: agent("builder", { task: t`Build from ${result("plan")}` }),
						transitions: { BUILT: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) throw new Error("test chart should be valid");
		const events: MachineEvent[] = [];
		const runtime = new MockRuntime({
			ast: parsed.ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						events.push({ kind: "agent", effectId: effect.id, event: { type: "PLAN_READY", output: { steps: [] } } });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		await expect(loop(runtime)).rejects.toThrow(
			"result of 'plan' resolved to a non-primitive value; wrap the ref in json()",
		);
	});

	it("start over a non-empty log resumes without reseeding args", async () => {
		const ast = linearAst();
		const events: MachineEvent[] = [];
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(actionUid(ast))],
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						events.push({ kind: "agent", effectId: effect.id, event: { type: "DONE" } });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await start(runtime, { topic: "ignored" });

		expect(state.projection.activeLeaves).toEqual(["done"]);
		const records = runtime.effectBatches
			.flat()
			.flatMap((effect) => (effect.kind === "durable_records" ? [...effect.records] : []));
		expect(records.filter((record) => record.type === "args")).toEqual([]);
	});

	it("resolves the same input after a restart, reading args from the log", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "restart-chart",
				initial: "plan",
				states: {
					plan: { kind: "state", action: agent("planner"), transitions: { PLAN_READY: "build" } },
					build: {
						kind: "state",
						action: agent("builder", { task: t`Build ${arg("topic")} from plan ${result("plan")}` }),
						transitions: { BUILT: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) throw new Error("test chart should be valid");
		const ast = parsed.ast;
		const planUid = actionUid(ast, "plan");
		const buildUid = actionUid(ast, "build");
		// The process died while build's agent was running; note: no loadArgs on this runtime —
		// the args come from the log alone.
		const logs: DurableLogRecord[] = [
			{ type: "args", args: { topic: "AI report" }, ...meta(1) },
			invoke(planUid, 2),
			{
				type: "state_action",
				kind: "complete",
				actionUid: planUid,
				event: { type: "PLAN_READY", output: 42 },
				...meta(3),
			},
			invoke(buildUid, 4),
		];
		const events: MachineEvent[] = [];
		let buildTask: unknown;
		const runtime = new MockRuntime({
			ast,
			logs,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						buildTask = effect.task;
						events.push({ kind: "agent", effectId: effect.id, event: { type: "BUILT" } });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(buildTask).toBe("Build AI report from plan 42");
	});

	it("throws when the machine reports an error output", async () => {
		const ast = linearAst();
		const events: MachineEvent[] = [
			{ kind: "agent", effectId: "running:test-chart:start:agent:1", event: { type: "NOPE" } },
		];
		const runtime = new MockRuntime({ ast, logs: [invoke(actionUid(ast))], events });

		await expect(loop(runtime)).rejects.toThrow("No transition found for event type NOPE");
	});

	it("ignores a completion for an action that is not pending", async () => {
		const ast = linearAst();
		// A parseable effect id that matches no pending action: a completion that lost a race.
		const events: MachineEvent[] = [
			{ kind: "agent", effectId: "running:test-chart:other:agent:7", event: { type: "DONE" } },
		];
		const runtime = new MockRuntime({ ast, logs: [invoke(actionUid(ast))], events });

		await expect(loop(runtime)).rejects.toThrow("Event queue closed before reaching a final state");

		expect(runtime.effectBatches.flat().filter((effect) => effect.kind === "durable_records")).toEqual([]);
	});

	it("dispatches a deadline timer alongside the agent effect", async () => {
		const ast = afterAst();
		const uid = actionUid(ast, "work");
		const runtime = new MockRuntime({ ast, logs: [invoke(uid)], events: [] });

		await expect(loop(runtime)).rejects.toThrow("Event queue closed before reaching a final state");

		expect(runtime.effectBatches[0]).toEqual([
			expect.objectContaining({ kind: "agent", actionUid: uid }),
			expect.objectContaining({
				kind: "timer",
				id: "timer:timed-chart:work:agent:1",
				actionUid: uid,
				// invoke fact's timestamp (1) + delayMs (500)
				firesAt: 501,
			}),
		]);
	});

	it("records the expiry, cancels the agent and transitions when the timer fires", async () => {
		const ast = afterAst();
		const uid = actionUid(ast, "work");
		const events: MachineEvent[] = [];
		const cancels: Extract<Effect, { kind: "cancel" }>[] = [];
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(uid)],
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					// The agent effect is left hanging: the worker never answers.
					if (effect.kind === "timer") {
						events.push({ kind: "timer", effectId: effect.id });
					}
					if (effect.kind === "cancel") {
						cancels.push(effect);
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["escalated"]);
		expect(cancels).toEqual([expect.objectContaining({ kind: "cancel", actionUid: uid })]);
		const records = runtime.effectBatches
			.flat()
			.flatMap((effect) => (effect.kind === "durable_records" ? [...effect.records] : []));
		expect(records.map((record) => (record.type === "state_action" ? record.kind : record.type))).toEqual([
			"timer_fired",
		]);
	});

	it("ignores a stale timer from an earlier round", async () => {
		const ast = afterAst();
		const uid = actionUid(ast, "work");
		const events: MachineEvent[] = [{ kind: "timer", effectId: "timer:timed-chart:work:agent:99" }];
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(uid)],
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						events.push({ kind: "agent", effectId: effect.id, event: { type: "DONE" } });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(runtime.effectBatches.flat().filter((effect) => effect.kind === "cancel")).toEqual([]);
	});

	it("ignores a completion that lost the race to the timer", async () => {
		const ast = afterAst({ kind: "state", action: agent("escalation-handler"), transitions: { HANDLED: "done" } });
		const uid = actionUid(ast, "work");
		const events: MachineEvent[] = [];
		let workEffectId = "";
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(uid)],
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent" && effect.actionUid.state === "work") {
						// The worker hangs; remember its id to complete it too late.
						workEffectId = effect.id;
					}
					if (effect.kind === "agent" && effect.actionUid.state === "escalated") {
						events.push({ kind: "agent", effectId: effect.id, event: { type: "HANDLED" } });
					}
					if (effect.kind === "timer") {
						events.push({ kind: "timer", effectId: effect.id });
					}
					if (effect.kind === "cancel") {
						// The killed worker manages to report a completion after losing the race.
						events.push({ kind: "agent", effectId: workEffectId, event: { type: "DONE" } });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		const records = runtime.effectBatches
			.flat()
			.flatMap((effect) => (effect.kind === "durable_records" ? [...effect.records] : []));
		// The worker's late DONE left no trace: only the expiry and the escalation run are logged.
		expect(
			records.map((record) =>
				record.type === "state_action" ? `${record.kind}:${record.actionUid.state}` : record.type,
			),
		).toEqual(["timer_fired:work", "invoke:escalated", "complete:escalated"]);
	});

	it("replays a timer expiry without waiting", async () => {
		const ast = afterAst();
		const uid = actionUid(ast, "work");
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(uid, 1), timerFired(uid, 2)],
			events: failOnPullEvents(),
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["escalated"]);
		expect(runtime.effectBatches).toEqual([]);
	});

	it("drills down to the initial leaf and completes the compound through onDone", async () => {
		const ast = compoundAst();
		const events: MachineEvent[] = [];
		const sequence: string[] = [];
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						sequence.push(`agent:${effect.actionUid.state}`);
						events.push({ kind: "agent", effectId: effect.id, event: { type: "OK" } });
					}
					if (effect.kind === "durable_records") {
						for (const record of effect.records) {
							if (record.type === "state_action") sequence.push(`${record.kind}:${record.actionUid.state}`);
						}
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		// fix's OK lands on the nested final `verified`; the projection immediately exits the
		// compound through onDone — nothing extra is logged, no state is visited in between.
		expect(state.projection.activeLeaves).toEqual(["deploy"]);
		expect(sequence).toEqual([
			"invoke:review.analyze",
			"agent:review.analyze",
			"complete:review.analyze",
			"invoke:review.fix",
			"agent:review.fix",
			"complete:review.fix",
		]);
	});

	it("tells the agent which completion events the machine will accept", async () => {
		const ast = compoundAst();
		const runtime = new MockRuntime({ ast, logs: [invoke(actionUid(ast, "review.analyze"))], events: [] });

		await expect(loop(runtime)).rejects.toThrow("Event queue closed before reaching a final state");

		const [agentEffect] = runtime.effectBatches.flat().filter((effect) => effect.kind === "agent");
		// analyze's own OK plus the compound's bubbled FAILED, innermost first.
		expect(agentEffect?.events).toEqual(["OK", "FAILED"]);
	});

	it("bubbles an unhandled event to the ancestor's handler", async () => {
		const ast = compoundAst();
		const events: MachineEvent[] = [];
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						// analyze has no FAILED transition; the compound catches it.
						events.push({ kind: "agent", effectId: effect.id, event: { type: "FAILED" } });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["escalate"]);
	});

	it("replays a hierarchical log without re-running agents", async () => {
		const ast = compoundAst();
		const analyze = actionUid(ast, "review.analyze");
		const fix = actionUid(ast, "review.fix");
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(analyze, 1), complete(analyze, "OK", 2), invoke(fix, 3), complete(fix, "OK", 4)],
			events: failOnPullEvents(),
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["deploy"]);
		expect(runtime.effectBatches).toEqual([]);
	});

	it("runs all parallel regions concurrently and joins through onDone", async () => {
		const ast = parallelAst();
		const events: MachineEvent[] = [];
		const invoked: string[] = [];
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						invoked.push(effect.actionUid.state);
						events.push({ kind: "agent", effectId: effect.id, event: { type: "OK" } });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["merge"]);
		expect(invoked.sort()).toEqual(["audit.perf.scan", "audit.security.scan"]);
		expect(state.projection.pendingActions).toEqual([]);
	});

	it("aborts all regions and cancels their agents when an event exits the parallel", async () => {
		const ast = parallelAst();
		const events: MachineEvent[] = [];
		const cancels: Extract<Effect, { kind: "cancel" }>[] = [];
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent" && effect.actionUid.state === "audit.security.scan") {
						// security fails; perf's agent keeps hanging and must be killed.
						events.push({ kind: "agent", effectId: effect.id, event: { type: "FAILED" } });
					}
					if (effect.kind === "cancel") {
						cancels.push(effect);
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["escalate"]);
		expect(cancels).toEqual([
			expect.objectContaining({ kind: "cancel", actionUid: actionUid(ast, "audit.perf.scan") }),
		]);
	});

	it("replays a parallel log without re-running agents", async () => {
		const ast = parallelAst();
		const security = actionUid(ast, "audit.security.scan");
		const perf = actionUid(ast, "audit.perf.scan");
		const runtime = new MockRuntime({
			ast,
			// Region facts interleave in log order; the join fires when the last one lands.
			logs: [invoke(security, 1), invoke(perf, 2), complete(perf, "OK", 3), complete(security, "OK", 4)],
			events: failOnPullEvents(),
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["merge"]);
		expect(runtime.effectBatches).toEqual([]);
	});

	it("does not race validation against the deadline", async () => {
		const result = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "timed-chart",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: agent("coder"),
						after: { delayMs: 500, target: "escalated" },
						validate: tsImport("./checks.js", "testsPass"),
						transitions: { DONE: "done" },
					},
					done: final(),
					escalated: final(),
				},
			}),
		);
		if (!result.ok) throw new Error("test chart should be valid");
		const ast = result.ast;
		const uid = actionUid(ast, "work");
		const events: MachineEvent[] = [];
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(uid)],
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						events.push({ kind: "agent", effectId: effect.id, event: { type: "DONE" } });
					}
					if (effect.kind === "validate") {
						events.push({ kind: "validated", effectId: effect.id, outcome: true });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		// One timer for the running phase; validation is not raced against the clock.
		expect(runtime.effectBatches.flat().filter((effect) => effect.kind === "timer")).toHaveLength(1);
	});
});
