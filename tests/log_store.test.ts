import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableRecordDraft, StorageEntry } from "../packages/hyperchart/src/index.js";
import { JsonlLogStore } from "../packages/hyperchart/src/runtime/generic/log_store.js";

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
