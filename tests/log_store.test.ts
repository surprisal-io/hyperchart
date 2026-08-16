import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableRecordDraft, StorageMutation } from "../packages/hyperchart/src/index.js";
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
	return { type: "state_action", kind: "invoke", actionUid, definition: { kind: "agent", uid: actionUid, name: "worker" } };
}

describe("JsonlLogStore branch journal", () => {
	it("rejects append before explicit root-branch initialization", async () => {
		const dir = await makeTempDir();
		const store = new JsonlLogStore(join(dir, "log.jsonl"));
		expect(() => store.appendDrafts([argsDraft()])).toThrow(/Unknown Hyperchart branch 'main'/);
	});

	it("creates main and atomically commits a stamped record batch", async () => {
		const dir = await makeTempDir();
		const file = join(dir, "runs", "log.jsonl");
		const store = new JsonlLogStore(file);
		store.initializeRootBranch();
		const records = store.appendDrafts([argsDraft(), invokeDraft()]);
		const normalized = await store.read();

		expect(normalized.branch("main").headSeqId).toBe(2);
		expect(normalized.nextSeqId).toBe(3);
		expect(normalized.ancestry("main")).toEqual(records);
		expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(2);
	});

	it("supports multiple named movable heads and global numbering after rewind", async () => {
		const dir = await makeTempDir();
		const file = join(dir, "log.jsonl");
		const main = new JsonlLogStore(file);
		main.initializeRootBranch();
		main.appendDrafts([argsDraft(), invokeDraft()]); // 1 -> 2, main
		main.createBranch("experiment", 1, { reason: "try sibling", sourceBranchId: "main", sourceSeqId: 1 });
		const experiment = new JsonlLogStore(file, () => {}, "experiment");
		const [sibling] = experiment.appendDrafts([invokeDraft()]); // 3, experiment
		main.moveBranch("main", 1);
		const [replacement] = main.appendDrafts([invokeDraft()]); // 4, main
		const normalized = await main.read();

		expect(sibling).toMatchObject({ seqId: 3, parentId: 1, branchId: "experiment" });
		expect(replacement).toMatchObject({ seqId: 4, parentId: 1, branchId: "main" });
		expect(normalized.records.map((record) => record.seqId)).toEqual([1, 2, 3, 4]);
		expect(normalized.ancestry("main").map((record) => record.seqId)).toEqual([1, 4]);
		expect(normalized.ancestry("experiment").map((record) => record.seqId)).toEqual([1, 3]);
	});

	it("rejects malformed journal entries", async () => {
		const dir = await makeTempDir();
		const file = join(dir, "log.jsonl");
		await writeFile(file, `${JSON.stringify({ unexpected: true })}\n`, "utf8");
		await expect(new JsonlLogStore(file).read()).rejects.toThrow(CorruptRunLogError);
	});

	it("physically discards only an unterminated trailing mutation before normalization", async () => {
		const dir = await makeTempDir();
		const warnings: string[] = [];
		const file = join(dir, "log.jsonl");
		const store = new JsonlLogStore(file);
		store.initializeRootBranch();
		store.appendDrafts([argsDraft()]);
		await writeFile(file, `${await readFile(file, "utf8")}{"kind":"branch"`, "utf8");
		const repaired = new JsonlLogStore(file, (message) => warnings.push(message));
		expect((await repaired.read()).records).toHaveLength(1);
		expect(warnings).toHaveLength(1);
		expect(await readFile(file, "utf8")).toMatch(/\n$/);
	});

	it("rejects append-from-non-head and dangling references during one-time normalization", () => {
		const mutations: StorageMutation[] = [
			{ kind: "branch", op: "create", branchId: "main", headSeqId: null, committedAt: 1 },
			{
				kind: "record_batch",
				branchId: "main",
				records: [{ type: "args", args: {}, seqId: 1, parentId: 99, branchId: "main", timestamp: 1 }],
				headSeqId: 1,
				committedAt: 1,
			},
		];
		expect(() => validateAndProjectJournal(mutations)).toThrow(/parentId 99 does not match branch head/);
	});

	it("serializes competing store instances without reusing ids or losing the head", async () => {
		const dir = await makeTempDir();
		const file = join(dir, "log.jsonl");
		const left = new JsonlLogStore(file);
		const right = new JsonlLogStore(file);
		left.initializeRootBranch();
		left.appendDrafts([argsDraft()]);
		const [a] = left.appendDrafts([invokeDraft()]);
		const [b] = right.appendDrafts([invokeDraft()]);
		expect([a?.seqId, b?.seqId]).toEqual([2, 3]);
		expect((await left.read()).branch("main").headSeqId).toBe(3);
	});
});
