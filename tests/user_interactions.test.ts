import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveRunMeta } from "../packages/hyperchart/src/runtime/generic/run_dir.js";
import { patchRunStatus } from "../packages/hyperchart/src/runtime/generic/run_status.js";
import { rewindHyperchartRun } from "../packages/hyperchart/src/runtime/generic/rewind.js";
import { FileUserExecutor } from "../packages/hyperchart/src/runtime/generic/user_executor.js";
import {
	acquireActiveUserInteraction,
	claimUserInteractionReceipt,
	closeUserInteraction,
	hasUserInteractionReceipt,
	markUserInteractionReceipt,
	persistUserInteractionRequest,
	readUserInteractionClose,
	readUserInteractionRequest,
	readUserInteractionResponse,
	releaseActiveUserInteraction,
	scanOpenUserInteractions,
	scanOwnedOpenUserInteractions,
	userInteractionArbiterPath,
	userInteractionRequestPath,
	validateAndPersistUserInteractionResponse,
	type UserInteractionOwner,
} from "../packages/hyperchart/src/runtime/generic/user_interactions.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
	const root = mkdtempSync(join(tmpdir(), "hyperchart-user-interactions-"));
	roots.push(root);
	const runsRoot = join(root, "runs");
	const workDir = join(root, "project");
	mkdirSync(runsRoot);
	mkdirSync(workDir);
	return { root, runsRoot, workDir };
}

function createRun(
	runsRoot: string,
	workDir: string,
	runId: string,
	sessionId = "session-a",
): string {
	const runDir = join(runsRoot, runId);
	saveRunMeta(runDir, {
		chartPath: join(workDir, "chart.ts"),
		workDir,
		chartId: "chart",
		createdAt: new Date().toISOString(),
		originSessionId: sessionId,
	});
	patchRunStatus(runDir, {
		runId,
		chartId: "chart",
		state: "running",
		pid: process.pid,
		heartbeatAt: Date.now(),
	});
	return runDir;
}

function persist(runDir: string, runId: string, seqId: number, reply = false) {
	return persistUserInteractionRequest(runDir, {
		runId,
		seqId,
		actionUid: { chart: "chart", state: `branch-${seqId}`, action: "user" },
		prompt: `Question ${seqId}?`,
		options: ["APPROVED", "REJECTED"],
		events: ["APPROVED", "REJECTED", "FAILED"],
		...(reply
			? {
					reply: {
						kind: "jsonSchema" as const,
						schema: {
							type: "object",
							properties: { note: { type: "string" } },
							required: ["note"],
							additionalProperties: false,
						},
					},
				}
			: {}),
	});
}

function owner(runsRoot: string, workDir: string, sessionId = "session-a"): UserInteractionOwner {
	return { runsRoot, workDir, sessionId, host: "test" };
}

