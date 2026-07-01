import { describe, expect, it } from "vitest";
import { agent, chart, final, normalizeChartConfig } from "../src/index.js";
import { loop } from "../src/core/execution_loop.js";
import type { ActionUID, ChartAst, DurableLogRecord, MachineEvent, StateId } from "../src/index.js";
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

function actionUid(ast: ChartAst, stateId: StateId = "start"): ActionUID {
	const state = ast.states[stateId];
	if (state?.kind !== "state") throw new Error(`state ${stateId} should be actionable`);
	return state.action.uid;
}

function meta(seqId: number) {
	return { seqId, parentId: null, timestamp: seqId };
}

function transition(source: StateId, target: StateId, seqId = 1): DurableLogRecord {
	return { type: "state_transition", kind: "simple", source, target, ...meta(seqId) };
}

function invoke(uid: ActionUID, seqId = 1): DurableLogRecord {
	return { type: "state_action", kind: "invoke", actionUid: uid, ...meta(seqId) };
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
		const runtime = new MockRuntime({
			ast: linearAst(),
			logs: [transition("start", "done")],
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
				id: "test-chart:start:agent:0",
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
								parentId: 1,
								seqId: 2,
								timestamp: expect.any(Number),
							}),
							expect.objectContaining({
								type: "state_transition",
								kind: "simple",
								source: "start",
								target: "done",
								parentId: 2,
								seqId: 3,
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

	it("runs two agent states in sequence through durable records", async () => {
		const ast = twoStepAst();
		const firstUid = actionUid(ast, "first");
		const secondUid = actionUid(ast, "second");
		const events: MachineEvent[] = [];
		const sequence: string[] = [];
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(firstUid)],
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
						const transitionRecord = effect.records.find((record) => record.type === "state_transition");
						if (transitionRecord?.type !== "state_transition" || transitionRecord.kind !== "simple") {
							throw new Error("expected simple transition record");
						}

						sequence.push(`durable:${transitionRecord.source}->${transitionRecord.target}`);
						const records: DurableLogRecord[] = [...effect.records];
						if (transitionRecord.target === "second") {
							records.push(invoke(secondUid, transitionRecord.seqId + 1));
						}
						events.push(durableRecordsAdded(records, effect.id));
						break;
					}
					default:
						throw new Error(`unexpected effect kind ${effect.kind}`);
				}
			},
		});

		const state = await loop(runtime);

		expect(sequence).toEqual(["agent:first", "durable:first->second", "agent:second", "durable:second->done"]);
		expect(state.projection.activeState).toBe("done");
		expect(state.projection.pendingActions).toEqual([]);
	});

	it("throws when the runtime queue closes before a final state is reached", async () => {
		const runtime = new MockRuntime({ ast: linearAst(), events: [] });

		await expect(loop(runtime)).rejects.toThrow("Event queue closed before reaching a final state");
	});
});
