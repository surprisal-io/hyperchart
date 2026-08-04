import { describe, expect, it } from "vitest";
import {
	agent,
	chart,
	final,
	loop,
	normalizeChartConfig,
	type DurableLogRecord,
	type Effect,
	type MachineEvent,
	type Runtime,
} from "../packages/hyperchart/src/index.js";
import { createAsyncQueue } from "../packages/hyperchart/src/utils/async_queue.js";

class FailureRuntime implements Runtime {
	readonly records: DurableLogRecord[] = [];
	readonly events = createAsyncQueue<MachineEvent>();
	cancelled = 0;
	readonly pendingAcknowledgements: Array<Extract<Effect, { kind: "cancel" }>> = [];
	constructor(readonly ast: Awaited<ReturnType<Runtime["loadAst"]>>, readonly autoAcknowledge = true) {}
	runEffects(effects: Effect[]): void {
		for (const effect of effects) {
			if (effect.kind === "durable_records") {
				this.records.push(...effect.records);
				this.events.send({ kind: "durable_records_added", effectId: effect.id, records: effect.records });
			} else if (effect.kind === "agent") {
				this.events.send({ kind: "agent", effectId: effect.id, event: { type: "FAILED", error: "boom" } });
			} else if (effect.kind === "cancel") {
				this.cancelled++;
				if (effect.requestId !== undefined && effect.target !== undefined) {
					this.pendingAcknowledgements.push(effect);
					if (this.autoAcknowledge) this.acknowledge(effect);
				}
			}
		}
	}
	acknowledge(effect: Extract<Effect, { kind: "cancel" }>) {
		if (effect.requestId === undefined || effect.target === undefined) throw new Error("not a durable cancellation");
		this.events.send({ kind: "cancellation_acknowledged", effectId: effect.id, requestId: effect.requestId, target: effect.target });
	}
	eventsQueue() { return this.events; }
	async loadAst() { return this.ast; }
	async loadLogs() { return this.records; }
}

describe("global failure quiescence", () => {
	it("durably records intent and cancellation request/ack before failed terminalization", async () => {
		const parsed = normalizeChartConfig(chart({
			kind: "chart", id: "failure-quiescence", initial: "work",
			states: {
				work: { kind: "state", action: agent("worker"), transitions: { DONE: "done" } },
				done: final(),
			},
		}));
		if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
		const runtime = new FailureRuntime(parsed.ast);
		const state = await loop(runtime);
		expect(state.projection.failure).toMatchObject({ origin: "work", error: "boom" });
		expect(runtime.cancelled).toBe(1);
		expect(runtime.records.map((record) => record.type)).toEqual([
			"state_action",
			"failure_intent",
			"cancellation",
			"cancellation",
		]);
		expect(Object.values(state.projection.cancellations)).toEqual([
			expect.objectContaining({ acknowledged: true }),
		]);
	});

	it("does not terminalize until a genuine executor acknowledgement arrives", async () => {
		const parsed = normalizeChartConfig(chart({
			kind: "chart", id: "delayed-failure-ack", initial: "work",
			states: {
				work: { kind: "state", action: agent("worker"), transitions: { DONE: "done" } },
				done: final(),
			},
		}));
		if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
		const runtime = new FailureRuntime(parsed.ast, false);
		let completed = false;
		const running = loop(runtime).then((state) => { completed = true; return state; });
		for (let turn = 0; turn < 20 && runtime.pendingAcknowledgements.length === 0; turn++) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		expect(runtime.pendingAcknowledgements).toHaveLength(1);
		expect(runtime.records.filter((record) => record.type === "cancellation").map((record) => record.kind)).toEqual(["requested"]);
		expect(completed).toBe(false);
		runtime.acknowledge(runtime.pendingAcknowledgements[0]!);
		const state = await running;
		expect(completed).toBe(true);
		expect(Object.values(state.projection.cancellations)).toEqual([expect.objectContaining({ acknowledged: true })]);
	});
});