describe("user interaction mailbox", () => {
	it("uses only runId and seqId as persisted gate identity and persists once", () => {
		const { runsRoot, workDir } = world();
		const runDir = createRun(runsRoot, workDir, "run-a");
		const first = persist(runDir, "run-a", 7);
		const second = persist(runDir, "run-a", 7);

		expect(second).toEqual(first);
		expect(userInteractionRequestPath(runDir, 7)).toBe(join(runDir, "user-interactions", "7", "request.json"));
		const raw = JSON.parse(readFileSync(userInteractionRequestPath(runDir, 7), "utf8"));
		expect(raw).toMatchObject({ runId: "run-a", seqId: 7 });
		expect(raw).not.toHaveProperty("effectId");
		expect(raw).not.toHaveProperty("requestId");
		expect(() => persistUserInteractionRequest(runDir, { ...first, prompt: "different" } as never)).toThrow(/conflict/);
	});

	it("isolates malformed and directory-coordinate-mismatched phases during scans", () => {
		const { runsRoot, workDir } = world();
		const runDir = createRun(runsRoot, workDir, "run-a");
		persist(runDir, "run-a", 3);
		mkdirSync(join(runDir, "user-interactions", "1"), { recursive: true });
		writeFileSync(join(runDir, "user-interactions", "1", "request.json"), "{broken\n");
		mkdirSync(join(runDir, "user-interactions", "2"), { recursive: true });
		writeFileSync(join(runDir, "user-interactions", "2", "request.json"), JSON.stringify({
			version: 1,
			runId: "run-a",
			seqId: 99,
			actionUid: { chart: "chart", state: "wrong", action: "user" },
			prompt: "wrong directory",
			options: [],
			events: ["OK"],
			createdAt: new Date().toISOString(),
		}));

		expect(scanOpenUserInteractions(runDir).map((request) => request.seqId)).toEqual([3]);
		expect(() => readUserInteractionRequest(runDir, 2)).toThrow(/Invalid user interaction record/);
	});

	it("validates events and reply schema before commit", async () => {
		const { runsRoot, workDir } = world();
		const runDir = createRun(runsRoot, workDir, "run-a");
		persist(runDir, "run-a", 1, true);

		await expect(validateAndPersistUserInteractionResponse({
			runDir, runId: "run-a", seqId: 1, event: { type: "FAILED", error: "no" },
		})).rejects.toThrow(/FAILED is reserved/);
		await expect(validateAndPersistUserInteractionResponse({
			runDir, runId: "run-a", seqId: 1, event: { type: "OTHER" },
		})).rejects.toThrow(/not allowed/);
		await expect(validateAndPersistUserInteractionResponse({
			runDir, runId: "run-a", seqId: 1, event: { type: "APPROVED", output: { nope: true } },
		})).rejects.toThrow(/reply schema/);
		expect(readUserInteractionResponse(runDir, 1)).toBeUndefined();

		const committed = await validateAndPersistUserInteractionResponse({
			runDir, runId: "run-a", seqId: 1, event: { type: "APPROVED", output: { note: "yes" } },
		});
		expect(committed.idempotent).toBe(false);
		const identical = await validateAndPersistUserInteractionResponse({
			runDir, runId: "run-a", seqId: 1, event: { output: { note: "yes" }, type: "APPROVED" },
		});
		expect(identical.idempotent).toBe(true);
		await expect(validateAndPersistUserInteractionResponse({
			runDir, runId: "run-a", seqId: 1, event: { type: "REJECTED", output: { note: "no" } },
		})).rejects.toThrow(/Conflicting response/);
	});

	it("makes close and response compete for one atomic resolution fact", async () => {
		const { runsRoot, workDir } = world();
		const runDir = createRun(runsRoot, workDir, "run-a");
		persist(runDir, "run-a", 1, true);

		const committing = validateAndPersistUserInteractionResponse({
			runDir,
			runId: "run-a",
			seqId: 1,
			event: { type: "APPROVED", output: { note: "yes" } },
		});
		const closed = closeUserInteraction(runDir, { runId: "run-a", seqId: 1 }, "timeout");

		expect(closed?.reason).toBe("timeout");
		await expect(committing).rejects.toThrow(/stale, closed, or missing|closed before response commit/);
		expect(readUserInteractionClose(runDir, 1)?.reason).toBe("timeout");
		expect(readUserInteractionResponse(runDir, 1)).toBeUndefined();
	});

	it("pins and promotes gates strictly by lexical runId then numeric seqId", async () => {
		const { runsRoot, workDir } = world();
		const runB = createRun(runsRoot, workDir, "run-b");
		const runA = createRun(runsRoot, workDir, "run-a");
		persist(runB, "run-b", 1);
		persist(runA, "run-a", 10);
		persist(runA, "run-a", 2);
		const owned = owner(runsRoot, workDir);

		expect(scanOwnedOpenUserInteractions(owned).map(({ request }) => [request.runId, request.seqId])).toEqual([
			["run-a", 2],
			["run-a", 10],
			["run-b", 1],
		]);
		expect(acquireActiveUserInteraction(owned)?.request).toMatchObject({ runId: "run-a", seqId: 2 });
		expect(acquireActiveUserInteraction(owned)?.request).toMatchObject({ runId: "run-a", seqId: 2 });

		await validateAndPersistUserInteractionResponse({
			runDir: runA,
			runId: "run-a",
			seqId: 2,
			event: { type: "APPROVED" },
			owner: owned,
		});
		expect((await validateAndPersistUserInteractionResponse({
			runDir: runA,
			runId: "run-a",
			seqId: 2,
			event: { type: "APPROVED" },
			owner: owned,
		})).idempotent).toBe(true);
		expect(acquireActiveUserInteraction(owned)?.request).toMatchObject({ runId: "run-a", seqId: 10 });
		closeUserInteraction(runA, { runId: "run-a", seqId: 10 }, "scope_exit");
		expect(acquireActiveUserInteraction(owned)?.request).toMatchObject({ runId: "run-b", seqId: 1 });
	});

	it("keeps the first immutable claim pinned when a lower coordinate appears later", () => {
		const { runsRoot, workDir } = world();
		const runB = createRun(runsRoot, workDir, "run-b");
		persist(runB, "run-b", 1);
		const owned = owner(runsRoot, workDir);
		const staleSelection = acquireActiveUserInteraction(owned);
		expect(staleSelection?.request.runId).toBe("run-b");

		const runA = createRun(runsRoot, workDir, "run-a");
		persist(runA, "run-a", 1);
		// Another presenter can now select run-a while the stale run-b presenter is paused.
		expect(acquireActiveUserInteraction(owned)?.request.runId).toBe("run-a");
		claimUserInteractionReceipt(runB, 1, "test", "session-a", { source: "first-published-claim" });
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
		claimUserInteractionReceipt(runA, 1, "test", "session-a", { source: "later-published-claim" });

		// Once run-b wins the first immutable claim it remains the sole active gate. The
		// lexically lower run-a is queued rather than preempting a gate that may be presented.
		expect(acquireActiveUserInteraction(owned)?.request).toMatchObject({ runId: "run-b", seqId: 1 });
	});

	it("enforces exact owner/cwd and exact active coordinates", async () => {
		const { root, runsRoot, workDir } = world();
		const runDir = createRun(runsRoot, workDir, "run-a");
		persist(runDir, "run-a", 1);
		persist(runDir, "run-a", 2);
		const activeOwner = owner(runsRoot, workDir);
		expect(acquireActiveUserInteraction(activeOwner)?.request.seqId).toBe(1);

		await expect(validateAndPersistUserInteractionResponse({
			runDir, runId: "run-a", seqId: 2, event: { type: "APPROVED" }, owner: activeOwner,
		})).rejects.toThrow(/not the active gate/);
		await expect(validateAndPersistUserInteractionResponse({
			runDir, runId: "run-a", seqId: 1, event: { type: "APPROVED" }, owner: owner(runsRoot, workDir, "session-b"),
		})).rejects.toThrow(/not owned/);
		await expect(validateAndPersistUserInteractionResponse({
			runDir, runId: "run-a", seqId: 1, event: { type: "APPROVED" }, owner: owner(runsRoot, join(root, "elsewhere")),
		})).rejects.toThrow(/another working directory/);
	});

	it("keeps an already-presented unanswered gate pinned ahead of lower pending coordinates", () => {
		const { runsRoot, workDir } = world();
		const runA = createRun(runsRoot, workDir, "run-a");
		const runB = createRun(runsRoot, workDir, "run-b");
		persist(runA, "run-a", 1);
		persist(runB, "run-b", 1);
		claimUserInteractionReceipt(runB, 1, "test", "session-a", { now: 1, leaseMs: 1 });

		// Even an expired claim may only redeliver run-b; it cannot promote run-a.
		expect(acquireActiveUserInteraction(owner(runsRoot, workDir))?.request).toMatchObject({
			runId: "run-b",
			seqId: 1,
		});
		markUserInteractionReceipt(runB, 1, "test", "session-a");
		expect(acquireActiveUserInteraction(owner(runsRoot, workDir))?.request.runId).toBe("run-b");
	});

	it("recovers presentation claims and confirmations without changing gate identity", () => {
		const { runsRoot, workDir } = world();
		const runDir = createRun(runsRoot, workDir, "run-a");
		persist(runDir, "run-a", 1);

		expect(claimUserInteractionReceipt(runDir, 1, "test", "session-a", { now: 1_000, leaseMs: 100 })).toBe(true);
		expect(claimUserInteractionReceipt(runDir, 1, "test", "session-a", { now: 1_050, leaseMs: 100 })).toBe(false);
		expect(claimUserInteractionReceipt(runDir, 1, "test", "session-a", { now: 1_101, leaseMs: 100 })).toBe(true);
		expect(hasUserInteractionReceipt(runDir, 1, "test", "session-a")).toBe(false);
		markUserInteractionReceipt(runDir, 1, "test", "session-a");
		expect(hasUserInteractionReceipt(runDir, 1, "test", "session-a")).toBe(true);
		expect(claimUserInteractionReceipt(runDir, 1, "test", "session-a", { now: 9_000, leaseMs: 100 })).toBe(false);
	});

	it("preserves phases on dispose, closes on cancel, and creates a new rejected-phase request", async () => {
		const { runsRoot, workDir } = world();
		const runDir = createRun(runsRoot, workDir, "run-a");
		const uid = { chart: "chart", state: "ask", action: "user" } as const;
		const invocation = {
			kind: "user" as const,
			id: "private-effect",
			seqId: 1,
			actionUid: uid,
			action: { kind: "user" as const, uid, prompt: { kind: "template" as const, strings: ["Approve?"], refs: [] }, options: ["APPROVED"] },
			prompt: "Approve?",
			events: ["APPROVED"],
		};
		const first = new FileUserExecutor({ runId: "run-a", runDir, pollMs: 1_000 });
		first.start(invocation, () => undefined);
		await first.dispose();
		expect(readUserInteractionRequest(runDir, 1)).toBeDefined();
		expect(readUserInteractionClose(runDir, 1)).toBeUndefined();

		const canceling = new FileUserExecutor({ runId: "run-a", runDir, pollMs: 1_000 });
		canceling.start({ ...invocation, id: "private-effect-2", seqId: 2 }, () => undefined);
		await canceling.cancel(uid);
		expect(readUserInteractionClose(runDir, 2)?.reason).toBe("machine_abandoned");
		await canceling.dispose();

		const rejecting = new FileUserExecutor({ runId: "run-a", runDir, pollMs: 1_000 });
		rejecting.reject({
			kind: "rejected",
			id: "private-rejected-effect",
			seqId: 3,
			actionUid: uid,
			event: { type: "APPROVED" },
			onReject: "resume",
			validationAttempts: 1,
			reason: "needs confirmation",
			invocation,
		}, () => undefined);
		expect(readUserInteractionRequest(runDir, 3)?.rejection).toEqual({
			attempt: 1,
			onReject: "resume",
			reason: "needs confirmation",
		});
		await rejecting.dispose();
	});

	it("moves the whole mailbox into rewind backup", async () => {
		const { root, runsRoot, workDir } = world();
		const runDir = createRun(runsRoot, workDir, "run-a");
		const chartPath = join(root, "rewind-chart.mjs");
		writeFileSync(chartPath, `export default { kind: "chart", id: "chart", initial: "ask", states: { ask: { kind: "state", action: { kind: "user", prompt: "Approve?", options: ["APPROVED"] }, transitions: { APPROVED: "done" } }, done: { kind: "final" } } };\n`);
		saveRunMeta(runDir, {
			chartPath,
			workDir,
			chartId: "chart",
			createdAt: new Date().toISOString(),
			originSessionId: "session-a",
		});
		const uid = { chart: "chart", state: "ask", action: "user" } as const;
		writeFileSync(join(runDir, "log.jsonl"), [
			{ type: "state_action", kind: "invoke", actionUid: uid, definition: { kind: "user", uid, prompt: { kind: "template", strings: ["Approve?"], refs: [] }, options: ["APPROVED"] }, parentId: null, seqId: 1, timestamp: 1 },
			{ type: "state_action", kind: "complete", actionUid: uid, event: { type: "APPROVED" }, parentId: 1, seqId: 2, timestamp: 2 },
		].map((record) => JSON.stringify(record)).join("\n") + "\n");
		persist(runDir, "run-a", 1);
		closeUserInteraction(runDir, { runId: "run-a", seqId: 1 }, "test");
		patchRunStatus(runDir, { state: "stopped", pid: undefined, heartbeatAt: undefined });

		const result = await rewindHyperchartRun({
			runDir,
			state: "ask",
			mode: "before",
			cleanupSessions: true,
			cleanupArtifacts: false,
			cwd: workDir,
		});

		expect(readFileSync(join(result.backupDir, "user-interactions", "1", "request.json"), "utf8")).toContain("Question 1?");
		expect(() => readFileSync(join(runDir, "user-interactions", "1", "request.json"), "utf8")).toThrow();
	});

	it("ignores obsolete mutable arbiter files and derives the real lowest gate", () => {
		const { runsRoot, workDir } = world();
		const runDir = createRun(runsRoot, workDir, "run-a");
		persist(runDir, "run-a", 1);
		const owned = owner(runsRoot, workDir);
		mkdirSync(join(runsRoot, ".user-interaction-arbiter"), { recursive: true });
		writeFileSync(userInteractionArbiterPath(owned), "{broken\n");

		expect(acquireActiveUserInteraction(owned)?.request).toMatchObject({ runId: "run-a", seqId: 1 });
		expect(releaseActiveUserInteraction(owned, { runId: "run-a", seqId: 1 })).toBe(false);
		closeUserInteraction(runDir, { runId: "run-a", seqId: 1 }, "done");
		expect(releaseActiveUserInteraction(owned, { runId: "run-a", seqId: 1 })).toBe(true);
	});
});
