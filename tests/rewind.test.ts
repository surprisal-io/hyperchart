import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableLogRecord } from "../packages/hyperchart/src/core/durable_events.js";
import { forkHyperchartRun, listHyperchartBranches } from "../packages/hyperchart/src/runtime/generic/branches.js";
import { JsonlLogStore } from "../packages/hyperchart/src/runtime/generic/log_store.js";
import { saveRunMeta } from "../packages/hyperchart/src/runtime/generic/run_dir.js";
import { patchRunStatus } from "../packages/hyperchart/src/runtime/generic/run_status.js";
import { rewindHyperchartRun, semanticStatesForRecord } from "../packages/hyperchart/src/runtime/generic/rewind.js";

const tempDirs: string[] = [];
const stamp = (seqId: number) => ({ seqId, parentId: seqId === 1 ? null : seqId - 1, branchId: "main", timestamp: seqId });

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createStoppedRun() {
	const root = await mkdtemp(join(tmpdir(), "hyperchart-rewind-"));
	tempDirs.push(root);
	const runDir = join(root, "run");
	const chartPath = resolve("examples/quickstart.chart.ts");
	await saveRunMeta(runDir, {
		chartPath,
		workDir: root,
		chartId: "quickstart",
		createdAt: new Date().toISOString(),
	});
	patchRunStatus(runDir, { runId: "run", branchIds: ["main"], chartId: "quickstart", state: "stopped" });
	const store = new JsonlLogStore(join(runDir, "log.jsonl"));
	await store.initializeRootBranch();
	return { root, runDir, store };
}

describe("append-only branch rewind", () => {
	it("forks without selecting/starting and moves a branch head without deleting the old tail", async () => {
		const { root, runDir, store } = await createStoppedRun();
		await store.appendDrafts([
			{ type: "args", args: {} },
			{ type: "session_ref", index: 1, file: "one.jsonl" },
			{ type: "session_ref", index: 2, file: "two.jsonl" },
		]);
		const fork = await forkHyperchartRun({ runDir, fromSeqId: 3, branchId: "experiment", reason: "preserve B", cwd: root, sourceBranchId: "main" });
		expect(fork).toMatchObject({ selectedBranchChanged: false, started: false, branch: { branchId: "experiment", headSeqId: 3 } });
		const bytesBeforeCheckout = await readFile(join(runDir, "log.jsonl"), "utf8");
		await store.listBranches();
		expect(await readFile(join(runDir, "log.jsonl"), "utf8")).toBe(bytesBeforeCheckout);

		const rewind = await rewindHyperchartRun({ runDir, branchId: "main", seqId: 3, mode: "after", cwd: root });
		expect(rewind).toMatchObject({ branchId: "main", previousHeadSeqId: 4, headSeqId: 3, preservedRecords: 3 });
		// Reopen after a separate host operation; an opened journal never rereads itself.
		const replacementStore = new JsonlLogStore(join(runDir, "log.jsonl"));
		const replacement = await replacementStore.appendDrafts([{ type: "session_ref", index: 3, file: "replacement.jsonl" }]);
		expect(replacement[0]).toMatchObject({ seqId: 7, parentId: 3, branchId: "main" });

		await rewindHyperchartRun({ runDir, branchId: "main", seqId: 4, mode: "after", cwd: root });
		const continuationStore = new JsonlLogStore(join(runDir, "log.jsonl"));
		const oldTailContinuation = await continuationStore.appendDrafts([{ type: "session_ref", index: 4, file: "old-tail.jsonl" }]);
		expect(oldTailContinuation[0]).toMatchObject({ seqId: 9, parentId: 4, branchId: "main" });
		const storedEntries = (await readFile(join(runDir, "log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { kind?: string; seqId: number });
		expect(storedEntries.filter((entry) => entry.kind !== "branch").map((record) => record.seqId)).toEqual([2, 3, 4, 7, 9]);
		expect((await continuationStore.readAncestry("main")).map((record) => record.seqId)).toEqual([2, 3, 4, 9]);
		expect((await continuationStore.readAncestry("experiment")).map((record) => record.seqId)).toEqual([2, 3]);
		expect((await listHyperchartBranches(runDir)).map((branch) => branch.branchId)).toEqual(["main", "experiment"]);
		expect(await readFile(join(runDir, "log.jsonl"), "utf8")).not.toContain("rewind-backups");
	});
});

describe("rewind actor-pool state matching", () => {
	it("attributes accepted, replied, and settled facts to the concrete worker receive visit", () => {
		const records: DurableLogRecord[] = [
			{
				type: "actor_message",
				kind: "accepted",
				occurrence: "projects#a.@pool~2",
				messageId: "message-1",
				receiveState: "projects#a.@pool~2.$worker-1.alternateIdle",
				workerIndex: 1,
				...stamp(1),
			},
			{
				type: "actor_message",
				kind: "replied",
				occurrence: "projects#a.@pool~2",
				messageId: "message-1",
				message: "WORK",
				workerIndex: 1,
				...stamp(2),
			},
			{
				type: "actor_message",
				kind: "settled",
				occurrence: "projects#a.@pool~2",
				messageId: "message-1",
				workerIndex: 1,
				...stamp(3),
			},
		];

		for (const [index, record] of records.entries()) {
			expect(semanticStatesForRecord(record, records, index)).toEqual([
				"projects#a.@pool~2",
				"projects#a.@pool~2.$worker-1",
				"projects#a.@pool~2.$worker-1.alternateIdle",
			]);
		}
	});
});
