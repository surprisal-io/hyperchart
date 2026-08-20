import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
	actor,
	actorPool,
	agent,
	call,
	callBatch,
	chart,
	createBranchProjection,
	explainReplay,
	final,
	loop,
	message,
	messageInput,
	normalizeChartConfig,
	projectBranch,
	protocol,
	receive,
	reply,
	result,
	start,
	z,
	type DurableLogRecord,
	type Effect,
	type MachineEvent,
	type Runtime,
} from "../packages/hyperchart/src/index.js";
import { createAsyncQueue } from "../packages/hyperchart/src/utils/async_queue.js";
import { inspectChartAst } from "../packages/hyperchart/src/core/inspect_ast.js";
import { hyperchartRunFromRuntime } from "../packages/hyperchart/src/host/adapters.js";

const WorkProtocol = protocol({
	WORK: message({ input: z.object({ id: z.number() }).strict(), reply: z.object({ id: z.number() }).strict() }),
});
const Worker = actor({
	input: z.object({ lane: z.string() }).strict(),
	protocol: WorkProtocol,
	initial: "idle",
	states: {
		idle: receive({ on: { WORK: "work" } }),
		work: {
			kind: "state",
			action: agent("pool-worker", { reply: z.object({ id: z.number() }).strict() }),
			transitions: { DONE: "settle" },
		},
		settle: reply({ target: "idle", output: result("work") }),
	},
});

function parsed(input: unknown) {
	const result = normalizeChartConfig(input);
	assert(result.ok, result.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join("\n"));
	return result.ast;
}

class PoolRuntime implements Runtime {
	readonly branchId = "main";
	readonly records: DurableLogRecord[] = [];
	readonly effects: Effect[] = [];
	readonly queue = createAsyncQueue<MachineEvent>();
	constructor(readonly ast: ReturnType<typeof parsed>) {}
	async runEffects(effects: Effect[]): Promise<void> {
		this.effects.push(...effects);
		for (const effect of effects) {
			if (effect.kind === "durable_records") {
				let seqId = this.records.at(-1)?.seqId ?? 0;
				let parentId = seqId === 0 ? null : seqId;
				const records = effect.records.map((draft) => {
					const record = { ...draft, seqId: ++seqId, parentId, branchId: this.branchId, timestamp: Date.now() } as DurableLogRecord;
					parentId = record.seqId;
					return record;
				});
				this.records.push(...records);
				this.queue.send({ kind: "durable_records_added", effectId: effect.id, records });
			} else if (effect.kind === "actor_create") {
				this.queue.send({ kind: "actor_effect", effectId: effect.id, operation: "create", ok: true });
			} else if (effect.kind === "actor_enqueue") {
				this.queue.send({ kind: "actor_effect", effectId: effect.id, operation: "enqueue", ok: true });
			} else if (effect.kind === "actor_reply") {
				this.queue.send({ kind: "actor_effect", effectId: effect.id, operation: "reply", ok: true });
			}
		}
	}
	eventsQueue() { return this.queue; }
	async loadAst() { return this.ast; }
	async loadLogs() { return this.records; }
}

async function effectFor(runtime: PoolRuntime, state: string, visit: number) {
	for (let turn = 0; turn < 100; turn++) {
		const effects = runtime.effects.filter((effect): effect is Extract<Effect, { kind: "agent" }> => effect.kind === "agent" && effect.actionUid.state === state);
		if (effects[visit - 1] !== undefined) return effects[visit - 1]!;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`missing agent effect ${state} visit ${visit}`);
}

function completePoolWork(runtime: PoolRuntime, effect: Extract<Effect, { kind: "agent" }>): void {
	const match = /\$worker-(\d+)\./.exec(effect.actionUid.state);
	assert(match?.[1] !== undefined, `missing pool worker index in ${effect.actionUid.state}`);
	const workerIndex = Number(match[1]);
	const settled = new Set(runtime.records.flatMap((record) =>
		record.type === "actor_message" && record.kind === "settled" && record.workerIndex === workerIndex ? [record.messageId] : []));
	const accepted = [...runtime.records].reverse().find((record) =>
		record.type === "actor_message" && record.kind === "accepted" && record.workerIndex === workerIndex && !settled.has(record.messageId));
	assert(accepted?.type === "actor_message" && accepted.kind === "accepted", `worker ${workerIndex} has no accepted message`);
	const id = Number(accepted.messageId.split(":").at(-1));
	runtime.queue.send({ kind: "agent", effectId: effect.id, event: { type: "DONE", output: { id } } });
}

