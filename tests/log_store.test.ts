import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableRecordDraft, StorageEntry } from "../packages/hyperchart/src/index.js";
import {
	CorruptRunLogError,
	JsonlLogStore,
	validateAndProjectJournal,
} from "../packages/hyperchart/src/runtime/generic/log_store.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hyperchart-log-store-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function argsDraft(args: Readonly<Record<string, unknown>> = { topic: "test" }): DurableRecordDraft {
	return { type: "args", args };
}

function invokeDraft(): DurableRecordDraft {
	const actionUid = { chart: "chart", state: "work", action: "agent" };
	return { type: "state_action", kind: "invoke", sessionId: "session-id", actionUid, definition: { kind: "agent", uid: actionUid, name: "worker" } };
}

describe("JsonlLogStore branch journal", () => {
	it("owns filesystem run metadata through the store interface", async () => {
		const dir = await makeTempDir();
		const file = join(dir, "log.jsonl");
		const store = new JsonlLogStore(file);
		const meta = { chartPath: join(dir, "chart.ts"), workDir: dir, chartId: "file-meta", createdAt: new Date().toISOString() };
		await store.writeRunMeta(meta);
		expect(await store.readRunMeta()).toEqual(meta);
		await store.initializeRootBranch();
		await store.deleteRunData();
		expect(await store.readRunMeta()).toBeUndefined();
		expect(existsSync(file)).toBe(false);
	});

	it("rejects append before explicit root-branch initialization", async () => {
		const dir = await makeTempDir();
		const store = new JsonlLogStore(join(dir, "log.jsonl"));
		await expect(store.appendDrafts([argsDraft()])).rejects.toThrow(/Unknown Hyperchart branch 'main'/);
	});

	it("creates main and appends stamped records with one filesystem write", async () => {
		const dir = await makeTempDir();
		const file = join(dir, "runs", "log.jsonl");
		const store = new JsonlLogStore(file);
		await store.initializeRootBranch();
		const records = await store.appendDrafts([argsDraft(), invokeDraft()]);
		const normalized = await store.read();

		expect(normalized.branch("main").headSeqId).toBe(3);
		expect(normalized.nextSeqId).toBe(4);
		expect(normalized.ancestry("main")).toEqual(records);
		const persisted = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as unknown);
		expect(persisted).toEqual([expect.objectContaining({ kind: "branch", seqId: 1 }), ...records]);
	});

	it("supports multiple named movable heads and global numbering after rewind", async () => {
		const dir = await makeTempDir();
		const file = join(dir, "log.jsonl");
		const main = new JsonlLogStore(file);
		await main.initializeRootBranch();
		await main.appendDrafts([argsDraft(), invokeDraft()]); // 2 -> 3, main
		await main.createBranch("experiment", 2, { reason: "try sibling", sourceBranchId: "main", sourceSeqId: 2 }); // 4
		const experiment = main.forBranch("experiment");
		const [sibling] = await experiment.appendDrafts([invokeDraft()]); // 5, experiment
		await main.moveBranch("main", 2); // 6
		const [replacement] = await main.appendDrafts([invokeDraft()]); // 7, main
		const normalized = await main.read();

		expect(sibling).toMatchObject({ seqId: 5, parentId: 2, branchId: "experiment" });
		expect(replacement).toMatchObject({ seqId: 7, parentId: 2, branchId: "main" });
		expect(normalized.entries.map((entry) => entry.seqId)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(normalized.records.map((record) => record.seqId)).toEqual([2, 3, 5, 7]);
		expect(normalized.ancestry("main").map((record) => record.seqId)).toEqual([2, 7]);
		expect(normalized.ancestry("experiment").map((record) => record.seqId)).toEqual([2, 5]);
	});

	it("rejects malformed journal entries", async () => {
		const dir = await makeTempDir();
		const file = join(dir, "log.jsonl");
		await writeFile(file, `${JSON.stringify({ unexpected: true })}\n`, "utf8");
		await expect(new JsonlLogStore(file).read()).rejects.toThrow(CorruptRunLogError);
		expect(() => validateAndProjectJournal([
			{ kind: "branch", op: "create", seqId: 2, branchId: "main", headSeqId: null, committedAt: 1 },
		])).toThrow(/seqId 2 is not global next seqId 1/);
	});

	it("physically discards only an unterminated trailing entry before normalization", async () => {
		const dir = await makeTempDir();
		const warnings: string[] = [];
		const file = join(dir, "log.jsonl");
		const record = { type: "args", args: { topic: "test" }, seqId: 2, parentId: null, branchId: "main", timestamp: 1 };
		await writeFile(file, [
			JSON.stringify({ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 }),
			JSON.stringify(record),
		].join("\n") + "\n{\"kind\":\"branch\"", "utf8");
		const repaired = new JsonlLogStore(file, (message) => warnings.push(message));
		expect((await repaired.read()).records).toHaveLength(1);
		expect(warnings).toHaveLength(1);
		expect(await readFile(file, "utf8")).toMatch(/\n$/);
	});

	it("rejects append-from-non-head and dangling references during one-time normalization", () => {
		const entries: StorageEntry[] = [
			{ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 },
			{ type: "args", args: {}, seqId: 2, parentId: 99, branchId: "main", timestamp: 1 },
		];
		expect(() => validateAndProjectJournal(entries)).toThrow(/parentId 99 does not match branch head/);
	});

	it("serializes shared branch handles without reusing ids or losing the head", async () => {
		const dir = await makeTempDir();
		const file = join(dir, "log.jsonl");
		const left = new JsonlLogStore(file);
		const right = left.forBranch("main");
		await left.initializeRootBranch();
		await left.appendDrafts([argsDraft()]);
		const [a] = await left.appendDrafts([invokeDraft()]);
		const [b] = await right.appendDrafts([invokeDraft()]);
		expect([a?.seqId, b?.seqId]).toEqual([3, 4]);
		expect((await left.read()).branch("main").headSeqId).toBe(4);
	});

	it("rejects an independently opened stale writer instead of catching it up", async () => {
		const dir = await makeTempDir();
		const file = join(dir, "log.jsonl");
		const current = new JsonlLogStore(file);
		await current.initializeRootBranch();
		await current.appendDrafts([argsDraft()]);
		const stale = new JsonlLogStore(file);
		expect(stale.snapshot().nextSeqId).toBe(3);

		await current.appendDrafts([invokeDraft()]);
		await expect(stale.appendDrafts([invokeDraft()])).rejects.toThrow(/Stale Hyperchart journal writer/);

		const values = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as unknown);
		const final = validateAndProjectJournal(values);
		expect(final.records.map((record) => record.seqId)).toEqual([2, 3]);
		expect(final.branch("main").headSeqId).toBe(3);
	});

	it("opens once and incrementally updates one shared projection without snapshot cloning", async () => {
		const dir = await makeTempDir();
		const file = join(dir, "log.jsonl");
		const main = new JsonlLogStore(file);
		await main.initializeRootBranch();
		const projection = main.snapshot();
		const records = projection.records;
		const recordsBySeqId = projection.recordsBySeqId;
		const experiment = main.forBranch("main");
		for (let index = 0; index < 50; index++) await experiment.appendDrafts([invokeDraft()]);
		const after = main.snapshot();
		expect(main.fullReadCount()).toBe(1);
		expect(after).toBe(projection);
		expect(after.records).toBe(records);
		expect(after.recordsBySeqId).toBe(recordsBySeqId);
		expect(projection.recordsBySeqId.size).toBe(50);
		expect(projection.records).toHaveLength(50);
	});

	it("keeps an opened reader snapshot stable until the journal is reopened", async () => {
		const dir = await makeTempDir();
		const file = join(dir, "log.jsonl");
		const writer = new JsonlLogStore(file);
		await writer.initializeRootBranch();
		await writer.appendDrafts([argsDraft()]);
		const reader = new JsonlLogStore(file);
		expect(reader.snapshot().records).toHaveLength(1);
		await writer.appendDrafts([invokeDraft()]);
		expect(reader.snapshot().records).toHaveLength(1);
		expect(reader.fullReadCount()).toBe(1);
		expect(new JsonlLogStore(file).snapshot().records).toHaveLength(2);
	});

	it("concurrently appends through branch handles with global ids and independent heads", async () => {
		const dir = await makeTempDir();
		const file = join(dir, "log.jsonl");
		const main = new JsonlLogStore(file);
		await main.initializeRootBranch();
		await main.appendDrafts([argsDraft()]);
		await main.createBranch("experiment", 2);
		const experiment = main.forBranch("experiment");
		await Promise.all([
			Promise.resolve().then(() => main.appendDrafts([invokeDraft()])),
			Promise.resolve().then(() => experiment.appendDrafts([invokeDraft()])),
		]);
		const beforeMove = main.snapshot();
		const experimentHead = beforeMove.branch("experiment").headSeqId;
		await main.moveBranch("main", 2);
		const finalSnapshot = main.snapshot();
		expect(finalSnapshot.records.map((record) => record.seqId)).toEqual([2, 4, 5]);
		expect(finalSnapshot.ancestry("main").map((record) => record.seqId)).toEqual([2]);
		expect(finalSnapshot.branch("experiment").headSeqId).toBe(experimentHead);
		expect(finalSnapshot.ancestry("experiment").map((record) => record.seqId)).toEqual([2, experimentHead]);
		const values = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as unknown);
		expect(validateAndProjectJournal(values).records.map((record) => record.seqId)).toEqual([2, 4, 5]);
		expect(main.fullReadCount()).toBe(1);
	});

	it("rejects unknown and malformed user-interaction journal records", () => {
		const root = { kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 };
		const entry = (record: Record<string, unknown>) => ({ ...record, seqId: 2, parentId: null, branchId: "main", timestamp: 2 });
		expect(() => validateAndProjectJournal([root, entry({ type: "mystery" })])).toThrow(/known machine record type/);
		expect(() => validateAndProjectJournal([root, entry({ type: "user_interaction", kind: "opened", actionUid: { chart: "c", state: "s", action: "user" }, phaseSeqId: 1, prompt: 42, options: [], events: ["OK"] })])).toThrow(/prompt must be a string/);
		expect(() => validateAndProjectJournal([root, entry({ type: "user_interaction", kind: "resolved", actionUid: { chart: "c", state: "s", action: "user" }, gateSeqId: 1, event: {} })])).toThrow(/non-empty event type/);
		expect(() => validateAndProjectJournal([root, entry({ type: "user_interaction", kind: "opened", actionUid: { chart: "c", state: "s", action: "user" }, phaseSeqId: 1, prompt: "p", options: [], events: ["FAILED"] })])).toThrow(/non-FAILED/);
	});
});
