import { describe, expect, it } from "vitest";
import { agent, chart, final, normalizeChartConfig, tsImport } from "../src/index.js";
import { loop } from "../src/core/execution_loop.js";
import type { ActionUID, ChartAst, DurableLogRecord, Effect, GuardOutcome, MachineEvent, StateId } from "../src/index.js";
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

		expect(state.projection.activeState).toBe("done");
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

		expect(state.projection.activeState).toBe("done");
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
		expect(state.projection.activeState).toBe("done");
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
		expect(state.projection.activeState).toBe("done");
		expect(state.projection.pendingActions).toEqual([]);
	});

	function runValidatedChart(outcomes: GuardOutcome[], options: { onReject?: "resume" | "restart"; claim?: string } = {}) {
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

		expect(state.projection.activeState).toBe("done");
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

		expect(state.projection.activeState).toBe("done");
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

		expect(state.projection.activeState).toBe("failed");
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

		expect(state.projection.activeState).toBe("done");
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

		expect(state.projection.activeState).toBe("done");
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

		expect(state.projection.activeState).toBe("done");
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

	it("throws when the machine reports an error output", async () => {
		const events: MachineEvent[] = [{ kind: "agent", effectId: "bogus:effect:id:0", event: { type: "DONE" } }];
		const runtime = new MockRuntime({ ast: linearAst(), events });

		await expect(loop(runtime)).rejects.toThrow("No pending action found for effectId bogus:effect:id:0");
	});
});
