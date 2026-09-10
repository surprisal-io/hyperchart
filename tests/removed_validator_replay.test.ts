import { captureRemovedValidatorHistory } from "../scripts/story-fixtures/validation-histories.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createMachine, createMachineOutput } from "../packages/hyperchart/src/core/machine.js";
import { createBranchProjection, projectBranch, replayResumeError } from "../packages/hyperchart/src/core/projection.js";
import { explainReplay, hasBlockingReplayWarnings } from "../packages/hyperchart/src/core/replay_check.js";
import type { DurableLogRecord } from "../packages/hyperchart/src/core/durable_events.js";
import { BranchExecution } from "../packages/hyperchart/src/execution/branch_execution.js";
import { loadBranchProjection, projectionContractForAst } from "../packages/hyperchart/src/execution/projection_restore.js";
import { hyperchartRunFromRuntime } from "../packages/hyperchart/src/host/adapters.js";
import { ArtifactStore } from "../packages/hyperchart/src/runtime/generic/artifact_store.js";
import { JsonlLogStore } from "../packages/hyperchart/src/runtime/generic/log_store.js";
import { readRunStatus } from "../packages/hyperchart/src/runtime/generic/run_status.js";
import { withRunStorage, type RunStorage } from "../packages/hyperchart/src/runtime/generic/run_paths.js";
import { main } from "../packages/pi-hyperchart/src/runtime/pi/hyperchart_runner.js";
import { guardedValidationScenario, removedValidationScenario } from "../packages/hyperchart/src/react/fixtures/removed-validator-fixture.js";

const roots: string[] = [];
const previousCwd = process.cwd();
const previousExit = process.exitCode;
afterEach(() => { process.chdir(previousCwd); process.exitCode = previousExit; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ast = removedValidationScenario.ast;
const project = (records: readonly DurableLogRecord[]) => projectBranch(createBranchProjection(ast), ast, records);
async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "removed-validator-")); roots.push(root);
	const runDir = join(root, "run"); mkdirSync(runDir);
	const store = new JsonlLogStore(join(runDir, "log.jsonl")); await store.initializeRootBranch();
	const artifactStore = new ArtifactStore(runDir);
	const pins = [];
	for (const bytes of ["rejected", "accepted", "next visit"]) {
		const path = join(root, "result.txt"); writeFileSync(path, bytes); pins.push(await artifactStore.put(path));
	}
	const { records } = await captureRemovedValidatorHistory((drafts) => store.appendDrafts(drafts), { pins });
	return { root, runDir, store, records, pins };
}
const verdict = (record: DurableLogRecord) => record.type === "state_action" && record.kind === "validated";

it("replays only matching positive verdicts, exact visits and accepted pins after guard removal", async () => {
	const f = await fixture();
	try {
		const replay = explainReplay(ast, f.records);
		expect(replay.broken).toBeUndefined(); expect(replay.skipped).toEqual([]);
		expect(replay.stale.every((entry) => entry.reason === "guard_removed")).toBe(true);
		expect(hasBlockingReplayWarnings(replay)).toBe(false);
		const expected = project(f.records);
		expect(expected.activeLeaves).toEqual(["done"]);
		expect(expected.results.work).toEqual({ attempt: 3 });
		expect(expected.artifactPins).toEqual({ "result.txt": f.pins[2] });
		expect(Object.values(expected.stateVisits)).toEqual([2]);
		const semantic = await BranchExecution.restore({ ast, branchId: "main", store: f.store });
		expect(semantic.artifactPins()).toEqual(expected.artifactPins);
		expect(semantic.inspectionOverview().final).toBe(true);
		expect(semantic.checkpointable()).toBe(false);
		const run = hyperchartRunFromRuntime(removedValidationScenario.inspect, ast, f.records);
		expect(run.replayIncompatibility).toBeUndefined();
		expect(run.issues?.some((issue) => issue.message.includes("Validator removed"))).toBe(true);
		expect(run.states.find((state) => state.id === "work")?.visitHistory?.map((visit) => ({ status: visit.status, pins: visit.artifactPins }))).toEqual([
			{ status: "done", pins: [{ path: "result.txt", ...f.pins[1] }] }, { status: "done", pins: [{ path: "result.txt", ...f.pins[2] }] },
		]);
	} finally { await f.store.close(); }
});

it("holds first claims and rejected prefixes without results, published pins or runnable obsolete effects", async () => {
	const f = await fixture();
	try {
		const firstVerdict = f.records.findIndex(verdict);
		for (const end of [firstVerdict, firstVerdict + 1, firstVerdict + 2]) {
			const prefix = f.records.slice(0, end);
			const projection = project(prefix);
			expect(projection.results).toEqual({}); expect(projection.artifactPins).toEqual({});
			expect(replayResumeError(projection, ast)).toContain("no recorded positive validation");
			expect(createMachineOutput(createMachine(ast, projection), []).kind).toBe("error");
			const semantic = await BranchExecution.restore({ ast, branchId: "main", store: f.store, snapshot: { branchId: "main", headSeqId: prefix.at(-1)!.seqId } });
			expect(semantic.artifactPins()).toEqual({}); expect(semantic.inspectionOverview().final).toBe(false);
			const visit = hyperchartRunFromRuntime(removedValidationScenario.inspect, ast, prefix).states.find((state) => state.id === "work")?.visitHistory?.[0];
			expect(visit?.status).not.toBe("done"); expect(visit?.artifactPins).toBeUndefined(); expect(visit?.endedAt).toBeUndefined();
		}
	} finally { await f.store.close(); }
});

