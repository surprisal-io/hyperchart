import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agent, artifact, chart, failed, final, t, z } from "../packages/hyperchart/src/index.js";
import { artifactOf, event, input, result } from "../packages/hyperchart/src/core/dsl.js";
import type { DurableLogRecord } from "../packages/hyperchart/src/core/durable_events.js";
import { createMachine } from "../packages/hyperchart/src/core/machine.js";
import { normalizeChartConfig } from "../packages/hyperchart/src/core/normalize.js";
import { createBranchProjection, projectBranch } from "../packages/hyperchart/src/core/projection.js";
import type { ChartAst, StateActionAst } from "../packages/hyperchart/src/core/types.js";
import { patchRunStatus, readRunStatus } from "../packages/hyperchart/src/runtime/generic/run_status.js";
import {
	archiveTerminalNotificationGeneration,
	claimTerminalNotificationReceipt,
	hasTerminalNotificationReceipt,
	markTerminalNotificationReceipt,
	persistTerminalNotificationRequest,
	readDeliverableTerminalNotificationRequest,
	readTerminalNotificationRequest,
	recoverStaleRunTerminalNotification,
	removeTerminalNotificationOutbox,
	renderTerminalNotificationPayload,
	terminalNotificationReceiptPath,
	terminalNotificationRequestPath,
} from "../packages/hyperchart/src/runtime/generic/terminal_notifications.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "terminal-notification-"));
	roots.push(root);
	return root;
}

function normalized(config: Parameters<typeof normalizeChartConfig>[0]): ChartAst {
	const parsed = normalizeChartConfig(config);
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
	return parsed.ast;
}

function action(ast: ChartAst, state: string): StateActionAst {
	const node = ast.states[state];
	if (node?.kind !== "state") throw new Error(`Expected action state ${state}`);
	return node.action;
}