describe("static actor pools", () => {
	it("rejects a pool placement that no messaging state ever targets", () => {
		const Pool = actorPool({ concurrency: 2, worker: Worker });
		const workers = Pool({ lane: "unused" });
		const normalized = normalizeChartConfig(chart({ kind: "chart", id: "unused-pool", actors: { workers }, initial: "done", states: { done: final() } }));
		expect(normalized.ok).toBe(false);
		if (!normalized.ok) expect(normalized.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "UNUSED_ACTOR", path: "/actors/workers" })]));
	});

	it("durably assigns FIFO heads to eligible persistent workers and resolves callBatch in input order", async () => {
		const Pool = actorPool({ concurrency: 2, worker: Worker });
		const workers = Pool({ lane: "edit" });
		const ast = parsed(chart({
			kind: "chart",
			id: "pool-call-batch",
			actors: { workers },
			initial: "work",
			states: {
				work: callBatch({ to: workers, event: "WORK", inputs: [{ id: 0 }, { id: 1 }, { id: 2 }], target: "done" }),
				done: final(),
			},
		}));
		const declaration = ast.actors["@workers"];
		expect(declaration).toMatchObject({ kind: "actorPool", concurrency: 2, worker: { initial: "idle" } });
		if (declaration?.kind !== "actorPool") throw new Error("missing normalized pool");
		const declaredWork = declaration.worker.states.work;
		if (declaredWork?.kind !== "state") throw new Error("missing normalized worker action");
		expect(declaredWork.action.uid.state).toBe("@workers.$worker.work");

		const runtime = new PoolRuntime(ast);
		const running = start(runtime, {});
		const worker0 = await effectFor(runtime, "@workers.$worker-0.work", 1);
		const worker1First = await effectFor(runtime, "@workers.$worker-1.work", 1);

		// Finish worker 1 first. It becomes the only idle slot and is persistently reused.
		completePoolWork(runtime, worker1First);
		const worker1Second = await effectFor(runtime, "@workers.$worker-1.work", 2);
		completePoolWork(runtime, worker1Second);
		completePoolWork(runtime, worker0);

		const state = await running;
		expect(state.projection.results.work).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }]);
		expect(state.projection.actorPools["@workers"]).toMatchObject({ status: "stopped", workers: [{ index: 0, currentState: "idle" }, { index: 1, currentState: "idle" }] });
		const accepted = runtime.records.filter((record): record is Extract<DurableLogRecord, { type: "actor_message"; kind: "accepted" }> => record.type === "actor_message" && record.kind === "accepted");
		expect(new Set(accepted.slice(0, 2).map((record) => record.workerIndex))).toEqual(new Set([0, 1]));
		expect(accepted[2]?.workerIndex).toBe(1);
		expect(runtime.records.filter((record) => record.type === "actor_batch_call_resolved")).toEqual([
			expect.objectContaining({ callerState: "work", messageIds: ["work:message:1:0", "work:message:1:1", "work:message:1:2"] }),
		]);
		const host = hyperchartRunFromRuntime(inspectChartAst(ast), ast, runtime.records);
		expect(host.actorOccurrences?.[0]).toMatchObject({ kind: "actorPool", concurrency: 2, activeCount: 0, idleCount: 2, workers: [{ index: 0, occurrencePath: "@workers.$worker-0" }, { index: 1, occurrencePath: "@workers.$worker-1" }] });
		const replayed = projectBranch(createBranchProjection(ast), ast, structuredClone(runtime.records));
		expect(replayed.actorPools).toEqual(state.projection.actorPools);
		expect(explainReplay(ast, runtime.records)).toMatchObject({ prefixEnd: runtime.records.length, stale: [], skipped: [] });

		const enqueueIndex = runtime.records.findIndex((record) => record.type === "actor_messages_enqueued" && record.occurrence === "@workers");
		assert(enqueueIndex >= 0);
		const legalNonLowest = structuredClone(runtime.records.slice(0, enqueueIndex + 1));
		const firstAccepted = runtime.records.find((record) => record.type === "actor_message" && record.kind === "accepted" && record.occurrence === "@workers");
		assert(firstAccepted?.type === "actor_message" && firstAccepted.kind === "accepted");
		legalNonLowest.push({ ...structuredClone(firstAccepted), workerIndex: 1, receiveState: "@workers.$worker-1.idle" });
		const restamp = (records: DurableLogRecord[]) => records.map((record, index) => ({ ...record, seqId: index + 1, parentId: index === 0 ? null : index, branchId: "main", timestamp: index + 1 }));
		expect(explainReplay(ast, restamp(legalNonLowest))).toMatchObject({ prefixEnd: legalNonLowest.length, stale: [], skipped: [] });

		const duplicateWorker = structuredClone(runtime.records);
		const firstWave = duplicateWorker.filter((record): record is Extract<DurableLogRecord, { type: "actor_message"; kind: "accepted" }> => record.type === "actor_message" && record.kind === "accepted").slice(0, 2);
		assert(firstWave[0] !== undefined && firstWave[1] !== undefined);
		const occupiedWorker = firstWave[0].workerIndex;
		assert(occupiedWorker !== undefined);
		firstWave[1].workerIndex = occupiedWorker;
		firstWave[1].receiveState = firstWave[0].receiveState;
		expect(explainReplay(ast, duplicateWorker).broken?.error).toContain("already owns a current message");
		const reordered = structuredClone(runtime.records);
		const acceptedIndexes = reordered.flatMap((record, index) => record.type === "actor_message" && record.kind === "accepted" ? [index] : []);
		assert(acceptedIndexes[0] !== undefined && acceptedIndexes[1] !== undefined);
		[reordered[acceptedIndexes[0]], reordered[acceptedIndexes[1]]] = [reordered[acceptedIndexes[1]]!, reordered[acceptedIndexes[0]]!];
		expect(explainReplay(ast, restamp(reordered)).broken?.error).toContain("FIFO head");

		const replyMismatch = structuredClone(runtime.records);
		const workerOneReply = replyMismatch.find((record) => record.type === "actor_message" && record.kind === "replied" && record.workerIndex === 1);
		assert(workerOneReply?.type === "actor_message" && workerOneReply.kind === "replied");
		workerOneReply.workerIndex = 0;
		expect(explainReplay(ast, replyMismatch).broken?.error).toContain("does not own");

		const premature = structuredClone(runtime.records);
		const resolutionIndex = premature.findIndex((record) => record.type === "actor_batch_call_resolved");
		const lastSettlementIndex = premature.length - 1 - [...premature].reverse().findIndex((record) => record.type === "actor_message" && record.kind === "settled");
		assert(resolutionIndex > 0 && lastSettlementIndex > 0);
		const [resolution] = premature.splice(resolutionIndex, 1);
		assert(resolution !== undefined);
		premature.splice(lastSettlementIndex, 0, resolution);
		expect(explainReplay(ast, restamp(premature)).broken?.error).toContain("before all items settled");

		const wrongMembership = structuredClone(runtime.records);
		const batchResolution = wrongMembership.find((record) => record.type === "actor_batch_call_resolved");
		assert(batchResolution?.type === "actor_batch_call_resolved");
		batchResolution.messageIds = [...batchResolution.messageIds].reverse();
		expect(explainReplay(ast, wrongMembership).broken?.error).toContain("order or membership changed");
	});

	it("uses pool-local in-flight reservations across concurrent settlements without a global append lock", async () => {
		const Pool = actorPool({ concurrency: 2, worker: Worker });
		const workers = Pool({ lane: "edit" });
		const ast = parsed(chart({
			kind: "chart", id: "pool-concurrent-settlements", actors: { workers }, initial: "work",
			states: { work: callBatch({ to: workers, event: "WORK", inputs: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }], target: "done" }), done: final() },
		}));
		const runtime = new PoolRuntime(ast);
		const running = start(runtime, {});
		const worker0First = await effectFor(runtime, "@workers.$worker-0.work", 1);
		const worker1First = await effectFor(runtime, "@workers.$worker-1.work", 1);
		// Both completions are already queued before either settlement feedback is projected.
		completePoolWork(runtime, worker1First);
		completePoolWork(runtime, worker0First);
		const worker0Second = await effectFor(runtime, "@workers.$worker-0.work", 2);
		const worker1Second = await effectFor(runtime, "@workers.$worker-1.work", 2);
		completePoolWork(runtime, worker1Second);
		completePoolWork(runtime, worker0Second);
		const state = await running;
		expect(state.projection.results.work).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }]);
		const accepted = runtime.records.filter((record): record is Extract<DurableLogRecord, { type: "actor_message"; kind: "accepted" }> => record.type === "actor_message" && record.kind === "accepted");
		expect(accepted.map((record) => record.messageId)).toEqual(["work:message:1:0", "work:message:1:1", "work:message:1:2", "work:message:1:3"]);
		expect(new Set(accepted.slice(0, 2).map((record) => record.workerIndex))).toEqual(new Set([0, 1]));
		expect(new Set(accepted.slice(2, 4).map((record) => record.workerIndex))).toEqual(new Set([0, 1]));
		expect(explainReplay(ast, runtime.records)).toMatchObject({ prefixEnd: runtime.records.length, stale: [], skipped: [] });
	});

	it("keeps singleton call semantics when the endpoint is a pool", async () => {
		const Direct = actor({
			input: z.object({}).strict(), protocol: WorkProtocol, initial: "idle",
			states: { idle: receive({ on: { WORK: "settle" } }), settle: reply({ target: "idle", output: messageInput("WORK") }) },
		});
		const Pool = actorPool({ concurrency: 1, worker: Direct });
		const worker = Pool({});
		const ast = parsed(chart({ kind: "chart", id: "pool-singleton-call", actors: { worker }, initial: "call", states: { call: call({ to: worker, event: "WORK", input: { id: 7 }, target: "done" }), done: final() } }));
		const runtime = new PoolRuntime(ast);
		const state = await loop(runtime);
		expect(state.projection.results.call).toEqual({ id: 7 });
		expect(runtime.records.some((record) => record.type === "actor_call_resolved")).toBe(true);
	});
});
