import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
	claimTerminalNotificationReceipt,
	hasTerminalNotificationReceipt,
	markTerminalNotificationReceipt,
	persistTerminalNotificationRequest,
	readDeliverableTerminalNotificationRequest,
	recoverStaleRunTerminalNotification,
	removeTerminalNotificationOutbox,
	renderTerminalNotificationPayload,
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
			{ type: "state_action", kind: "invoke", actionUid: prepareUid, definition: action(ast, "prepare"), parentId: 0, seqId: 1, timestamp: 1 },
			{ type: "state_action", kind: "complete", actionUid: prepareUid, event: { type: "READY", output: { topic: "alpha" } }, parentId: 1, seqId: 2, timestamp: 2 },
			{ type: "state_action", kind: "invoke", actionUid: workUid, definition: action(ast, "work"), parentId: 2, seqId: 3, timestamp: 3 },
			{ type: "state_action", kind: "complete", actionUid: workUid, event: { type: "DONE", output: { summary: "ready" } }, parentId: 3, seqId: 4, timestamp: 4 },
		];
		const state = createMachine(ast, projectBranch(createBranchProjection(ast), ast, log));
		const payload = renderTerminalNotificationPayload(state, { runId: "run", runDir: join(root, "run"), workDir, outcome: "complete" });

		expect(payload.prompt).toContain("Published alpha: ready");
		expect(payload.artifacts).toEqual([join(workDir, "artifacts", "alpha.txt")]);
		expect(payload.prompt).toContain(join(workDir, "artifacts", "alpha.txt"));
	});

	it("gates delivery on matching terminal status and keeps receipts idempotent", () => {
		const runDir = join(tempRoot(), "run");
		mkdirSync(runDir);
		const ast = normalized(chart({ kind: "chart", id: "done", initial: "done", states: { done: final() } }));
		const state = createMachine(ast, projectBranch(createBranchProjection(ast), ast, []));
		const payload = renderTerminalNotificationPayload(state, { runId: "run", runDir, workDir: runDir, outcome: "complete" });
		const first = persistTerminalNotificationRequest(runDir, payload);
		expect(persistTerminalNotificationRequest(runDir, payload)).toEqual(first);
		expect(() => persistTerminalNotificationRequest(runDir, { ...payload, prompt: "different" })).toThrow(/conflict/);

		patchRunStatus(runDir, { runId: "run", chartId: "done", state: "running", heartbeatAt: Date.now() });
		expect(readDeliverableTerminalNotificationRequest(runDir)).toBeUndefined();
		patchRunStatus(runDir, { state: "failed" });
		expect(readDeliverableTerminalNotificationRequest(runDir)).toBeUndefined();
		patchRunStatus(runDir, { state: "complete" });
		expect(readDeliverableTerminalNotificationRequest(runDir)?.requestId).toBe(first.requestId);

		expect(hasTerminalNotificationReceipt(runDir, "pi", "session")).toBe(false);
		const receipt = markTerminalNotificationReceipt(runDir, "pi", "session");
		expect(markTerminalNotificationReceipt(runDir, "pi", "session")).toEqual(receipt);
		expect(hasTerminalNotificationReceipt(runDir, "pi", "session")).toBe(true);
	});

	it("gives a recreated post-rewind outbox a fresh identity even for an identical payload", () => {
		const runDir = join(tempRoot(), "run");
		mkdirSync(runDir);
		const payload = {
			runId: "run",
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
		persistTerminalNotificationRequest(runDir, {
			runId: "run", runDir, chartId: "chart", outcome: "complete", prompt: "done", artifacts: [],
		});
		expect(claimTerminalNotificationReceipt(runDir, "claude", "session", { now: 1_000, leaseMs: 100 })).toBe(true);
		expect(hasTerminalNotificationReceipt(runDir, "claude", "session")).toBe(false);
		expect(claimTerminalNotificationReceipt(runDir, "claude", "session", { now: 1_050, leaseMs: 100 })).toBe(false);
		expect(claimTerminalNotificationReceipt(runDir, "claude", "session", { now: 1_101, leaseMs: 100 })).toBe(true);
		markTerminalNotificationReceipt(runDir, "claude", "session");
		expect(hasTerminalNotificationReceipt(runDir, "claude", "session")).toBe(true);
		expect(claimTerminalNotificationReceipt(runDir, "claude", "session", { now: 10_000, leaseMs: 100 })).toBe(false);
	});

	it("recovers a stale dead run by writing the failed request before terminal status", () => {
		const runDir = join(tempRoot(), "run");
		mkdirSync(runDir);
		patchRunStatus(runDir, {
			runId: "run",
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

	it("preserves an outbox written before a hard crash and terminalizes status to its outcome", () => {
		const runDir = join(tempRoot(), "run");
		mkdirSync(runDir);
		const request = persistTerminalNotificationRequest(runDir, {
			runId: "run",
			runDir,
			chartId: "chart",
			outcome: "complete",
			prompt: "completed before status write",
			artifacts: [],
		});
		patchRunStatus(runDir, {
			runId: "run",
			chartId: "chart",
			state: "running",
			pid: 999_999_999,
			heartbeatAt: 1,
		});

		expect(recoverStaleRunTerminalNotification(runDir, 20_000)?.requestId).toBe(request.requestId);
		expect(readRunStatus(runDir)).toMatchObject({ state: "complete", exitCode: 0 });
		expect(readDeliverableTerminalNotificationRequest(runDir)?.requestId).toBe(request.requestId);
	});

	it("preserves explicit failed outcomes independently of final names", () => {
		const ast = normalized(chart({ kind: "chart", id: "named", initial: "done", states: { done: failed() } }));
		expect(ast.states.done).toMatchObject({ kind: "final", outcome: "failed" });
	});
});
