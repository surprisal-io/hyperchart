import { collectHistoryRecords } from "./helpers/history.js";
import { seedMemoryLogStore } from "./helpers/memory_log_store.js";
import { commitUserInteractionResponse } from "./helpers/user_interaction_commit.js";
import { readdir, readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { actor, actorPool, agent, arg, artifact, call, chart, compound, final, map, message, parallel, protocol, receive, reply, t, user } from "../packages/hyperchart/src/core/dsl.js";
import { normalizeChartConfig } from "../packages/hyperchart/src/core/normalize.js";
import { createBranchProjection, projectBranch, type BranchProjection } from "../packages/hyperchart/src/core/projection.js";
import { compactProjection, compileProjectionRetention } from "../packages/hyperchart/src/execution/projection_retention.js";
import type { ChartAst, ChartCst } from "../packages/hyperchart/src/core/types.js";
import type { DurableLogRecord, DurableRecordDraft } from "../packages/hyperchart/src/core/durable_events.js";
import type { Effect, MachineEvent } from "../packages/hyperchart/src/core/machine.js";
import type { Runtime } from "../packages/hyperchart/src/runtime/runtime.js";
import { start } from "./helpers/execution.js";
import { createAsyncQueue } from "../packages/hyperchart/src/utils/async_queue.js";
import { z } from "zod";
import { JsonlLogStore, openExecutionReplay } from "../packages/hyperchart/src/runtime/generic/log_store.js";
import { MemoryLogStore } from "../packages/hyperchart/src/runtime/generic/memory_log_store.js";
import {
	EXECUTION_REPLAY_BATCH_RECORDS,
	PROJECTION_CHECKPOINT_INTERVAL,
	PROJECTOR_VERSION,
	chartAstDigest,
	decodeCheckpoint,
	encodeCheckpoint,
	loadBranchProjection,
	projectionContractForAst,
} from "../packages/hyperchart/src/execution/projection_restore.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

function ast(id = "checkpoint-chart"): ChartAst {
	const result = normalizeChartConfig(chart({ kind: "chart", id, initial: "done", states: { done: final() } }) as ChartCst);
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.ast;
}
function args(index: number): DurableRecordDraft { return { type: "args", args: { index } }; }
function fullyProject(chartAst: ChartAst, records: readonly DurableLogRecord[]) {
	const projection = projectBranch(createBranchProjection(chartAst), chartAst, records);
	compactProjection(projection, chartAst, compileProjectionRetention(chartAst));
	return projection;
}

function openInputGateAst(): ChartAst {
	const result = normalizeChartConfig(chart({ kind: "chart", id: "open-input-gate-checkpoint", initial: "ask", states: {
		ask: { kind: "state", input: { context: z.object({ id: z.string() }).default({ id: "default" }) }, action: user({ prompt: "Choose", options: ["CHOOSE"] }), transitions: { CHOOSE: "done" } },
		done: final(),
	} }) as ChartCst);
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.ast;
}

function bareMapAst(): ChartAst {
	const result = normalizeChartConfig(chart({ kind: "chart", id: "bare-map-checkpoint", initial: "jobs", states: {
		jobs: map({ over: arg("jobs"), initial: "finished", onDone: "done", states: { finished: final() } }), done: final(),
	} }) as ChartCst);
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.ast;
}

function mapOwnedActorAst(): ChartAst {
	const P = protocol({ RUN: message({ input: z.object({}).strict(), reply: z.object({ ok: z.boolean() }).strict() }) });
	const A = actor({ input: z.object({}).strict(), protocol: P, initial: "idle", states: { idle: receive({ on: { RUN: "reply" } }), reply: reply({ target: "idle", output: { ok: true } }) } });
	const endpoint = A({});
	const result = normalizeChartConfig(chart({ kind: "chart", id: "map-owned-actor-checkpoint", initial: "jobs", states: {
		jobs: map({ over: arg("jobs"), actors: { endpoint }, initial: "run", onDone: "done", states: { run: call({ to: endpoint, event: "RUN", input: {}, target: "finished" }), finished: final() } }), done: final(),
	} }) as ChartCst);
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.ast;
}

function structuralOwnedActorAst(owner: "compound" | "parallel" | "region"): ChartAst {
	const P = protocol({ RUN: message({ input: z.object({}).strict(), reply: z.object({ ok: z.boolean() }).strict() }) });
	const A = actor({ input: z.object({}).strict(), protocol: P, initial: "idle", states: { idle: receive({ on: { RUN: "reply" } }), reply: reply({ target: "idle", output: { ok: true } }) } });
	const endpoint = A({});
	const run = (target: string) => call({ to: endpoint, event: "RUN", input: {}, target });
	const container = owner === "compound"
		? compound({ actors: { endpoint }, initial: "run", onDone: "done", states: { run: run("finished"), finished: final() } })
		: owner === "parallel"
			? parallel({ actors: { endpoint }, onDone: "done", states: {
				a: compound({ initial: "run", states: { run: run("finished"), finished: final() } }),
				b: compound({ initial: "finished", states: { finished: final() } }),
			} })
			: parallel({ onDone: "done", states: {
				a: compound({ actors: { endpoint }, initial: "run", states: { run: run("finished"), finished: final() } }),
				b: compound({ initial: "finished", states: { finished: final() } }),
			} });
	const result = normalizeChartConfig(chart({ kind: "chart", id: `${owner}-owned-actor-checkpoint`, initial: "scope", states: { scope: container, done: final() } }) as ChartCst);
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.ast;
}

function representativeAst(): ChartAst {
	const ReplyProtocol = protocol({ RUN: message({ input: z.object({}).strict(), reply: z.object({ ok: z.boolean() }).strict() }) });
	const Worker = actor({ input: z.object({}).strict(), protocol: ReplyProtocol, initial: "idle", states: {
		idle: receive({ on: { RUN: "reply" } }), reply: reply({ target: "idle", output: { ok: true } }),
	} });
	const endpoint = Worker({}); const pool = actorPool({ concurrency: 2, worker: Worker })({});
	const result = normalizeChartConfig(chart({ kind: "chart", id: "checkpoint-representative", actors: { endpoint, pool }, initial: "build", states: {
		build: { kind: "state", action: agent("builder", { artifacts: { report: artifact(t`report.txt`) } }), transitions: { BUILT: "single" } },
		single: call({ to: endpoint, event: "RUN", input: {}, target: "pooled" }),
		pooled: call({ to: pool, event: "RUN", input: {}, target: "ask" }),
		ask: { kind: "state", action: user({ prompt: "Approve", options: ["APPROVE"] }), transitions: { APPROVE: "done" } },
		done: final(),
	} }) as ChartCst);
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.ast;
}

class RepresentativeRuntime implements Runtime {
	readonly branchId = "main";
	readonly queue = createAsyncQueue<MachineEvent>();
	constructor(readonly ast: ChartAst, readonly store: JsonlLogStore, readonly pauseActorReply = false) {}
	async runEffects(effects: Effect[]): Promise<void> {
		for (const effect of effects) {
			if (effect.kind === "durable_records") {
				const records = await this.store.appendDrafts(effect.records);
				this.queue.send({ kind: "durable_records_added", effectId: effect.id, records });
			} else if (effect.kind === "agent") {
				this.queue.send({ kind: "agent", effectId: effect.id, event: { type: "BUILT" }, artifacts: { "report.txt": { hash: "a".repeat(64), size: 12 } } });
			} else if (effect.kind === "actor_create") this.queue.send({ kind: "actor_effect", effectId: effect.id, operation: "create", ok: true });
			else if (effect.kind === "actor_enqueue") this.queue.send({ kind: "actor_effect", effectId: effect.id, operation: "enqueue", ok: true });
			else if (effect.kind === "actor_reply" && !this.pauseActorReply) this.queue.send({ kind: "actor_effect", effectId: effect.id, operation: "reply", ok: true });
		}
	}
	eventsQueue() { return this.queue; }
	async loadAst() { return this.ast; }
	async loadProjection() { return fullyProject(this.ast, await collectHistoryRecords(this.store, this.branchId)); }
}

async function waitForRecord<T extends DurableLogRecord>(store: JsonlLogStore, select: (record: DurableLogRecord) => record is T, message: string): Promise<T> {
	for (let attempt = 0; attempt < 2_000; attempt++) {
		const record = (await collectHistoryRecords(store, "main")).find(select);
		if (record !== undefined) return record;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(message);
}

async function waitForOpen(store: JsonlLogStore): Promise<Extract<DurableLogRecord, { type: "user_interaction"; kind: "opened" }>> {
	return waitForRecord(store, (entry): entry is Extract<DurableLogRecord, { type: "user_interaction"; kind: "opened" }> => entry.type === "user_interaction" && entry.kind === "opened", "representative execution did not open its gate");
}

it("digests canonical normalized ChartAst JSON independent of object insertion order", () => {
	const original = ast();
	const reordered = { ...original, states: Object.fromEntries(Object.entries(original.states).reverse()) } as ChartAst;
	expect(chartAstDigest(reordered)).toBe(chartAstDigest(original));
	expect(projectionContractForAst(original)).toEqual({ projectorVersion: PROJECTOR_VERSION, astDigest: expect.stringMatching(/^[a-f0-9]{64}$/), selectorKey: expect.stringMatching(/^hyperchart-projection:/) });
});

describe("projection checkpoint schema", () => {
	it("round-trips and restores an open gate with JSON-valid resolved input", async () => {
		const chartAst = openInputGateAst();
		const action = chartAst.states.ask;
		if (action?.kind !== "state" || action.action.kind !== "user") throw new Error("expected user action");
		const store = new MemoryLogStore();
		const records = await store.appendDrafts([
			{ type: "args", args: {} },
			{ type: "state_action", kind: "invoke", sessionId: "ask-session", actionUid: action.action.uid, input: { context: { id: "captured" } }, definition: action.action },
			{ type: "user_interaction", kind: "opened", actionUid: action.action.uid, phaseSeqId: 3, input: { context: { id: "captured" } }, prompt: "Choose", options: ["CHOOSE"], events: ["CHOOSE"] },
		]);
		const projection = fullyProject(chartAst, records);
		const contract = projectionContractForAst(chartAst);
		const encoded = encodeCheckpoint({ checkpointId: "open-input", headSeqId: records.at(-1)!.seqId, contract, projection, createdAt: 1 });
		expect(decodeCheckpoint(encoded, chartAst)?.projection.openUserInteractions[records.at(-1)!.seqId]?.opened.input).toEqual({ context: { id: "captured" } });
		await store.storeCheckpoint(encoded);
		const restored = await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract });
		expect(restored.replayedRecords).toBe(0);
		expect(restored.projection).toEqual(projection);

		const malformed = structuredClone(encoded);
		const opened = ((malformed.blob as { projection: { openUserInteractions: Record<string, { opened: Record<string, unknown> }> } }).projection.openUserInteractions[String(records.at(-1)!.seqId)]!.opened);
		opened.input = { invalid: Number.POSITIVE_INFINITY };
		expect(decodeCheckpoint(malformed, chartAst)).toBeUndefined();
	});

	it("rejects poisoned current-version nested projection families", () => {
		const chartAst = ast(); const contract = projectionContractForAst(chartAst);
		const encoded = encodeCheckpoint({ checkpointId: "base", headSeqId: null, contract, projection: createBranchProjection(chartAst), createdAt: 1 });
		const poisons: Array<(projection: Record<string, unknown>) => void> = [
			(projection) => { projection.pendingActions = [{}]; },
			(projection) => { projection.openUserInteractions = { 1: { status: "closed", opened: {} } }; },
			(projection) => { projection.artifactPins = { report: { hash: "not-sha256", size: 1 } }; },
			(projection) => { projection.actors = { bad: { declaration: "@bad", logicalOccurrence: "@bad", occurrence: "@bad", generation: 1, input: {}, definition: {}, currentState: "idle", mailbox: [null], status: "poisoned" } }; },
			(projection) => { projection.actorPools = { bad: { declaration: "@bad", logicalOccurrence: "@bad", occurrence: "@bad", generation: 1, input: {}, definition: {}, mailbox: [], workers: [{ index: 0, occurrence: "@bad.$worker-0", currentState: "idle", status: "poisoned" }], status: "idle" } }; },
			(projection) => { projection.pendingActorCalls = { bad: { kind: "singleton", callId: "c", callerState: "call", occurrence: "@bad", messageId: "m", status: "accepted", messages: [null] } }; },
		];
		for (const poison of poisons) {
			const candidate = structuredClone(encoded);
			poison((candidate.blob as { projection: Record<string, unknown> }).projection);
			expect(decodeCheckpoint(candidate)).toBeUndefined();
		}
	});

	it("isolates process-memory checkpoint reads from caller mutation", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hyperchart-checkpoint-isolation-")); dirs.push(dir);
		const jsonl = new JsonlLogStore(join(dir, "log.jsonl"));
		await jsonl.initializeRootBranch();
		const stores = [new MemoryLogStore(), jsonl];
		for (const store of stores) {
			const checkpoint = { checkpointId: "isolated", headSeqId: null, selectorKey: "test", blob: { nested: { value: 1 } }, createdAt: 1 };
			await store.storeCheckpoint(checkpoint);
			const first = await store.loadExactCheckpoint({ targetHeadSeqId: null, selectorKey: "test" });
			(first!.blob as { nested: { value: number } }).nested.value = 99;
			const second = await store.findNearestCheckpoint({ targetHeadSeqId: null, selectorKey: "test" });
			expect(second?.blob).toEqual({ nested: { value: 1 } });
		}
	});
});

