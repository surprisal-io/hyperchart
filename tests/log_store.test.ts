import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableLogRecord } from "../packages/hyperchart/src/index.js";
import { JsonlLogStore, MemoryLogStore } from "../packages/hyperchart/src/runtime/generic/log_store.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hyperchart-log-store-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function argsRecord(seqId = 1, args: Readonly<Record<string, unknown>> = { topic: "test" }): DurableLogRecord {
	return { type: "args", args, parentId: null, seqId, timestamp: seqId * 100 };
}

function invokeRecord(seqId = 2): DurableLogRecord {
	const actionUid = { chart: "chart", state: "work", action: "agent" };
	return {
		type: "state_action",
		kind: "invoke",
		actionUid,
		definition: { kind: "agent", uid: actionUid, name: "worker" },
		parentId: seqId - 1,
		seqId,
		timestamp: seqId * 100,
	};
}

describe("MemoryLogStore", () => {
	it("appends synchronously and returns a snapshot", async () => {
		const store = new MemoryLogStore([argsRecord()]);
		store.append([invokeRecord()]);

		const firstRead = await store.readAll();
		expect(firstRead).toEqual([argsRecord(), invokeRecord()]);

		store.append([argsRecord(3, { topic: "later" })]);
		expect(firstRead).toEqual([argsRecord(), invokeRecord()]);
		await expect(store.readAll()).resolves.toEqual([argsRecord(), invokeRecord(), argsRecord(3, { topic: "later" })]);
	});
});

describe("JsonlLogStore", () => {
	it("round-trips appended records", async () => {
		const dir = await makeTempDir();
		const store = new JsonlLogStore(join(dir, "runs", "log.jsonl"));
		const records = [argsRecord(), invokeRecord()];

		store.append(records);

		await expect(store.readAll()).resolves.toEqual(records);
	});

	it("returns an empty log when the file does not exist", async () => {
		const dir = await makeTempDir();
		const store = new JsonlLogStore(join(dir, "missing.jsonl"));

		await expect(store.readAll()).resolves.toEqual([]);
	});

	it("parses a valid trailing line without a newline", async () => {
		const dir = await makeTempDir();
		const file = join(dir, "log.jsonl");
		await writeFile(file, JSON.stringify(argsRecord()), "utf8");
		const store = new JsonlLogStore(file);

		await expect(store.readAll()).resolves.toEqual([argsRecord()]);
	});

	it("drops an incomplete trailing line and warns", async () => {
		const dir = await makeTempDir();
		const warnings: string[] = [];
		const file = join(dir, "log.jsonl");
		await writeFile(file, `${JSON.stringify(argsRecord())}\n{"type":"args"`, "utf8");
		const store = new JsonlLogStore(file, (message) => warnings.push(message));

		await expect(store.readAll()).resolves.toEqual([argsRecord()]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Ignoring incomplete trailing JSONL record");
	});

	it("throws when a non-trailing line is corrupt", async () => {
		const dir = await makeTempDir();
		const file = join(dir, "log.jsonl");
		await writeFile(file, `${JSON.stringify(argsRecord())}\nnot-json\n${JSON.stringify(invokeRecord())}\n`, "utf8");
		const store = new JsonlLogStore(file);

		await expect(store.readAll()).rejects.toThrow(/Failed to parse durable log .*:2/);
	});
});