it("legacy unknown completions remain provisional, even if genuinely unguarded; recorded legacy verdicts still replay", async () => {
	const f = await fixture();
	try {
		// Deliberately erase only the new field to exercise the pre-provenance contract.
		const legacy = f.records.map((record) => {
			if (record.type !== "state_action" || record.kind !== "invoke") return record;
			const { validation: _validation, ...old } = record; return old;
		});
		expect(project(legacy).results.work).toEqual({ attempt: 3 });
		const prefix = legacy.slice(0, legacy.findIndex(verdict));
		expect(project(prefix).artifactPins).toEqual({});
		expect(replayResumeError(project(prefix), ast)).toContain("legacy invocation lacks validation provenance");
		let seqId = 0;
		const unguarded = await captureRemovedValidatorHistory(async (drafts) => drafts.map((draft) => ({ ...draft, parentId: seqId || null, seqId: ++seqId, branchId: "main", timestamp: seqId }) as DurableLogRecord), { unguarded: true });
		const oldUnguarded = unguarded.records.map((record) => { if (record.type !== "state_action" || record.kind !== "invoke") return record; const { validation: _validation, ...old } = record; return old; });
		expect(project(unguarded.records).activeLeaves).toEqual(["done"]);
		expect(project(oldUnguarded).results).toEqual({}); expect(replayResumeError(project(oldUnguarded), ast)).toContain("legacy invocation");
	} finally { await f.store.close(); }
});

it("new visits run without the removed guard; forks inherit accepted pins but cannot accept sibling provisional pins", async () => {
	const f = await fixture();
	try {
		const firstAcceptedIndex = f.records.findIndex((record) => verdict(record) && record.type === "state_action" && record.kind === "validated" && record.outcome === true);
		const prefix = f.records.slice(0, firstAcceptedIndex + 1);
		const projection = project(prefix);
		expect(projection.activeLeaves).toEqual(["work"]); expect(projection.pendingActions).toEqual([]);
		await f.store.createBranch("fork", prefix.at(-1)!.seqId);
		const fork = f.store.forBranch("fork");
		const fresh = await captureRemovedValidatorHistory((drafts) => fork.appendDrafts(drafts), { unguarded: true, projection });
		expect(fresh.records.some(verdict)).toBe(false);
		expect(fresh.records.find((record) => record.type === "state_action" && record.kind === "invoke")).toMatchObject({ validation: null });
		expect(project([...prefix, ...fresh.records]).results.work).toEqual({ attempt: 1 });
		const semantic = await BranchExecution.restore({ ast, branchId: "fork", store: f.store });
		expect(semantic.artifactPins()).toEqual({ "result.txt": f.pins[1] });
		const candidate = f.records.findIndex((record) => record.type === "state_action" && record.kind === "complete");
		await f.store.createBranch("pending", f.records[candidate]!.seqId);
		const pending = await BranchExecution.restore({ ast, branchId: "pending", store: f.store });
		expect(pending.artifactPins()).toEqual({}); expect(pending.workspaceArtifactPins()).toEqual({});
		const positive = f.records[firstAcceptedIndex]!;
		expect(() => project([...f.records.slice(0, firstAcceptedIndex), { ...positive, branchId: "sibling" }])).toThrow("branch-local completion");
	} finally { await f.store.close(); }
});

it("streams across the 500-record boundary and never caches away guard-removal warnings", async () => {
	const f = await fixture();
	try {
		const root = join(f.root, "batched.jsonl"); const store = new JsonlLogStore(root); await store.initializeRootBranch();
		try {
			// Harmless args facts are emitted by the runtime append boundary before the real scenario.
			await store.appendDrafts(Array.from({ length: 496 }, () => ({ type: "args" as const, args: {} })));
			await captureRemovedValidatorHistory((drafts) => store.appendDrafts(drafts), { pins: f.pins });
			for (let n = 0; n < 2; n++) {
				const loaded = await loadBranchProjection({ ast, branchId: "main", store, contract: projectionContractForAst(ast) });
				expect(loaded.replayBatches).toBe(2); expect(loaded.checkpointSaved).toBe(false); expect(loaded.checkpointHeadSeqId).toBeNull();
				expect(loaded.projection.artifactPins).toEqual({ "result.txt": f.pins[2] }); expect(hasBlockingReplayWarnings(loaded.replay)).toBe(false);
			}
		} finally { await store.close(); }
	} finally { await f.store.close(); }
});

