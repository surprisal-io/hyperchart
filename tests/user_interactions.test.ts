import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseChartModuleSync } from "../packages/hyperchart/src/core/inspect.js";
import type { ChartAst } from "../packages/hyperchart/src/core/types.js";
import { JsonlLogStore } from "../packages/hyperchart/src/runtime/generic/log_store.js";
import { MemoryLogStore } from "../packages/hyperchart/src/runtime/generic/memory_log_store.js";
import { saveRunMeta } from "../packages/hyperchart/src/runtime/generic/run_dir.js";
import { patchRunStatus } from "../packages/hyperchart/src/runtime/generic/run_status.js";
import { watchRunnerUserResponses } from "../packages/hyperchart/src/runtime/generic/runner_control.js";
import {
	acquireActiveUserInteraction,
	claimUserInteractionReceipt,
	hasUserInteractionReceipt,
	markUserInteractionReceipt,
	readUserInteractionResponse,
	scanOpenUserInteractions,
	scanOwnedOpenUserInteractions,
	userInteractionDir,
	validateAndPersistUserInteractionResponse,
	type UserInteractionOwner,
} from "../packages/hyperchart/src/runtime/generic/user_interactions.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture(reply = false, loadCounterKey?: string) {
	const root = mkdtempSync(join(tmpdir(), "hyperchart-journal-input-")); roots.push(root);
	const runsRoot = join(root, "runs"), workDir = join(root, "project"), runDir = join(runsRoot, "run-a"), chartPath = join(workDir, "chart.ts");
	mkdirSync(runsRoot); mkdirSync(workDir);
	writeFileSync(chartPath, `
		import { chart, final, user } from "@surprisal/hyperchart";
		${loadCounterKey === undefined ? "" : `(globalThis as any)[${JSON.stringify(loadCounterKey)}] = ((globalThis as any)[${JSON.stringify(loadCounterKey)}] ?? 0) + 1;`}
		export default chart({ id: "chart", initial: "ask", states: {
			ask: { kind: "state", action: user({ prompt: "Approve?", options: ["APPROVED"] }), transitions: { APPROVED: "done" } },
			done: final(),
		} });
	`);
	const parsed = parseChartModuleSync(chartPath); if (!parsed.ok) throw new Error(parsed.diagnostics.map((d) => d.message).join("\n"));
	saveRunMeta(runDir, { chartPath, workDir, chartId: "chart", createdAt: new Date().toISOString(), originSessionId: "session-a" });
	const store = new JsonlLogStore(join(runDir, "log.jsonl")); await store.initializeRootBranch();
	const state = parsed.ast.states.ask; if (state?.kind !== "state" || state.action.kind !== "user") throw new Error("bad fixture");
	await store.appendDrafts([{ type: "args", args: {} }]);
	const [invoke] = await store.appendDrafts([{ type: "state_action", kind: "invoke", sessionId: "session-id", actionUid: state.action.uid, definition: state.action }]);
	const replySchema = reply ? { kind: "jsonSchema" as const, schema: { type: "object", properties: { note: { type: "string" } }, required: ["note"], additionalProperties: false } } : undefined;
	const [opened] = await store.appendDrafts([{ type: "user_interaction", kind: "opened", actionUid: state.action.uid, phaseSeqId: invoke!.seqId, prompt: "Approve?", options: ["APPROVED"], events: ["APPROVED"], ...(replySchema === undefined ? {} : { reply: replySchema }) }]);
	return { root, runsRoot, workDir, runDir, chartPath, ast: parsed.ast, store, gateSeqId: opened!.seqId };
}
function owner(runsRoot: string, workDir: string): UserInteractionOwner { return { runsRoot, workDir, sessionId: "session-a", host: "test" }; }

