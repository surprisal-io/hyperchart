import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableRecordDraft, StorageEntry } from "../packages/hyperchart/src/index.js";
import {
	HISTORY_READ_ITEMS,
	HistoryCursorError,
	JsonlLogStore,
	openProjectionReplay,
	type LogStore,
} from "../packages/hyperchart/src/runtime/generic/log_store.js";
import { MemoryLogStore } from "../packages/hyperchart/src/runtime/generic/memory_log_store.js";
import { PostgresLogStore } from "../packages/hyperchart/src/runtime/generic/postgres_log_store.js";
import * as runtimeExports from "../packages/hyperchart/src/runtime/index.js";

const tempDirs: string[] = [];
async function makeTempDir(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), "hyperchart-log-store-")); tempDirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
function argsDraft(args: Readonly<Record<string, unknown>> = { topic: "test" }): DurableRecordDraft { return { type: "args", args }; }
function invokeDraft(): DurableRecordDraft {
	const actionUid = { chart: "chart", state: "work", action: "agent" };
	return { type: "state_action", kind: "invoke", sessionId: "session-id", actionUid, definition: { kind: "agent", uid: actionUid, name: "worker" } };
}

async function persistedEntries(file: string): Promise<StorageEntry[]> {
	return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as StorageEntry);
}
function isBranchEntry(entry: StorageEntry): boolean { return "kind" in entry && entry.kind === "branch"; }

describe("runtime replay boundary", () => {
	it("does not expose projection replay through the public runtime or concrete stores", () => {
		expect("openProjectionReplay" in runtimeExports).toBe(false);
		expect("openProjectionReplay" in JsonlLogStore.prototype).toBe(false);
		expect("openProjectionReplay" in MemoryLogStore.prototype).toBe(false);
		expect("openProjectionReplay" in PostgresLogStore.prototype).toBe(false);
	});
});