it("runner resumes proven guard-removal warnings without override, but blocks missing verdicts even with override", async () => {
	const f = await fixture();
	try {
		const chartPath = join(f.root, "chart.mjs");
		writeFileSync(chartPath, `export default {kind:'chart',id:'recorded-validation',initial:'work',states:{work:{kind:'state',action:{kind:'agent',name:'worker',artifacts:{result:'result.txt'}},transitions:{AGAIN:'work',DONE:'done'}},done:{kind:'final'}}};`);
		const storage: RunStorage = { kind: "jsonl", rootDir: f.root, layout: "run-id" };
		const config = { runId: "run", branchId: "main", storage, chartPath, chartId: ast.id, workDir: f.root, agentDir: f.root, piModules: { codingAgent: "/unused", typebox: "/unused" } };
		const configPath = join(f.runDir, "runner.config.json"); writeFileSync(configPath, JSON.stringify(config));
		await main([configPath]);
		expect(withRunStorage(storage, () => readRunStatus("run"))).toMatchObject({ state: "complete", exitCode: 0 });
		const claim = f.records.find((record) => record.type === "state_action" && record.kind === "complete")!;
		await f.store.createBranch("pending", claim.seqId);
		writeFileSync(configPath, JSON.stringify({ ...config, branchId: "pending", ignoreReplayWarnings: true }));
		await main([configPath]);
		expect(withRunStorage(storage, () => readRunStatus("run"))).toMatchObject({ state: "failed", error: expect.stringContaining("no recorded positive validation") });
	} finally { await f.store.close(); }
});

it("retains unrelated action/guard mismatch gates and rejects a verdict for different completion bytes", async () => {
	const f = await fixture();
	try {
		const changed = structuredClone(ast); const work = changed.states.work;
		if (work?.kind !== "state" || work.action.kind !== "agent") throw new Error("work action missing");
		const changedActionAst = { ...changed, states: { ...changed.states, work: { ...work, action: { ...work.action, name: "different" } } } };
		expect(hasBlockingReplayWarnings(explainReplay(changedActionAst, f.records))).toBe(true);
		const changedGuard = structuredClone(guardedValidationScenario.ast); const guarded = changedGuard.states.work;
		if (guarded?.kind !== "state") throw new Error("guarded work missing");
		const changedGuardAst = { ...changedGuard, states: { ...changedGuard.states, work: { ...guarded, validate: { kind: "tsImport" as const, module: "./different.js", export: "ok" } } } };
		expect(hasBlockingReplayWarnings(explainReplay(changedGuardAst, f.records))).toBe(true);
		const mismatch = f.records.map((record) => verdict(record) && record.type === "state_action" && record.kind === "validated" ? { ...record, event: { type: "DONE", output: { wrong: true } } } : record);
		expect(explainReplay(ast, mismatch).broken?.error).toContain("does not match pending completion");
		const changedHistoricalGuard = f.records.map((record) => record.type === "state_action" && record.kind === "validated"
			? { ...record, guard: { kind: "tsImport" as const, module: "./different.js", export: "ok" } } : record);
		expect(hasBlockingReplayWarnings(explainReplay(ast, changedHistoricalGuard))).toBe(true);
		const reordered = f.records.map((record) => record.type === "state_action" && record.kind === "validated"
			? { ...record, event: { output: "output" in record.event ? record.event.output : undefined, type: record.event.type } } : record);
		expect(explainReplay(ast, reordered).broken).toBeUndefined();
	} finally { await f.store.close(); }
});


it("retains pending invoke policy in compatible checkpoints and rejects old-chart caches after removal", async () => {
	const f = await fixture();
	try {
		const claim = f.records.find((record) => record.type === "state_action" && record.kind === "complete")!;
		const snapshot = { branchId: "main", headSeqId: claim.seqId };
		const original = guardedValidationScenario.ast;
		const saved = await loadBranchProjection({ ast: original, branchId: "main", store: f.store, snapshot, contract: projectionContractForAst(original), saveCheckpoint: "always" });
		expect(saved.checkpointSaved).toBe(true);
		const cached = await loadBranchProjection({ ast: original, branchId: "main", store: f.store, snapshot, contract: projectionContractForAst(original) });
		expect(cached.checkpointHeadSeqId).toBe(claim.seqId);
		expect(cached.projection.pendingActions).toEqual(saved.projection.pendingActions);
		expect(cached.projection.pendingActions[0]).toMatchObject({ phase: "validating", validation: { kind: "tsImport", module: "./checks.js", export: "ok" } });
		const changed = await loadBranchProjection({ ast, branchId: "main", store: f.store, snapshot, contract: projectionContractForAst(ast) });
		expect(changed.checkpointHeadSeqId).toBeNull();
		expect(changed.projection.artifactPins).toEqual({});
		expect(replayResumeError(changed.projection, ast)).toContain("no recorded positive validation");
	} finally { await f.store.close(); }
});
