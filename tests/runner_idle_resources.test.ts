import { resolveRunPaths, type RunStorage } from "../packages/hyperchart/src/runtime/generic/run_paths.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { AgentOutcome } from "../packages/hyperchart/src/core/machine.js";
import { JsonlLogStore } from "../packages/hyperchart/src/runtime/generic/log_store.js";
import { createHyperchartRunnerController } from "../packages/hyperchart/src/runner/runner_main.js";
import { collectHistoryRecords } from "./helpers/history.js";

it("unloads and readmits real journal-native gates repeatedly, preserving active work and fork ancestry", async () => {
	const root = mkdtempSync(join(tmpdir(), "hyperchart-idle-resources-"));
	const storage: RunStorage = { kind: "jsonl", rootDir: root, layout: "sha256" };
	const runDir = resolveRunPaths("idle-resources", storage).runDir;
	mkdirSync(runDir);
	const chartPath = join(root, "chart.mjs");
	writeFileSync(chartPath, `export default { kind: "chart", id: "idle-resources", initial: "ask", states: {
  ask: { kind: "state", action: { kind: "user", prompt: "Select", options: ["SELECTED"] }, transitions: { SELECTED: "work" } },
  work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "ask" } }
} };`);
	const log = join(runDir, "log.jsonl");
	writeFileSync(log,
		`${JSON.stringify({ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 })}\n`,
	);
	const emissions = new Map<string, (outcome: AgentOutcome) => void>();
	let resident = 0;
	let built = 0;
	const controller = await createHyperchartRunnerController({ runId: "idle-resources", storage, chartPath, chartId: "idle-resources", workDir: root, branchId: "main" }, ({ config }) => {
		resident++; built++;
		return {
			start(_effect, emit) { emissions.set(config.branchId, emit); },
				async cancel() {},
			async dispose() { resident--; emissions.delete(config.branchId); },
			async steer() { return false; },
		};
	});
	const hold = controller.acquireHold();
	const aggregate = controller.start();
	const gate = async (branchId: string) => {
		const store = new JsonlLogStore(log, branchId);
		const records = await collectHistoryRecords(store, branchId);
		const opened = [...records].reverse().find((record) => record.type === "user_interaction" && record.kind === "opened");
		if (opened === undefined) throw new Error("gate missing");
		return opened.seqId;
	};
	try {
		await vi.waitFor(async () => expect(await controller.activeBranchIds()).toEqual([]));
		const sourceGate = await gate("main");
		await controller.forkBranch({ branchId: "fork", sourceBranchId: "main", fromSeqId: sourceGate });
		const forkOutcome = controller.startBranch("fork");
		await vi.waitFor(async () => expect(await controller.activeBranchIds()).toEqual([]));
		expect(await gate("fork")).toBe(sourceGate);
		const before = readFileSync(log, "utf8");
		expect(await controller.unloadBranch("fork")).toEqual({ branchId: "fork", outcome: "drained" });
		await forkOutcome;
		expect(readFileSync(log, "utf8")).toBe(before);
		for (let cycle = 0; cycle < 10; cycle++) {
			const branchId = cycle === 0 ? "fork" : "main";
			const seq = await gate(branchId);
			if (controller.liveBranchIds.includes(branchId)) await controller.unloadBranch(branchId);
			await controller.respondToUserInteraction(branchId, seq, { type: "SELECTED" });
			const outcome = controller.startBranch(branchId);
			await vi.waitFor(() => expect(emissions.has(branchId)).toBe(true));
			expect(await controller.activeBranchIds()).toEqual([branchId]);
			await expect(controller.unloadBranch(branchId)).rejects.toThrow("not idle");
			expect(resident).toBe(controller.liveBranchIds.length);
			emissions.get(branchId)?.({ kind: "completed", event: { type: "DONE" } });
			await vi.waitFor(async () => expect(await controller.activeBranchIds()).toEqual([]));
			expect(await gate(branchId)).toBeGreaterThan(seq);
			const parked = readFileSync(log, "utf8");
			await controller.unloadBranch(branchId);
			await outcome;
			expect(readFileSync(log, "utf8")).toBe(parked);
			expect(resident).toBeLessThanOrEqual(1);
		}
		expect(await controller.durableBranchIds()).toEqual(["main", "fork"]);
		expect(resident).toBe(0);
		expect(built).toBe(12);
		console.log("runner resource regression: 10 unload/readmission cycles; final resident executors=0; gate unload journal bytes unchanged");
	} finally {
		await controller.stop();
		hold.release();
		await aggregate;
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