describe("terminal notification outbox", () => {
	it("renders scoped prompts and authoritative artifact paths", () => {
		const root = tempRoot();
		const workDir = join(root, "project");
		mkdirSync(workDir);
		const ast = normalized(chart({
			kind: "chart",
			id: "notify",
			initial: "prepare",
			states: {
				prepare: {
					kind: "state",
					action: agent("prepare"),
					transitions: { READY: { target: "work", input: { topic: event("topic") } } },
				},
				work: {
					kind: "state",
					input: { topic: z.string() },
					action: agent("work", { artifacts: { report: artifact(t`artifacts/${input("topic")}.txt`) } }),
					transitions: { DONE: "done" },
				},
				done: final({ notify: {
					scope: "work",
					prompt: t`Published ${input("topic")}: ${result("work", "summary")}`,
					artifacts: [artifactOf("work", { artifact: "report" })],
				} }),
			},
		}));
		const prepareUid = action(ast, "prepare").uid;
		const workUid = action(ast, "work").uid;
		const log: DurableLogRecord[] = [
			{ type: "state_action", kind: "invoke", actionUid: prepareUid, definition: action(ast, "prepare"), parentId: 0, seqId: 1, branchId: "main", timestamp: 1 },
			{ type: "state_action", kind: "complete", actionUid: prepareUid, event: { type: "READY", output: { topic: "alpha" } }, parentId: 1, seqId: 2, branchId: "main", timestamp: 2 },
			{ type: "state_action", kind: "invoke", actionUid: workUid, definition: action(ast, "work"), parentId: 2, seqId: 3, branchId: "main", timestamp: 3 },
			{ type: "state_action", kind: "complete", actionUid: workUid, event: { type: "DONE", output: { summary: "ready" } }, parentId: 3, seqId: 4, branchId: "main", timestamp: 4 },
		];
		const state = createMachine(ast, projectBranch(createBranchProjection(ast), ast, log));
		const payload = renderTerminalNotificationPayload(state, { runId: "run", branchId: "main", runDir: join(root, "run"), workDir, outcome: "complete" });

		expect(payload.prompt).toContain("Published alpha: ready");
		expect(payload.artifacts).toEqual([join(workDir, "artifacts", "alpha.txt")]);
		expect(payload.prompt).toContain(join(workDir, "artifacts", "alpha.txt"));
	});

	it("gates delivery on matching terminal status and keeps receipts idempotent", () => {
		const runDir = join(tempRoot(), "run");
		mkdirSync(runDir);
		const ast = normalized(chart({ kind: "chart", id: "done", initial: "done", states: { done: final() } }));
		const state = createMachine(ast, projectBranch(createBranchProjection(ast), ast, []));
		const payload = renderTerminalNotificationPayload(state, { runId: "run", branchId: "main", runDir, workDir: runDir, outcome: "complete" });
		const first = persistTerminalNotificationRequest(runDir, payload);
		expect(persistTerminalNotificationRequest(runDir, payload)).toEqual(first);
		expect(() => persistTerminalNotificationRequest(runDir, { ...payload, prompt: "different" })).toThrow(/conflict/);

		patchRunStatus(runDir, { runId: "run",branchId: "main", chartId: "done", state: "running", heartbeatAt: Date.now() });
		expect(readDeliverableTerminalNotificationRequest(runDir)).toBeUndefined();
		patchRunStatus(runDir, { state: "failed" });
		expect(readDeliverableTerminalNotificationRequest(runDir)).toBeUndefined();
		patchRunStatus(runDir, { state: "complete" });
		expect(readDeliverableTerminalNotificationRequest(runDir)?.requestId).toBe(first.requestId);

		expect(hasTerminalNotificationReceipt(runDir, "pi", "session")).toBe(false);
		const receipt = markTerminalNotificationReceipt(runDir, first.requestId, "pi", "session");
		expect(markTerminalNotificationReceipt(runDir, first.requestId, "pi", "session")).toEqual(receipt);
		expect(hasTerminalNotificationReceipt(runDir, "pi", "session")).toBe(true);
	});

	it("archives a failed attempt before a resumed attempt publishes success", () => {
		const runDir = join(tempRoot(), "run");
		mkdirSync(runDir);
		const failed = persistTerminalNotificationRequest(runDir, {
			runId: "run", branchId: "main", runDir, chartId: "chart", outcome: "failed", prompt: "first attempt failed", artifacts: [], error: "stale provenance",
		});
		markTerminalNotificationReceipt(runDir, failed.requestId, "pi", "session");
		patchRunStatus(runDir, { runId: "run",branchId: "main", chartId: "chart", state: "starting" });

		const archiveDir = archiveTerminalNotificationGeneration(runDir);
		expect(archiveDir).toBeDefined();
		expect(readTerminalNotificationRequest(runDir)).toBeUndefined();
		expect(JSON.parse(readFileSync(join(archiveDir!, "request.json"), "utf8"))).toEqual(failed);
		const receiptRelativePath = relative(join(runDir, "terminal-notification"), terminalNotificationReceiptPath(runDir, failed.requestId, "pi", "session"));
		expect(existsSync(join(archiveDir!, receiptRelativePath))).toBe(true);

		const complete = persistTerminalNotificationRequest(runDir, {
			runId: "run", branchId: "main", runDir, chartId: "chart", outcome: "complete", prompt: "resumed attempt completed", artifacts: [],
		});
		expect(complete.requestId).not.toBe(failed.requestId);
		patchRunStatus(runDir, { state: "complete" });
		expect(readDeliverableTerminalNotificationRequest(runDir)?.requestId).toBe(complete.requestId);
	});

	it("never claims or confirms a cached request after its generation is replaced", () => {
		const runDir = join(tempRoot(), "run");
		mkdirSync(runDir);
		const oldRequest = persistTerminalNotificationRequest(runDir, {
			runId: "run", branchId: "main", runDir, chartId: "chart", outcome: "failed", prompt: "old failure", artifacts: [], error: "old failure",
		});
		patchRunStatus(runDir, { runId: "run",branchId: "main", chartId: "chart", state: "starting" });
		archiveTerminalNotificationGeneration(runDir);
		const newRequest = persistTerminalNotificationRequest(runDir, {
			runId: "run", branchId: "main", runDir, chartId: "chart", outcome: "complete", prompt: "new success", artifacts: [],
		});
		patchRunStatus(runDir, { state: "complete" });

		expect(claimTerminalNotificationReceipt(runDir, oldRequest.requestId, "pi", "session")).toBe(false);
		expect(() => markTerminalNotificationReceipt(runDir, oldRequest.requestId, "pi", "session")).toThrow(/no longer active/);
		expect(claimTerminalNotificationReceipt(runDir, newRequest.requestId, "pi", "session")).toBe(true);
		expect(hasTerminalNotificationReceipt(runDir, "pi", "session")).toBe(false);
		markTerminalNotificationReceipt(runDir, newRequest.requestId, "pi", "session");
		expect(hasTerminalNotificationReceipt(runDir, "pi", "session")).toBe(true);

		const stalePath = terminalNotificationReceiptPath(runDir, oldRequest.requestId, "pi", "session");
		mkdirSync(dirname(stalePath), { recursive: true });
		writeFileSync(stalePath, `${JSON.stringify({
			version: 1, requestId: oldRequest.requestId, host: "pi", sessionId: "session", state: "confirmed", deliveredAt: new Date().toISOString(),
		})}\n`);
		expect(hasTerminalNotificationReceipt(runDir, "pi", "session")).toBe(true);
	});

	it("gives a recreated post-rewind outbox a fresh identity even for an identical payload", () => {
		const runDir = join(tempRoot(), "run");
		mkdirSync(runDir);
		const payload = {
			runId: "run",
			branchId: "main",
			runDir,
			chartId: "chart",
			outcome: "complete" as const,
			prompt: "same terminal payload",
			artifacts: [],
		};
		const beforeRewind = persistTerminalNotificationRequest(runDir, payload);
		expect(persistTerminalNotificationRequest(runDir, payload).requestId).toBe(beforeRewind.requestId);
		removeTerminalNotificationOutbox(runDir);
		const afterRewind = persistTerminalNotificationRequest(runDir, payload);
		expect(afterRewind.requestId).not.toBe(beforeRewind.requestId);
	});

	it("reclaims an unconfirmed delivery after its lease but never reclaims a confirmation", () => {
		const runDir = join(tempRoot(), "run");
		mkdirSync(runDir);
		const request = persistTerminalNotificationRequest(runDir, {
			runId: "run", branchId: "main", runDir, chartId: "chart", outcome: "complete", prompt: "done", artifacts: [],
		});
		expect(claimTerminalNotificationReceipt(runDir, request.requestId, "claude", "session", { now: 1_000, leaseMs: 100 })).toBe(true);
		expect(hasTerminalNotificationReceipt(runDir, "claude", "session")).toBe(false);
		expect(claimTerminalNotificationReceipt(runDir, request.requestId, "claude", "session", { now: 1_050, leaseMs: 100 })).toBe(false);
		expect(claimTerminalNotificationReceipt(runDir, request.requestId, "claude", "session", { now: 1_101, leaseMs: 100 })).toBe(true);
		markTerminalNotificationReceipt(runDir, request.requestId, "claude", "session");
		expect(hasTerminalNotificationReceipt(runDir, "claude", "session")).toBe(true);
		expect(claimTerminalNotificationReceipt(runDir, request.requestId, "claude", "session", { now: 10_000, leaseMs: 100 })).toBe(false);
	});

	it("recovers a stale dead run by writing the failed request before terminal status", () => {
		const runDir = join(tempRoot(), "run");
		mkdirSync(runDir);
		patchRunStatus(runDir, {
			runId: "run",
		branchId: "main",
			chartId: "chart",
			state: "running",
			heartbeatAt: 1,
			error: "worker crashed",
		});

		const request = recoverStaleRunTerminalNotification(runDir, 20_000);
		expect(request?.payload).toMatchObject({ outcome: "failed", error: "worker crashed" });
		expect(readFileSync(terminalNotificationRequestPath(runDir), "utf8")).toContain("worker crashed");
		expect(readRunStatus(runDir)).toMatchObject({ state: "failed", error: "worker crashed", exitCode: 1 });
		expect(readDeliverableTerminalNotificationRequest(runDir)?.requestId).toBe(request?.requestId);
	});

	it("preserves a same-attempt outbox written before a hard crash and terminalizes status to its outcome", () => {
		const runDir = join(tempRoot(), "run");
		mkdirSync(runDir);
		patchRunStatus(runDir, {
			runId: "run",
		branchId: "main",
			chartId: "chart",
			state: "running",
			pid: 999_999_999,
			heartbeatAt: 1,
		});
		const request = persistTerminalNotificationRequest(runDir, {
			runId: "run",
			branchId: "main",
			runDir,
			chartId: "chart",
			outcome: "complete",
			prompt: "completed before status write",
			artifacts: [],
		});

		expect(recoverStaleRunTerminalNotification(runDir, 20_000)?.requestId).toBe(request.requestId);
		expect(readRunStatus(runDir)).toMatchObject({ state: "complete", exitCode: 0 });
		expect(readDeliverableTerminalNotificationRequest(runDir)?.requestId).toBe(request.requestId);
	});

	it("fails a dead resumed attempt instead of inheriting its predecessor before archival", () => {
		const runDir = join(tempRoot(), "run");
		mkdirSync(runDir);
		patchRunStatus(runDir, { runId: "run",branchId: "main", chartId: "chart", state: "complete", attemptId: "attempt-old" });
		const previous = persistTerminalNotificationRequest(runDir, {
			runId: "run", branchId: "main", runDir, chartId: "chart", outcome: "complete", prompt: "previous success", artifacts: [],
		});
		patchRunStatus(runDir, {
			state: "starting",
			attemptId: "attempt-new",
			pid: 999_999_999,
			heartbeatAt: 1,
			error: "resumed runner died before archival",
		});

		const recovered = recoverStaleRunTerminalNotification(runDir, 20_000);
		expect(recovered?.requestId).not.toBe(previous.requestId);
		expect(recovered?.attemptId).toBe("attempt-new");
		expect(recovered?.payload).toMatchObject({ outcome: "failed", error: "resumed runner died before archival" });
		expect(readRunStatus(runDir)).toMatchObject({ state: "failed", attemptId: "attempt-new", exitCode: 1 });
		expect(readDeliverableTerminalNotificationRequest(runDir)?.requestId).toBe(recovered?.requestId);
	});

	it("preserves explicit failed outcomes independently of final names", () => {
		const ast = normalized(chart({ kind: "chart", id: "named", initial: "done", states: { done: failed() } }));
		expect(ast.states.done).toMatchObject({ kind: "final", outcome: "failed" });
	});
});
