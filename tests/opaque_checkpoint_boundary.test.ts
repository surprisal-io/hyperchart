import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlLogStore, type LogStore, type OpaqueCheckpointEnvelope } from "../packages/hyperchart/src/runtime/generic/log_store.js";
import { MemoryLogStore } from "../packages/hyperchart/src/runtime/generic/memory_log_store.js";
import { BranchExecution } from "../packages/hyperchart/src/execution/branch_execution.js";
import { normalizeChartConfig } from "../packages/hyperchart/src/core/normalize.js";
import { chart, final } from "../packages/hyperchart/src/core/dsl.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function checkpoint(headSeqId: number): OpaqueCheckpointEnvelope {
	return { checkpointId: `checkpoint-${headSeqId}`, headSeqId, selectorKey: "opaque:test", blob: { private: true }, createdAt: 1 };
}

async function exercise(store: LogStore & { loadExactCheckpoint(input: { targetHeadSeqId: number | null; selectorKey: string }): Promise<OpaqueCheckpointEnvelope | undefined> }) {
	const order: string[] = [];
	const records = await store.appendDrafts([{ type: "args", args: {} }], (stamped) => {
		order.push(`prepare:${stamped[0]!.seqId}`);
		return { checkpoints: [checkpoint(stamped[0]!.seqId)], committed: () => order.push("committed") };
	});
	expect(order).toEqual([`prepare:${records[0]!.seqId}`, "committed"]);
	expect(await store.loadExactCheckpoint({ targetHeadSeqId: records[0]!.seqId, selectorKey: "opaque:test" })).toEqual(checkpoint(records[0]!.seqId));

	await expect(store.appendDrafts([{ type: "args", args: { rejected: true } }], () => { throw new Error("prepare failed"); })).rejects.toThrow("prepare failed");
	expect(await store.countRecords()).toBe(1);
}

describe("opaque stamped-commit boundary", () => {
	it("prepares before mutation and confirms after commit in memory", async () => {
		await exercise(new MemoryLogStore());
	});

	it("prepares before mutation and confirms after durable JSONL append", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-opaque-jsonl-")); roots.push(root);
		const store = new JsonlLogStore(join(root, "log.jsonl"));
		await store.initializeRootBranch();
		await exercise(store);
	});

	it.each(["memory", "jsonl"] as const)("rejects non-cloneable %s envelopes before journal mutation", async (kind) => {
		const store = kind === "memory"
			? new MemoryLogStore()
			: (() => { const root = mkdtempSync(join(tmpdir(), "hyperchart-noncloneable-")); roots.push(root); return new JsonlLogStore(join(root, "log.jsonl")); })();
		if (store instanceof JsonlLogStore) await store.initializeRootBranch();
		await expect(store.appendDrafts([{ type: "args", args: {} }], (records) => ({
			checkpoints: [{ ...checkpoint(records[0]!.seqId), blob: { fn: () => undefined } }],
			committed: () => { throw new Error("must not confirm"); },
		}))).rejects.toThrow();
		expect(await store.countRecords()).toBe(0);
		await expect(store.appendDrafts([{ type: "args", args: { usable: true } }])).resolves.toHaveLength(1);
	});

	it("serializes concurrent execution callbacks through one branch writer", async () => {
		const normalized = normalizeChartConfig(chart({ kind: "chart", id: "serialized", initial: "done", states: { done: final() } }));
		if (!normalized.ok) throw new Error("invalid test chart");
		const store = new MemoryLogStore();
		const semantic = await BranchExecution.restore({ ast: normalized.ast, branchId: "main", store });
		await Promise.all([
			store.appendDrafts([{ type: "args", args: { value: 1 } }], semantic.prepareStampedCommit),
			store.appendDrafts([{ type: "args", args: { value: 2 } }], semantic.prepareStampedCommit),
		]);
		expect(semantic.headSeqId()).toBe(3);
		expect(semantic.inspectionOverview().args).toEqual({ value: 2 });
	});

	it.each(["memory", "jsonl"] as const)("poisons %s after post-commit confirmation failure", async (kind) => {
		const store = kind === "memory"
			? new MemoryLogStore()
			: (() => { const root = mkdtempSync(join(tmpdir(), "hyperchart-confirm-")); roots.push(root); const value = new JsonlLogStore(join(root, "log.jsonl")); return value; })();
		if (store instanceof JsonlLogStore) await store.initializeRootBranch();
		await expect(store.appendDrafts([{ type: "args", args: {} }], () => ({ checkpoints: [], committed: () => { throw new Error("confirm failed"); } }))).rejects.toThrow("confirm failed");
		expect(await store.countRecords()).toBe(1);
		await expect(store.appendDrafts([{ type: "args", args: { late: true } }])).rejects.toThrow(/unusable/);
	});
});