describe("journal-native user interactions", () => {
	it("derives an open rendered gate from selected journal ancestry without request.json", async () => {
		const f = await fixture();
		const requests = await scanOpenUserInteractions(f.runDir, "main");
		expect(requests).toEqual([expect.objectContaining({ version: 2, runId: "run-a", branchId: "main", seqId: f.gateSeqId, prompt: "Approve?", events: ["APPROVED"] })]);
		expect(existsSync(join(userInteractionDir(f.runDir, "main", f.gateSeqId), "request.json"))).toBe(false);
	});

	it("reuses a parsed chart across interaction scans and invalidates it when source changes", async () => {
		const counterKey = `__hyperchart_scan_loads_${Date.now()}_${Math.random()}`;
		const state = globalThis as Record<string, unknown>;
		try {
			const f = await fixture(false, counterKey);
			expect(state[counterKey]).toBe(1);
			await scanOpenUserInteractions(f.runDir, "main");
			expect(state[counterKey]).toBe(2);
			await scanOpenUserInteractions(f.runDir, "main");
			expect(state[counterKey]).toBe(2);
			writeFileSync(f.chartPath, `${readFileSync(f.chartPath, "utf8")}\n// invalidate scan cache\n`);
			await scanOpenUserInteractions(f.runDir, "main");
			expect(state[counterKey]).toBe(3);
		} finally {
			delete state[counterKey];
		}
	});

	it("commits one resolved journal fact, retries identically, and conflicts divergently", async () => {
		const f = await fixture();
		const input = { runDir: f.runDir, runId: "run-a", branchId: "main", seqId: f.gateSeqId, event: { type: "APPROVED" }, owner: owner(f.runsRoot, f.workDir) } as const;
		expect((await validateAndPersistUserInteractionResponse(input)).idempotent).toBe(false);
		expect((await validateAndPersistUserInteractionResponse(input)).idempotent).toBe(true);
		await expect(validateAndPersistUserInteractionResponse({ ...input, event: { type: "APPROVED", output: "different" } })).rejects.toThrow(/Conflicting response/);
		expect((await readUserInteractionResponse(f.runDir, "main", f.gateSeqId))?.event).toEqual({ type: "APPROVED" });
		expect(existsSync(join(userInteractionDir(f.runDir, "main", f.gateSeqId), "resolution.json"))).toBe(false);
	});

	it("routes a live response through the owning runner control API", async () => {
		const f = await fixture();
		const attemptId = "attempt-live";
		patchRunStatus(f.runDir, {
			runId: "run-a", chartId: "chart", state: "running", branchIds: ["main"], attemptId,
			pid: process.pid, heartbeatAt: Date.now(),
		});
		const stop = watchRunnerUserResponses(f.runDir, attemptId, (request) =>
			f.store.respondToUserInteraction({ ast: f.ast, gateSeqId: request.gateSeqId, event: request.event }));
		try {
			const committed = await validateAndPersistUserInteractionResponse({
				runDir: f.runDir, runId: "run-a", branchId: "main", seqId: f.gateSeqId,
				event: { type: "APPROVED" }, owner: owner(f.runsRoot, f.workDir),
			});
			expect(committed.idempotent).toBe(false);
			expect((await readUserInteractionResponse(f.runDir, "main", f.gateSeqId))?.event).toEqual({ type: "APPROVED" });
		} finally { stop(); }
	});

	it("validates reply schema before append", async () => {
		const f = await fixture(true);
		const base = { runDir: f.runDir, runId: "run-a", branchId: "main", seqId: f.gateSeqId, owner: owner(f.runsRoot, f.workDir) } as const;
		await expect(validateAndPersistUserInteractionResponse({ ...base, event: { type: "APPROVED", output: { note: 1 } } })).rejects.toThrow(/reply schema/);
		expect((await validateAndPersistUserInteractionResponse({ ...base, event: { type: "APPROVED", output: { note: "ok" } } })).idempotent).toBe(false);
	});

	it("allows offline response and treats timeout as a closed gate", async () => {
		const f = await fixture();
		await f.store.appendDrafts([{ type: "failure_intent", origin: "ask", error: "closed" }]);
		await expect(f.store.respondToUserInteraction({ ast: f.ast, gateSeqId: f.gateSeqId, event: { type: "APPROVED" } })).rejects.toThrow(/stale or closed/);
	});

	it("uses only selected ancestry for idempotency after rewind", async () => {
		const f = await fixture();
		await f.store.respondToUserInteraction({ ast: f.ast, gateSeqId: f.gateSeqId, event: { type: "APPROVED" } });
		await f.store.moveBranch("main", f.gateSeqId);
		const second = await f.store.respondToUserInteraction({ ast: f.ast, gateSeqId: f.gateSeqId, event: { type: "APPROVED", output: "alternate" } });
		expect(second.idempotent).toBe(false);
		expect(second.record.parentId).toBe(f.gateSeqId);
	});

	it("serializes concurrent in-process memory responses to one winner", async () => {
		const f = await fixture();
		const memory = new MemoryLogStore();
		const state = f.ast.states.ask; if (state?.kind !== "state" || state.action.kind !== "user") throw new Error("bad fixture");
		const [invoke] = await memory.appendDrafts([{ type: "state_action", kind: "invoke", sessionId: "session-id", actionUid: state.action.uid, definition: state.action }]);
		const [opened] = await memory.appendDrafts([{ type: "user_interaction", kind: "opened", actionUid: state.action.uid, phaseSeqId: invoke!.seqId, prompt: "Approve?", options: ["APPROVED"], events: ["APPROVED"] }]);
		const mem = await Promise.allSettled([
			memory.respondToUserInteraction({ ast: f.ast, gateSeqId: opened!.seqId, event: { type: "APPROVED", output: "left" } }),
			memory.respondToUserInteraction({ ast: f.ast, gateSeqId: opened!.seqId, event: { type: "APPROVED", output: "right" } }),
		]);
		expect(mem.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
	});

	it("does not expose gates after durable failure", async () => {
		const f = await fixture();
		await f.store.appendDrafts([{ type: "failure_intent", origin: "ask", error: "failed" }]);
		expect(await scanOpenUserInteractions(f.runDir, "main")).toEqual([]);
	});

	it("keeps presentation receipts as sidecars without changing semantic openness", async () => {
		const f = await fixture(); const owned = owner(f.runsRoot, f.workDir);
		const active = await acquireActiveUserInteraction(owned); expect(active?.request.seqId).toBe(f.gateSeqId);
		expect(claimUserInteractionReceipt(f.runDir, "main", f.gateSeqId, "test", "session-a")).toBe(true);
		markUserInteractionReceipt(f.runDir, "main", f.gateSeqId, "test", "session-a");
		expect(hasUserInteractionReceipt(f.runDir, "main", f.gateSeqId, "test", "session-a")).toBe(true);
		const scanned = await scanOwnedOpenUserInteractions(owned); expect(scanned[0]?.presentation).toBe("confirmed");
	});
});