describe("JsonlLogStore branch journal", () => {
	it("owns filesystem run metadata through the store interface", async () => {
		const dir = await makeTempDir(); const file = join(dir, "log.jsonl"); const store = new JsonlLogStore(file);
		const meta = { chartPath: join(dir, "chart.ts"), workDir: dir, chartId: "file-meta", createdAt: new Date().toISOString() };
		await store.writeRunMeta(meta); expect(await store.readRunMeta()).toEqual(meta);
		await store.initializeRootBranch(); await store.deleteRunData();
		expect(await store.readRunMeta()).toBeUndefined(); expect(existsSync(file)).toBe(false);
	});

	it("rejects append before explicit root-branch initialization", async () => {
		const store = new JsonlLogStore(join(await makeTempDir(), "log.jsonl"));
		await expect(store.appendDrafts([argsDraft()])).rejects.toThrow(/Unknown Hyperchart branch 'main'/);
	});

	it("creates main and appends stamped records with one filesystem write", async () => {
		const file = join(await makeTempDir(), "runs", "log.jsonl"); const store = new JsonlLogStore(file);
		await store.initializeRootBranch(); const records = await store.appendDrafts([argsDraft(), invokeDraft()]);
		expect((await store.getBranch("main")).headSeqId).toBe(3);
		expect(((await persistedEntries(file)).at(-1)?.seqId ?? 0) + 1).toBe(4);
		expect(await store.readAncestry("main")).toEqual(records);
		expect(await persistedEntries(file)).toEqual([expect.objectContaining({ kind: "branch", seqId: 1 }), ...records]);
	});

	it("supports multiple named movable heads and global numbering after rewind", async () => {
		const file = join(await makeTempDir(), "log.jsonl"); const main = new JsonlLogStore(file);
		await main.initializeRootBranch(); await main.appendDrafts([argsDraft(), invokeDraft()]);
		await main.createBranch("experiment", 2, { reason: "try sibling", sourceBranchId: "main", sourceSeqId: 2 });
		const [sibling] = await main.forBranch("experiment").appendDrafts([invokeDraft()]);
		await main.moveBranch("main", 2); const [replacement] = await main.appendDrafts([invokeDraft()]);
		expect(sibling).toMatchObject({ seqId: 5, parentId: 2, branchId: "experiment" });
		expect(replacement).toMatchObject({ seqId: 7, parentId: 2, branchId: "main" });
		expect((await persistedEntries(file)).map((entry) => entry.seqId)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect((await persistedEntries(file)).filter((entry) => !isBranchEntry(entry)).map((record) => record.seqId)).toEqual([2, 3, 5, 7]);
		expect((await main.readAncestry("main")).map((record) => record.seqId)).toEqual([2, 7]);
		expect((await main.readAncestry("experiment")).map((record) => record.seqId)).toEqual([2, 5]);
	});

	it("trusts parsed storage entries without globally validating their sequence", async () => {
		const file = join(await makeTempDir(), "log.jsonl");
		await writeFile(file, `${JSON.stringify({ kind: "branch", op: "create", seqId: 99, branchId: "main", headSeqId: null, committedAt: 1 })}\n`, "utf8");
		const store = new JsonlLogStore(file);
		expect((await store.getBranch("main")).headSeqId).toBeNull();
		const [record] = await store.appendDrafts([argsDraft()]);
		expect(record?.seqId).toBe(100);
	});

	it("fails on malformed JSON without modifying durable storage", async () => {
		const file = join(await makeTempDir(), "log.jsonl");
		const record = { type: "args", args: { topic: "test" }, seqId: 2, parentId: null, branchId: "main", timestamp: 1 };
		await writeFile(file, [JSON.stringify({ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 }), JSON.stringify(record)].join("\n") + "\n{\"kind\":\"branch\"", "utf8");
		const before = await readFile(file, "utf8");
		const reader = new JsonlLogStore(file);
		await expect(reader.countRecords()).rejects.toThrow(/JSON/);
		expect(await readFile(file, "utf8")).toBe(before);
	});

	it("serializes shared branch handles without reusing ids", async () => {
		const file = join(await makeTempDir(), "log.jsonl"); const left = new JsonlLogStore(file); const right = left.forBranch("main");
		await left.initializeRootBranch(); await left.appendDrafts([argsDraft()]);
		const [a] = await left.appendDrafts([invokeDraft()]); const [b] = await right.appendDrafts([invokeDraft()]);
		expect([a?.seqId, b?.seqId]).toEqual([3, 4]); expect((await left.getBranch("main")).headSeqId).toBe(4);
	});

	it("rejects an independently opened stale writer instead of catching it up", async () => {
		const file = join(await makeTempDir(), "log.jsonl"); const current = new JsonlLogStore(file);
		await current.initializeRootBranch(); await current.appendDrafts([argsDraft()]);
		const stale = new JsonlLogStore(file); expect((await stale.getBranch("main")).headSeqId).toBe(2);
		await current.appendDrafts([invokeDraft()]); await expect(stale.appendDrafts([invokeDraft()])).rejects.toThrow(/Stale Hyperchart journal writer/);
		const final = new JsonlLogStore(file);
		expect((await persistedEntries(file)).filter((entry) => !isBranchEntry(entry)).map((entry) => entry.seqId)).toEqual([2, 3]);
		expect((await final.getBranch("main")).headSeqId).toBe(3);
	});

	it("opens once and incrementally updates one private materialized index", async () => {
		const main = new JsonlLogStore(join(await makeTempDir(), "log.jsonl")); await main.initializeRootBranch();
		for (let index = 0; index < 50; index++) await main.appendDrafts([invokeDraft()]);
		expect(main.fullReadCount()).toBe(1); expect(await main.countRecords()).toBe(50);
		expect((await main.readAncestry("main")).length).toBe(50);
		expect((await main.readAncestry("main")).length).toBe(50);
	});

	it("keeps an opened reader view stable until the journal is reopened", async () => {
		const file = join(await makeTempDir(), "log.jsonl"); const writer = new JsonlLogStore(file);
		await writer.initializeRootBranch(); await writer.appendDrafts([argsDraft()]);
		const reader = new JsonlLogStore(file); expect(await reader.countRecords()).toBe(1);
		await writer.appendDrafts([invokeDraft()]); expect(await reader.countRecords()).toBe(1); expect(reader.fullReadCount()).toBe(1);
		expect(await new JsonlLogStore(file).countRecords()).toBe(2);
	});

	it("concurrently appends through branch handles with global ids and independent heads", async () => {
		const file = join(await makeTempDir(), "log.jsonl"); const main = new JsonlLogStore(file);
		await main.initializeRootBranch(); await main.appendDrafts([argsDraft()]); await main.createBranch("experiment", 2);
		const experiment = main.forBranch("experiment"); await Promise.all([main.appendDrafts([invokeDraft()]), experiment.appendDrafts([invokeDraft()])]);
		const experimentHead = (await main.getBranch("experiment")).headSeqId; await main.moveBranch("main", 2);
		expect((await persistedEntries(file)).filter((entry) => !isBranchEntry(entry)).map((record) => record.seqId)).toEqual([2, 4, 5]);
		expect((await main.readAncestry("main")).map((record) => record.seqId)).toEqual([2]);
		expect((await main.getBranch("experiment")).headSeqId).toBe(experimentHead);
		expect((await main.readAncestry("experiment")).map((record) => record.seqId)).toEqual([2, experimentHead]);
		expect(main.fullReadCount()).toBe(1);
	});
});

type HistoryTestStore = LogStore & { close?: () => Promise<void> };

async function historyStore(kind: "memory" | "jsonl"): Promise<HistoryTestStore> {
	if (kind === "memory") return new MemoryLogStore();
	const store = new JsonlLogStore(join(await makeTempDir(), "log.jsonl"));
	await store.initializeRootBranch();
	return store;
}

for (const backend of ["memory", "jsonl"] as const) {
	describe(`${backend} bounded history contract`, () => {
		it("pages older and newer in canonical newest-first order and pins the snapshot", async () => {
			const store = await historyStore(backend);
			const records = await store.appendDrafts(Array.from({ length: 230 }, () => invokeDraft()));
			const snapshot = await store.captureSnapshot("main");
			const first = await store.readStateVisits({ snapshot, state: "work" });
			expect(first.items).toHaveLength(HISTORY_READ_ITEMS);
			expect(first.items.map((item) => item.seqId)).toEqual(records.slice(-100).reverse().map((record) => record.seqId));
			expect(first.newer).toBeUndefined();
			expect(first.older).toBeTypeOf("string");

			const second = await store.readStateVisits({ snapshot, state: "work", cursor: first.older! });
			expect(second.items).toHaveLength(100);
			expect(second.older).toBeTypeOf("string");
			expect(second.newer).toBeTypeOf("string");
			const oldest = await store.readStateVisits({ snapshot, state: "work", cursor: second.older! });
			expect(oldest.items).toHaveLength(30);
			expect(oldest.older).toBeUndefined();
			const backToNewest = await store.readStateVisits({ snapshot, state: "work", cursor: second.newer! });
			expect(backToNewest.items.map((item) => item.seqId)).toEqual(first.items.map((item) => item.seqId));

			await store.appendDrafts(Array.from({ length: 5 }, () => invokeDraft()));
			const pinned = await store.readStateVisits({ snapshot, state: "work" });
			expect(pinned.items.map((item) => item.seqId)).toEqual(first.items.map((item) => item.seqId));
			expect((await store.captureSnapshot("main")).headSeqId).not.toBe(snapshot.headSeqId);
		});

		it("mints deep-link cursors and rejects snapshot, subject, and malformed cursor misuse", async () => {
			const store = await historyStore(backend);
			const records = await store.appendDrafts(Array.from({ length: 220 }, () => invokeDraft()));
			const snapshot = await store.captureSnapshot("main");
			const target = records[109]!.seqId;
			const cursor = await store.cursorAt({ snapshot, subject: { kind: "state-visits", state: "work" }, seqId: target });
			expect(cursor).toBeTypeOf("string");
			const centered = await store.readStateVisits({ snapshot, state: "work", cursor: cursor! });
			expect(centered.items[0]?.seqId).toBe(target);
			expect(centered.older).toBeTypeOf("string");
			expect(centered.newer).toBeTypeOf("string");
			expect(await store.cursorAt({ snapshot, subject: { kind: "state-visits", state: "other" }, seqId: target })).toBeUndefined();
			await expect(store.readRecords({ snapshot, cursor: cursor! })).rejects.toBeInstanceOf(HistoryCursorError);
			await expect(store.readStateVisits({ snapshot, state: "work", cursor: "not-a-cursor" })).rejects.toBeInstanceOf(HistoryCursorError);
			await store.appendDrafts([invokeDraft()]);
			await expect(store.readStateVisits({ snapshot: await store.captureSnapshot("main"), state: "work", cursor: cursor! })).rejects.toBeInstanceOf(HistoryCursorError);
		});

		it("streams projection ancestry oldest-first in fixed batches", async () => {
			const store = await historyStore(backend);
			const records = await store.appendDrafts(Array.from({ length: 1_201 }, () => invokeDraft()));
			const actual: number[][] = [];
			for await (const batch of openProjectionReplay(store, { targetHeadSeqId: records.at(-1)!.seqId, afterSeqId: null })) actual.push(batch.map((record) => record.seqId));
			expect(actual.map((batch) => batch.length)).toEqual([500, 500, 201]);
			expect(actual.flat()).toEqual(records.map((record) => record.seqId));
			const tail: number[] = [];
			for await (const batch of openProjectionReplay(store, { targetHeadSeqId: records.at(-1)!.seqId, afterSeqId: records[499]!.seqId })) tail.push(...batch.map((record) => record.seqId));
			expect(tail).toEqual(records.slice(500).map((record) => record.seqId));
			await expect((async () => {
				for await (const _batch of openProjectionReplay(store, { targetHeadSeqId: records.at(-1)!.seqId, afterSeqId: -1 })) { /* consume */ }
			})()).rejects.toThrow(/not in target ancestry/);
		});

		it("returns typed actor generation and message record groups", async () => {
			const store = await historyStore(backend);
			const message = { messageId: "message-1", event: "PING", input: { value: 1 }, producerState: "send", producerVisit: 1, batchIndex: 0 };
			const secondMessage = { ...message, messageId: "message-2", batchIndex: 1 };
			const drafts = [
				{ type: "actor_created", declaration: "@worker", occurrence: "@worker", generation: 1, input: {}, definition: {} as never },
				{ type: "actor_messages_enqueued", occurrence: "@worker", generation: 1, source: { producerState: "send", kind: "send", definition: {} as never, targetDeclaration: "@worker", event: "PING", inputSchema: {} as never }, messages: [message, secondMessage] },
				{ type: "actor_message", kind: "accepted", occurrence: "@worker", messageId: message.messageId, receiveState: "@worker.receive" },
				{ type: "actor_message", kind: "settled", occurrence: "@worker", messageId: message.messageId },
				{ type: "actor_batch_call_resolved", callId: "call-1", callerState: "send", messageIds: [message.messageId, secondMessage.messageId] },
				{ type: "actor_scope", kind: "stopped", occurrence: "@worker" },
				{ type: "actor_created", declaration: "@worker", occurrence: "@worker~2", generation: 2, input: {}, definition: {} as never },
			] satisfies DurableRecordDraft[];
			const records = await store.appendDrafts(drafts);
			const snapshot = await store.captureSnapshot("main");
			const generations = await store.readActorGenerations({ snapshot, logicalOccurrence: "@worker" });
			expect(generations.items.map((item) => item.created.generation)).toEqual([2, 1]);
			expect(generations.items[1]?.records.map((record) => record.seqId)).toEqual([records[0]!.seqId, records[1]!.seqId, records[2]!.seqId, records[3]!.seqId, records[5]!.seqId]);
			const messages = await store.readActorMessages({ snapshot, occurrence: "@worker" });
			expect(messages.items).toHaveLength(1);
			expect(messages.items[0]?.records.map((record) => record.seqId)).toEqual(records.slice(1, 5).map((record) => record.seqId));
			expect(messages.items[0]?.records.map((record) => record.seqId)).toEqual([...new Set(messages.items[0]?.records.map((record) => record.seqId))]);
			const cursor = await store.cursorAt({ snapshot, subject: { kind: "actor-messages", occurrence: "@worker" }, seqId: records[1]!.seqId });
			expect((await store.readActorMessages({ snapshot, occurrence: "@worker", cursor: cursor! })).items[0]?.seqId).toBe(records[1]!.seqId);
		});

		it("returns typed map visit record groups", async () => {
			const store = await historyStore(backend);
			const spawned: DurableRecordDraft[] = Array.from({ length: 3 }, (_, index) => ({ type: "spawned", path: "fanout", instances: { [`item-${index}`]: index } }));
			const records = await store.appendDrafts(spawned);
			const chunk = await store.readMapVisits({ snapshot: await store.captureSnapshot("main"), mapPath: "fanout" });
			expect(chunk.items.map((item) => item.spawn.seqId)).toEqual(records.map((record) => record.seqId).reverse());
			expect(chunk.items.every((item) => item.kind === "map-visit" && item.mapPath === "fanout")).toBe(true);
		});
	});
}

describe("JsonlLogStore branch keyset pagination and divergent snapshots", () => {
	it("paginates branches by immutable creation coordinate", async () => {
		const store = new JsonlLogStore(join(await makeTempDir(), "log.jsonl"));
		await store.initializeRootBranch();
		const [root] = await store.appendDrafts([argsDraft()]);
		for (let index = 0; index < 205; index++) await store.createBranch(`branch-${index.toString().padStart(3, "0")}`, root!.seqId);
		const first = await store.listBranches();
		expect(first.items).toHaveLength(100); expect(first.totalCount).toBe(206); expect(first.next).toBeTypeOf("string");
		await store.createBranch("late-branch", root!.seqId);
		const second = await store.listBranches(first.next);
		const third = await store.listBranches(second.next);
		expect(second.items).toHaveLength(100); expect(second.totalCount).toBe(207);
		expect(third.items).toHaveLength(7); expect(third.next).toBeUndefined();
		expect(new Set([...first.items, ...second.items, ...third.items].map((branch) => branch.branchId)).size).toBe(207);
	});

	it("keeps divergent captured heads independent after branch movement", async () => {
		const store = new JsonlLogStore(join(await makeTempDir(), "log.jsonl"));
		await store.initializeRootBranch();
		const [root] = await store.appendDrafts([argsDraft()]);
		await store.createBranch("experiment", root!.seqId);
		const mainRecords = await store.appendDrafts(Array.from({ length: 120 }, () => invokeDraft()));
		const experimentRecords = await store.forBranch("experiment").appendDrafts(Array.from({ length: 120 }, () => invokeDraft()));
		const mainSnapshot = await store.captureSnapshot("main");
		const experimentSnapshot = await store.captureSnapshot("experiment");
		await store.moveBranch("main", root!.seqId);
		expect((await store.readStateVisits({ snapshot: mainSnapshot, state: "work" })).items.map((item) => item.seqId)).toEqual(mainRecords.slice(-100).reverse().map((record) => record.seqId));
		expect((await store.readStateVisits({ snapshot: experimentSnapshot, state: "work" })).items.map((item) => item.seqId)).toEqual(experimentRecords.slice(-100).reverse().map((record) => record.seqId));
		expect(await store.containsInHistory({ headSeqId: mainSnapshot.headSeqId, seqId: experimentRecords[0]!.seqId })).toBe(false);
	});
});
