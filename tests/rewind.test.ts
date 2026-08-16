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
	saveRunMeta(runDir, {
		chartPath,
		workDir: root,
		chartId: "quickstart",
		createdAt: new Date().toISOString(),
	});
	patchRunStatus(runDir, { runId: "run", branchId: "main", chartId: "quickstart", state: "stopped" });
	const store = new JsonlLogStore(join(runDir, "log.jsonl"));
	store.initializeRootBranch();
	return { root, runDir, store };
}

describe("append-only branch rewind", () => {
	it("forks without selecting/starting and moves a branch head without deleting the old tail", async () => {
		const { root, runDir, store } = await createStoppedRun();
		store.appendDrafts([
			{ type: "args", args: {} },
			{ type: "session_ref", index: 1, file: "one.jsonl" },
			{ type: "session_ref", index: 2, file: "two.jsonl" },
		]);
		const fork = await forkHyperchartRun({ runDir, fromSeqId: 2, branchId: "experiment", reason: "preserve B", cwd: root, sourceBranchId: "main" });
		expect(fork).toMatchObject({ selectedBranchChanged: false, started: false, branch: { branchId: "experiment", headSeqId: 2 } });
		const bytesBeforeCheckout = await readFile(join(runDir, "log.jsonl"), "utf8");
		await store.read();
		expect(await readFile(join(runDir, "log.jsonl"), "utf8")).toBe(bytesBeforeCheckout);

		const rewind = await rewindHyperchartRun({ runDir, branchId: "main", seqId: 2, mode: "after", cwd: root });
		expect(rewind).toMatchObject({ branchId: "main", previousHeadSeqId: 3, headSeqId: 2, preservedRecords: 3 });
		const replacement = store.appendDrafts([{ type: "session_ref", index: 3, file: "replacement.jsonl" }]);
		expect(replacement[0]).toMatchObject({ seqId: 4, parentId: 2, branchId: "main" });

		await rewindHyperchartRun({ runDir, branchId: "main", seqId: 3, mode: "after", cwd: root });
		const oldTailContinuation = store.appendDrafts([{ type: "session_ref", index: 4, file: "old-tail.jsonl" }]);
		expect(oldTailContinuation[0]).toMatchObject({ seqId: 5, parentId: 3, branchId: "main" });
		const normalized = await store.read();
		expect(normalized.records.map((record) => record.seqId)).toEqual([1, 2, 3, 4, 5]);
		expect(normalized.ancestry("main").map((record) => record.seqId)).toEqual([1, 2, 3, 5]);
		expect(normalized.ancestry("experiment").map((record) => record.seqId)).toEqual([1, 2]);
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