describe("projection loader", () => {
	it("accepts a bare root-map leaf checkpoint before spawn", async () => {
		const chartAst = bareMapAst(); const store = new MemoryLogStore(); const contract = projectionContractForAst(chartAst);
		const projection = createBranchProjection(chartAst);
		expect(projection.activeLeaves).toEqual(["jobs"]);
		await store.storeCheckpoint(encodeCheckpoint({ checkpointId: "bare-map", headSeqId: null, contract, projection, createdAt: 1 }));
		const loaded = await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract });
		expect(loaded.projection).toEqual(projection);
		expect(loaded.checkpointSaved).toBe(false);
	});

	it("falls back from a matching root checkpoint with an unknown active leaf", async () => {
		const chartAst = ast(); const store = new MemoryLogStore(); const contract = projectionContractForAst(chartAst);
		const poisoned = createBranchProjection(chartAst); poisoned.activeLeaves = ["missing-state"];
		await store.storeCheckpoint(encodeCheckpoint({ checkpointId: "missing-root-leaf", headSeqId: null, contract, projection: poisoned, createdAt: 1 }));
		const loaded = await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract });
		expect(loaded.replayedRecords).toBe(0);
		expect(loaded.projection).toEqual(createBranchProjection(chartAst));
		expect(loaded.checkpointSaved).toBe(true);
	});

	it("is finite-log equivalent to compacted full replay and uses batches capped at 500", async () => {
		const store = new MemoryLogStore();
		const records = await store.appendDrafts(Array.from({ length: 1_203 }, (_, index) => args(index)));
		const chartAst = ast();
		const contract = projectionContractForAst(chartAst);
		const batchSizes: number[] = [];
		for await (const batch of openExecutionReplay(store, { targetHeadSeqId: records.at(-1)!.seqId, afterSeqId: null })) batchSizes.push(batch.length);
		const loaded = await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract });
		expect(loaded.projection).toEqual(fullyProject(chartAst, records));
		expect(PROJECTION_CHECKPOINT_INTERVAL).toBe(512);
		expect(loaded.replayedRecords).toBe(1_203);
		expect(loaded.replayBatches).toBe(3);
		expect(batchSizes).toEqual([500, 500, 203]);
		expect(Math.max(...batchSizes)).toBe(EXECUTION_REPLAY_BATCH_RECORDS);
		expect(loaded.checkpointSaved).toBe(true);

		const warm = await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract });
		expect(warm.replayedRecords).toBe(0);
		expect(warm.checkpointHeadSeqId).toBe(records.at(-1)!.seqId);

		await store.appendDrafts(Array.from({ length: PROJECTION_CHECKPOINT_INTERVAL - 1 }, (_, index) => args(2_000 + index)));
		const healthyTail = await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract });
		expect(healthyTail.replayedRecords).toBe(PROJECTION_CHECKPOINT_INTERVAL - 1);
		expect(healthyTail.replayBatches).toBe(2);
	});

	it("restores a representative execution-loop projection cold, warm, tail, and across a shared fork", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hyperchart-representative-loader-")); dirs.push(dir);
		const chartAst = representativeAst(); const store = new JsonlLogStore(join(dir, "log.jsonl")); await store.initializeRootBranch();
		const runtime = new RepresentativeRuntime(chartAst, store);
		const running = start(runtime, {});
		const opened = await waitForOpen(store);
		const contract = projectionContractForAst(chartAst);
		const openRecords = await collectHistoryRecords(store, "main");
		const referenceAtGate = fullyProject(chartAst, openRecords);
		expect(referenceAtGate.pendingActions).toHaveLength(1);
		expect(Object.keys(referenceAtGate.openUserInteractions)).toEqual([String(opened.seqId)]);
		expect(referenceAtGate.artifactPins["report.txt"]?.hash).toBe("a".repeat(64));
		expect(Object.keys(referenceAtGate.actors)).toHaveLength(1);
		expect(Object.keys(referenceAtGate.actorPools)).toHaveLength(1);

		const cold = await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract });
		expect(cold.projection).toEqual(referenceAtGate);
		const warm = await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract });
		expect(warm.replayedRecords).toBe(0);
		expect(warm.projection).toEqual(referenceAtGate);

		await store.createBranch("fork", opened.seqId);
		const forkStore = store.forBranch("fork");
		const forkCold = await loadBranchProjection({ ast: chartAst, branchId: "fork", store: forkStore, contract });
		expect(forkCold.replayedRecords).toBe(0);
		expect(forkCold.checkpointHeadSeqId).toBe(opened.seqId);
		expect(forkCold.projection).toEqual(referenceAtGate);

		const committed = await commitUserInteractionResponse(store, chartAst, opened.seqId, { type: "APPROVE" });
		runtime.queue.send({ kind: "durable_records_added", effectId: `test:${committed.record.seqId}`, records: [committed.record] });
		await running;
		const finalRecords = await collectHistoryRecords(store, "main");
		const finalReference = fullyProject(chartAst, finalRecords);
		const tail = await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract });
		expect(tail.replayedRecords).toBe(finalRecords.length - openRecords.length);
		expect(tail.projection).toEqual(finalReference);
	});

	it("falls back from invalid pending, endpoint, current-state, worker, and map coordinates", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hyperchart-coordinate-poison-")); dirs.push(dir);
		const chartAst = representativeAst(); const source = new JsonlLogStore(join(dir, "log.jsonl")); await source.initializeRootBranch();
		const runtime = new RepresentativeRuntime(chartAst, source); void start(runtime, {}); await waitForOpen(source);
		const records = await collectHistoryRecords(source, "main"); const reference = fullyProject(chartAst, records); const contract = projectionContractForAst(chartAst);
		type MutableProjection = {
			seqId: number;
			pendingActions: Array<{ actionUid: Record<string, unknown>; seqId: number }>;
			actors: Record<string, { declaration: string; currentState: string }>;
			actorPools: Record<string, { workers: Array<{ currentState: string }> }>;
		};
		const mutations: Array<(projection: MutableProjection) => void> = [
			(projection) => { (projection.pendingActions[0]!.actionUid as Record<string, unknown>).state = "missing-action"; },
			(projection) => { projection.pendingActions[0]!.seqId = projection.seqId + 1; },
			(projection) => { projection.actors[Object.keys(projection.actors)[0]!]!.declaration = "@missing"; },
			(projection) => { projection.actors[Object.keys(projection.actors)[0]!]!.currentState = "@endpoint.missing"; },
			(projection) => { projection.actorPools[Object.keys(projection.actorPools)[0]!]!.workers[0]!.currentState = "@pool.$worker-0.missing"; },
			(projection) => { const key = Object.keys(projection.actors)[0]!; projection.actors.wrong = projection.actors[key]!; delete projection.actors[key]; },
		];
		for (const [index, mutate] of mutations.entries()) {
			const store = await seedMemoryLogStore(records);
			const seededRecords = await collectHistoryRecords(store, "main");
			const seededReference = fullyProject(chartAst, seededRecords);
			const candidate = structuredClone(seededReference) as unknown as MutableProjection; mutate(candidate);
			await store.storeCheckpoint(encodeCheckpoint({ checkpointId: `coordinate-${index}`, headSeqId: seededRecords.at(-1)!.seqId, contract, projection: candidate as unknown as BranchProjection, createdAt: index + 1 }));
			const loaded = await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract });
			expect(loaded.replayedRecords).toBe(seededRecords.length);
			expect(loaded.projection).toEqual(seededReference);
		}
	});

	it("accepts valid map-owned actors and rejects root or nonexistent-instance owners", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hyperchart-map-owner-")); dirs.push(dir);
		const chartAst = mapOwnedActorAst(); const source = new JsonlLogStore(join(dir, "log.jsonl")); await source.initializeRootBranch();
		const runtime = new RepresentativeRuntime(chartAst, source); await start(runtime, { jobs: { a: {} } });
		const records = await collectHistoryRecords(source, "main"); const reference = fullyProject(chartAst, records); const contract = projectionContractForAst(chartAst);
		const endpoint = Object.values(reference.actors)[0]!;
		expect(endpoint.owner).toBe("jobs#a");
		const cold = await loadBranchProjection({ ast: chartAst, branchId: "main", store: source, contract });
		expect(cold.projection).toEqual(reference);
		const warm = await loadBranchProjection({ ast: chartAst, branchId: "main", store: source, contract });
		expect(warm.replayedRecords).toBe(0);

		for (const owner of ["arbitrary-root", "jobs#missing"]) {
			const store = await seedMemoryLogStore(records);
			const seededRecords = await collectHistoryRecords(store, "main");
			const seededReference = fullyProject(chartAst, seededRecords);
			const poisoned = structuredClone(seededReference);
			const actor = Object.values(poisoned.actors)[0]!; const oldKey = actor.occurrence;
			actor.owner = owner; actor.logicalOccurrence = `${owner}.@endpoint`; actor.occurrence = actor.logicalOccurrence;
			delete poisoned.actors[oldKey]; poisoned.actors[actor.occurrence] = actor;
			await store.storeCheckpoint(encodeCheckpoint({ checkpointId: `owner-${owner}`, headSeqId: seededRecords.at(-1)!.seqId, contract, projection: poisoned, createdAt: 1 }));
			const loaded = await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract });
			expect(loaded.replayedRecords).toBe(seededRecords.length);
			expect(loaded.projection).toEqual(seededReference);
		}
	});

	it("round-trips compound, parallel, and region-owned endpoints and rejects poisoned owners", async () => {
		for (const ownerKind of ["compound", "parallel", "region"] as const) {
			const dir = await mkdtemp(join(tmpdir(), `hyperchart-${ownerKind}-owner-`)); dirs.push(dir);
			const chartAst = structuralOwnedActorAst(ownerKind); const store = new JsonlLogStore(join(dir, "log.jsonl")); await store.initializeRootBranch();
			const runtime = new RepresentativeRuntime(chartAst, store); await start(runtime, {});
			const records = await collectHistoryRecords(store, "main"); const reference = fullyProject(chartAst, records); const contract = projectionContractForAst(chartAst);
			const endpoint = Object.values(reference.actors)[0]!;
			expect(endpoint.owner).toBe(ownerKind === "region" ? "scope.a" : "scope");
			const cold = await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract }); expect(cold.projection).toEqual(reference);
			const warm = await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract }); expect(warm.replayedRecords).toBe(0);

			const poisonStore = await seedMemoryLogStore(records);
			const seededRecords = await collectHistoryRecords(poisonStore, "main");
			const seededReference = fullyProject(chartAst, seededRecords);
			const poisoned = structuredClone(seededReference); const actor = Object.values(poisoned.actors)[0]!; const oldKey = actor.occurrence;
			actor.owner = `${endpoint.owner}.missing`; actor.logicalOccurrence = `${actor.owner}.${actor.declaration.split(".").at(-1)}`; actor.occurrence = actor.logicalOccurrence;
			delete poisoned.actors[oldKey]; poisoned.actors[actor.occurrence] = actor;
			await poisonStore.storeCheckpoint(encodeCheckpoint({ checkpointId: `poison-${ownerKind}`, headSeqId: seededRecords.at(-1)!.seqId, contract, projection: poisoned, createdAt: 1 }));
			const rebuilt = await loadBranchProjection({ ast: chartAst, branchId: "main", store: poisonStore, contract });
			expect(rebuilt.replayedRecords).toBe(seededRecords.length); expect(rebuilt.projection).toEqual(seededReference);
		}
	});

	it("round-trips a real in-flight actor call and message checkpoint", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hyperchart-pending-call-loader-")); dirs.push(dir);
		const chartAst = representativeAst(); const store = new JsonlLogStore(join(dir, "log.jsonl")); await store.initializeRootBranch();
		const runtime = new RepresentativeRuntime(chartAst, store, true);
		void start(runtime, {});
		await waitForRecord(store, (entry): entry is Extract<DurableLogRecord, { type: "actor_message"; kind: "accepted" }> => entry.type === "actor_message" && entry.kind === "accepted", "actor call was not accepted");
		const records = await collectHistoryRecords(store, "main"); const reference = fullyProject(chartAst, records);
		expect(Object.keys(reference.pendingActorCalls)).toHaveLength(1);
		const currentMessageId = Object.values(reference.actors)[0]?.currentMessageId;
		expect(currentMessageId === undefined ? undefined : reference.liveActorMessages[currentMessageId]?.status).toBe("accepted");
		expect(Object.values(reference.pendingActorCalls)[0]).not.toHaveProperty("messages");
		const contract = projectionContractForAst(chartAst);
		const cold = await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract });
		expect(cold.projection).toEqual(reference);
		const warm = await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract });
		expect(warm.replayedRecords).toBe(0);
		expect(warm.projection).toEqual(reference);

		const poisonStore = await seedMemoryLogStore(records);
		const poisoned = structuredClone(reference);
		delete poisoned.liveActorMessages[currentMessageId!];
		await poisonStore.storeCheckpoint(encodeCheckpoint({ checkpointId: "missing-canonical-message", headSeqId: records.at(-1)!.seqId, contract, projection: poisoned, createdAt: 1 }));
		const rebuilt = await loadBranchProjection({ ast: chartAst, branchId: "main", store: poisonStore, contract });
		expect(rebuilt.replayedRecords).toBe(records.length);
		expect(rebuilt.projection).toEqual(reference);
	});

	it("reuses the nearest shared-ancestry checkpoint across fork and rewind", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hyperchart-projection-loader-")); dirs.push(dir);
		const store = new JsonlLogStore(join(dir, "log.jsonl"));
		await store.initializeRootBranch();
		const prefix = await store.appendDrafts(Array.from({ length: 40 }, (_, index) => args(index)));
		const chartAst = ast(); const contract = projectionContractForAst(chartAst);
		await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract });
		await store.createBranch("fork", prefix.at(-1)!.seqId);
		const fork = store.forBranch("fork");
		const tail = await fork.appendDrafts(Array.from({ length: 17 }, (_, index) => args(100 + index)));
		const loadedFork = await loadBranchProjection({ ast: chartAst, branchId: "fork", store: fork, contract });
		expect(loadedFork.checkpointHeadSeqId).toBe(prefix.at(-1)!.seqId);
		expect(loadedFork.replayedRecords).toBe(tail.length);
		await store.moveBranch("fork", prefix.at(-1)!.seqId);
		const rewound = await loadBranchProjection({ ast: chartAst, branchId: "fork", store: fork, contract });
		expect(rewound.replayedRecords).toBe(0);
		expect(rewound.projection.args).toEqual({ index: 39 });
	});

	it("ignores malformed, incompatible, and non-ancestral cache rows without mutating the journal", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hyperchart-projection-loader-cache-")); dirs.push(dir);
		const file = join(dir, "log.jsonl"); const store = new JsonlLogStore(file);
		await store.initializeRootBranch();
		const [mainHead] = await store.appendDrafts([args(1)]);
		await store.createBranch("sibling", mainHead!.seqId);
		const [siblingHead] = await store.forBranch("sibling").appendDrafts([args(2)]);
		const chartAst = ast(); const contract = projectionContractForAst(chartAst);
		await store.storeCheckpoint({ checkpointId: "wrong-contract", headSeqId: mainHead!.seqId, selectorKey: `wrong:${contract.selectorKey}`, blob: {}, createdAt: 1 });
		await store.storeCheckpoint({ checkpointId: "sibling-only", headSeqId: siblingHead!.seqId, selectorKey: contract.selectorKey, blob: { schemaVersion: 1, projectorVersion: contract.projectorVersion, astDigest: contract.astDigest, projection: {} }, createdAt: 2 });
		const poisonedProjection = fullyProject(chartAst, await collectHistoryRecords(store, "main")) as unknown as Record<string, unknown>;
		poisonedProjection.pendingActions = [{}];
		await store.storeCheckpoint({ checkpointId: "malformed", headSeqId: mainHead!.seqId, selectorKey: contract.selectorKey, blob: { schemaVersion: 1, projectorVersion: contract.projectorVersion, astDigest: contract.astDigest, projection: poisonedProjection }, createdAt: 3 });
		const before = await readFile(file, "utf8");
		const loaded = await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract });
		expect(loaded.replayedRecords).toBe(1);
		expect(loaded.projection.args).toEqual({ index: 1 });
		const warm = await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract });
		expect(warm.replayedRecords).toBe(0);
		expect(await readFile(file, "utf8")).toBe(before);
		expect((await readdir(dir)).sort()).toEqual(["log.jsonl"]);

		const reopened = new JsonlLogStore(file);
		const rebuilt = await loadBranchProjection({ ast: chartAst, branchId: "main", store: reopened, contract });
		expect(rebuilt.replayedRecords).toBe(1);
		expect(await readFile(file, "utf8")).toBe(before);
	});

	it("aborts an incompatible rebuild without saving a checkpoint", async () => {
		const store = new MemoryLogStore(); const chartAst = ast(); const contract = projectionContractForAst(chartAst);
		await store.appendDrafts([{
			type: "state_action", kind: "complete",
			actionUid: { chart: chartAst.id, state: "done", action: "agent" },
			event: { type: "DONE" },
		}]);
		await expect(loadBranchProjection({ ast: chartAst, branchId: "main", store, contract })).rejects.toThrow();
		expect(await store.loadExactCheckpoint({ targetHeadSeqId: (await store.getBranch("main")).headSeqId, ...contract })).toBeUndefined();
	});

	it("rejects a caller contract that is not the supplied AST contract", async () => {
		const store = new MemoryLogStore(); const chartAst = ast();
		await expect(loadBranchProjection({ ast: chartAst, branchId: "main", store, contract: { projectorVersion: PROJECTOR_VERSION, astDigest: "0".repeat(64), selectorKey: "wrong" } })).rejects.toThrow(/does not match/);
	});
});
