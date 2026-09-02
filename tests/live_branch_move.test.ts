import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEffect, RejectedEffect } from "../packages/hyperchart/src/core/machine.js";
import type { ActionUID, ChartEvent } from "../packages/hyperchart/src/core/types.js";
import { JsonlLogStore } from "../packages/hyperchart/src/runtime/generic/log_store.js";
import {
	BranchSealedError,
	createHyperchartRunnerController,
	type HyperchartRunnerController,
	type SteerableAgentExecutor,
} from "../packages/hyperchart/src/runner/runner_main.js";
import type { StorageEntry } from "../packages/hyperchart/src/core/durable_events.js";
import { collectHistoryRecords } from "./helpers/history.js";

const roots: string[] = [];
const originalCwd = process.cwd();
const originalExitCode = process.exitCode;

afterEach(() => {
	process.chdir(originalCwd);
	process.exitCode = originalExitCode;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Deferred = { promise: Promise<void>; resolve(): void };
function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for runner state");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function branchView(runDir: string, branchId: string) {
	const store = new JsonlLogStore(join(runDir, "log.jsonl"), branchId);
	try {
		const branch = await store.getBranch(branchId);
		return { branch, records: await collectHistoryRecords(store, branchId) };
	} finally { await store.close(); }
}

function storageEntries(runDir: string): StorageEntry[] {
	return readFileSync(join(runDir, "log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as StorageEntry);
}

class PausingExecutor implements SteerableAgentExecutor {
	emit?: (event: ChartEvent) => void;
	readonly disposalStarted = deferred();
	constructor(readonly branchId: string, private readonly disposeGate?: Promise<void>) {}
	start(_effect: AgentEffect, emit: (event: ChartEvent) => void): void { this.emit = emit; }
	reject(_effect: RejectedEffect, emit: (event: ChartEvent) => void): void { this.emit = emit; }
	async cancel(_actionUid: ActionUID): Promise<void> {}
	async dispose(): Promise<void> { this.disposalStarted.resolve(); await this.disposeGate; }
	async steer(): Promise<boolean> { return false; }
	complete(): void { this.emit?.({ type: "DONE" }); }
}

async function fixture(
	branchIds: readonly string[],
	disposeGates: ReadonlyMap<string, Promise<void>> = new Map(),
): Promise<{
	controller: HyperchartRunnerController;
	completion: Promise<void>;
	executors: Map<string, PausingExecutor[]>;
	runDir: string;
}> {
	const root = mkdtempSync(join(tmpdir(), "hyperchart-live-move-"));
	roots.push(root);
	const workDir = join(root, "work");
	const runDir = join(root, "run");
	mkdirSync(workDir, { recursive: true });
	mkdirSync(runDir, { recursive: true });
	const chartPath = join(workDir, "chart.mjs");
	writeFileSync(chartPath, `export default {
  kind: "chart", id: "live-move", initial: "work",
  states: {
    work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } },
    done: { kind: "final" }
  }
};\n`);
	writeFileSync(join(runDir, "log.jsonl"), branchIds.map((branchId, index) => JSON.stringify({
		kind: "branch", op: "create", seqId: index + 1, branchId, headSeqId: null,
		metadata: { name: branchId }, committedAt: index + 1,
	})).join("\n") + "\n");
	const executors = new Map<string, PausingExecutor[]>();
	const controller = await createHyperchartRunnerController({
		runId: "run", runDir, chartPath, chartId: "live-move", workDir, branchIds: [...branchIds],
	}, ({ config }) => {
		const executor = new PausingExecutor(config.branchId, disposeGates.get(config.branchId));
		const branchExecutors = executors.get(config.branchId) ?? [];
		branchExecutors.push(executor);
		executors.set(config.branchId, branchExecutors);
		return executor;
	});
	controller.acquireHold();
	const completion = controller.start();
	await waitFor(() => branchIds.every((branchId) => executors.get(branchId)?.[0]?.emit !== undefined));
	return { controller, completion, executors, runDir };
}

describe("live branch sealing and move", () => {
	it("fails closed before the move commit point and releases temporary seals", async () => {
		const f = await fixture(["main"]);
		const beforeEntries = storageEntries(f.runDir);
		const before = await branchView(f.runDir, "main");
		const headSeqId = before.branch.headSeqId!;

		await expect(f.controller.moveBranch("main", 999_999)).rejects.toThrow(/No durable log record/);
		expect(storageEntries(f.runDir)).toEqual(beforeEntries);
		await expect(f.controller.forkBranch({
			branchId: "after-failed-move", sourceBranchId: "main", fromSeqId: headSeqId,
		})).resolves.toMatchObject({ branchId: "after-failed-move", headSeqId });

		await f.controller.stop();
		await f.completion;
	});

	it("keeps a successfully drained branch sealed until replay-gated readmission from its current head", async () => {
		const releaseDispose = deferred();
		const f = await fixture(["main"], new Map([["main", releaseDispose.promise]]));
		const first = f.executors.get("main")![0]!;
		const before = await branchView(f.runDir, "main");
		const drainedHeadSeqId = before.branch.headSeqId!;

		const draining = f.controller.stopAndDrain("main");
		await first.disposalStarted.promise;
		await expect(f.controller.forkBranch({
			branchId: "blocked-during-drain", sourceBranchId: "main", fromSeqId: drainedHeadSeqId,
		})).rejects.toBeInstanceOf(BranchSealedError);
		releaseDispose.resolve();
		await expect(draining).resolves.toEqual({ branchId: "main", outcome: "drained" });
		await expect(f.controller.forkBranch({
			branchId: "blocked-after-drain", sourceBranchId: "main", fromSeqId: drainedHeadSeqId,
		})).rejects.toBeInstanceOf(BranchSealedError);
		await f.controller.moveBranch("main", drainedHeadSeqId);
		await expect(f.controller.forkBranch({
			branchId: "blocked-after-drained-move", sourceBranchId: "main", fromSeqId: drainedHeadSeqId,
		})).rejects.toBeInstanceOf(BranchSealedError);

		const resumed = f.controller.startBranch("main");
		await waitFor(() => f.executors.get("main")?.length === 2 && f.executors.get("main")?.[1]?.emit !== undefined);
		expect((await branchView(f.runDir, "main")).branch.headSeqId).toBe(drainedHeadSeqId);
		f.executors.get("main")![1]!.complete();
		await expect(resumed).resolves.toMatchObject({ branchId: "main", outcome: "complete" });
		const ancestry = (await branchView(f.runDir, "main")).records;
		expect(ancestry.find((record) => record.seqId > drainedHeadSeqId)?.parentId).toBe(drainedHeadSeqId);

		await f.controller.stop();
		await f.completion;
	});

	it("seals a fork subtree, leaves an independent branch writable during drain, and resumes the moved branch from the new head", async () => {
		const releaseMain = deferred();
		const releaseChild = deferred();
		const f = await fixture(["main", "sibling"], new Map([
			["main", releaseMain.promise],
			["child", releaseChild.promise],
		]));
		const initial = await branchView(f.runDir, "main");
		const siblingInitial = await branchView(f.runDir, "sibling");
		const mainTargetSeqId = initial.records[0]!.seqId;
		const mainHeadSeqId = initial.branch.headSeqId!;
		await expect(f.controller.forkBranch({
			branchId: "malformed-child", sourceBranchId: "main", fromSeqId: siblingInitial.branch.headSeqId!,
		})).rejects.toThrow(/not in source branch 'main' ancestry/);
		await f.controller.forkBranch({ branchId: "child", sourceBranchId: "main", fromSeqId: mainHeadSeqId });
		const childOutcome = f.controller.startBranch("child");
		await waitFor(() => f.executors.get("child")?.[0]?.emit !== undefined);
		const oldMain = f.executors.get("main")![0]!;
		const oldChild = f.executors.get("child")![0]!;

		let moved = false;
		const moving = f.controller.moveBranch("main", mainTargetSeqId).then((moveSeqId) => {
			moved = true;
			return moveSeqId;
		});
		await Promise.all([oldMain.disposalStarted.promise, oldChild.disposalStarted.promise]);
		await expect(f.controller.forkBranch({
			branchId: "blocked-child-fork",
			sourceBranchId: "child",
			fromSeqId: (await branchView(f.runDir, "child")).branch.headSeqId!,
		})).rejects.toBeInstanceOf(BranchSealedError);

		const sibling = await branchView(f.runDir, "sibling");
		const independent = await f.controller.forkBranch({
			branchId: "sibling-child", sourceBranchId: "sibling", fromSeqId: sibling.branch.headSeqId!,
		});
		expect(independent.branchId).toBe("sibling-child");
		expect(moved).toBe(false);

		releaseMain.resolve();
		releaseChild.resolve();
		const moveSeqId = await moving;
		await expect(childOutcome).resolves.toEqual({ branchId: "child", outcome: "drained" });
		const movedSnapshot = await branchView(f.runDir, "main");
		const movedEntries = storageEntries(f.runDir);
		expect(movedSnapshot.branch.headSeqId).toBe(mainTargetSeqId);
		expect(movedEntries.find((entry) => "kind" in entry && entry.kind === "branch" && entry.branchId === "sibling-child")?.seqId).toBeLessThan(moveSeqId);
		expect(movedEntries.at(-1)).toMatchObject({ kind: "branch", op: "move", seqId: moveSeqId, branchId: "main", headSeqId: mainTargetSeqId });

		const resumed = f.controller.startBranch("main");
		await waitFor(() => f.executors.get("main")?.length === 2 && f.executors.get("main")?.[1]?.emit !== undefined);
		f.executors.get("main")![1]!.complete();
		await expect(resumed).resolves.toMatchObject({ branchId: "main", outcome: "complete" });
		const resumedSnapshot = await branchView(f.runDir, "main");
		expect(resumedSnapshot.records.find((record) => record.seqId > moveSeqId)?.parentId).toBe(mainTargetSeqId);

		await f.controller.stop();
		await f.completion;
	});
});
