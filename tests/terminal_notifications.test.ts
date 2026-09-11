import {
	withRunStorage,
	resolveRunPaths,
	type RunStorage,
} from "../packages/hyperchart/src/runtime/generic/run_paths.js";
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
	terminalNotificationReceiptPath,
	terminalNotificationRequestPath,
} from "../packages/hyperchart/src/runtime/generic/terminal_notifications.js";
import { renderTerminalNotificationPayload } from "../packages/hyperchart/src/execution/terminal_notification.js";

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
		const ast = normalized(
			chart({
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
					done: final({
						notify: {
							scope: "work",
							prompt: t`Published ${input("topic")}: ${result("work", "summary")}`,
							artifacts: [artifactOf("work", { artifact: "report" })],
						},
					}),
				},
			}),
		);
		const prepareUid = action(ast, "prepare").uid;
		const workUid = action(ast, "work").uid;
		const log: DurableLogRecord[] = [
			{
				type: "state_action",
				kind: "invoke",
				sessionId: "session-id",
				actionUid: prepareUid,
				definition: action(ast, "prepare"),
				parentId: 0,
				seqId: 1,
				branchId: "main",
				timestamp: 1,
			},
			{
				type: "state_action",
				kind: "complete",
				actionUid: prepareUid,
				event: { type: "READY", output: { topic: "alpha" } },
				parentId: 1,
				seqId: 2,
				branchId: "main",
				timestamp: 2,
			},
			{
				type: "state_action",
				kind: "invoke",
				sessionId: "session-id",
				actionUid: workUid,
				definition: action(ast, "work"),
				parentId: 2,
				seqId: 3,
				branchId: "main",
				timestamp: 3,
			},
			{
				type: "state_action",
				kind: "complete",
				actionUid: workUid,
				event: { type: "DONE", output: { summary: "ready" } },
				parentId: 3,
				seqId: 4,
				branchId: "main",
				timestamp: 4,
			},
		];
		const state = createMachine(ast, projectBranch(createBranchProjection(ast), ast, log));
		const payload = renderTerminalNotificationPayload(state, {
			runId: "run",
			branchId: "main",
			workDir,
			outcome: "complete",
		});

		expect(payload.prompt).toContain("Published alpha: ready");
		expect(payload.artifacts).toEqual([join(workDir, "artifacts", "alpha.txt")]);
		expect(payload.prompt).toContain(join(workDir, "artifacts", "alpha.txt"));
	});

	it("gates delivery on matching terminal status and keeps receipts idempotent", () => {
		const storage: RunStorage = { kind: "jsonl", rootDir: tempRoot(), layout: "sha256" };
		const runId = "run";
		const runDir = resolveRunPaths(runId, storage).runDir;
		mkdirSync(runDir);
		const ast = normalized(chart({ kind: "chart", id: "done", initial: "done", states: { done: final() } }));
		const state = createMachine(ast, projectBranch(createBranchProjection(ast), ast, []));
		const payload = renderTerminalNotificationPayload(state, {
			runId: "run",
			branchId: "main",
			workDir: runDir,
			outcome: "complete",
		});
		withRunStorage(storage, () =>
			patchRunStatus(runId, { branchIds: ["main"], chartId: "done", state: "starting", attemptId: "attempt-current" }),
		);
		const first = withRunStorage(storage, () => persistTerminalNotificationRequest(runId, payload));
		expect(withRunStorage(storage, () => persistTerminalNotificationRequest(runId, payload))).toEqual(first);
		expect(() =>
			withRunStorage(storage, () => persistTerminalNotificationRequest(runId, { ...payload, prompt: "different" })),
		).toThrow(/conflict/);

		withRunStorage(storage, () => patchRunStatus(runId, { state: "running", heartbeatAt: Date.now() }));
		expect(withRunStorage(storage, () => readDeliverableTerminalNotificationRequest(runId))).toBeUndefined();
		withRunStorage(storage, () => patchRunStatus(runId, { state: "failed" }));
		expect(withRunStorage(storage, () => readDeliverableTerminalNotificationRequest(runId))).toBeUndefined();
		withRunStorage(storage, () => patchRunStatus(runId, { state: "complete", branchIds: [] }));
		expect(withRunStorage(storage, () => readDeliverableTerminalNotificationRequest(runId))?.requestId).toBe(
			first.requestId,
		);

		expect(withRunStorage(storage, () => hasTerminalNotificationReceipt(runId, "pi", "session"))).toBe(false);
		const receipt = withRunStorage(storage, () =>
			markTerminalNotificationReceipt(runId, first.requestId, "pi", "session"),
		);
		expect(
			withRunStorage(storage, () => markTerminalNotificationReceipt(runId, first.requestId, "pi", "session")),
		).toEqual(receipt);
		expect(withRunStorage(storage, () => hasTerminalNotificationReceipt(runId, "pi", "session"))).toBe(true);
	});

	it("archives a failed attempt before a resumed attempt publishes success", () => {
		const storage: RunStorage = { kind: "jsonl", rootDir: tempRoot(), layout: "sha256" };
		const runId = "run";
		const runDir = resolveRunPaths(runId, storage).runDir;
		mkdirSync(runDir);
		const failed = withRunStorage(storage, () =>
			persistTerminalNotificationRequest(runId, {
				runId: "run",
				branchId: "main",
				chartId: "chart",
				outcome: "failed",
				prompt: "first attempt failed",
				artifacts: [],
				error: "stale provenance",
			}),
		);
		withRunStorage(storage, () => markTerminalNotificationReceipt(runId, failed.requestId, "pi", "session"));
		withRunStorage(storage, () => patchRunStatus(runId, { branchIds: ["main"], chartId: "chart", state: "starting" }));

		const archiveDir = withRunStorage(storage, () => archiveTerminalNotificationGeneration(runId));
		expect(archiveDir).toBeDefined();
		expect(withRunStorage(storage, () => readTerminalNotificationRequest(runId))).toBeUndefined();
		expect(JSON.parse(readFileSync(join(archiveDir!, "request.json"), "utf8"))).toEqual(failed);
		const receiptRelativePath = relative(
			join(runDir, "terminal-notification"),
			withRunStorage(storage, () => terminalNotificationReceiptPath(runId, failed.requestId, "pi", "session")),
		);
		expect(existsSync(join(archiveDir!, receiptRelativePath))).toBe(true);

		const complete = withRunStorage(storage, () =>
			persistTerminalNotificationRequest(runId, {
				runId: "run",
				branchId: "main",
				chartId: "chart",
				outcome: "complete",
				prompt: "resumed attempt completed",
				artifacts: [],
			}),
		);
		expect(complete.requestId).not.toBe(failed.requestId);
		withRunStorage(storage, () => patchRunStatus(runId, { state: "complete" }));
		expect(withRunStorage(storage, () => readDeliverableTerminalNotificationRequest(runId))?.requestId).toBe(
			complete.requestId,
		);
	});

	it("never claims or confirms a cached request after its generation is replaced", () => {
		const storage: RunStorage = { kind: "jsonl", rootDir: tempRoot(), layout: "sha256" };
		const runId = "run";
		const runDir = resolveRunPaths(runId, storage).runDir;
		mkdirSync(runDir);
		const oldRequest = withRunStorage(storage, () =>
			persistTerminalNotificationRequest(runId, {
				runId: "run",
				branchId: "main",
				chartId: "chart",
				outcome: "failed",
				prompt: "old failure",
				artifacts: [],
				error: "old failure",
			}),
		);
		withRunStorage(storage, () => patchRunStatus(runId, { branchIds: ["main"], chartId: "chart", state: "starting" }));
		withRunStorage(storage, () => archiveTerminalNotificationGeneration(runId));
		const newRequest = withRunStorage(storage, () =>
			persistTerminalNotificationRequest(runId, {
				runId: "run",
				branchId: "main",
				chartId: "chart",
				outcome: "complete",
				prompt: "new success",
				artifacts: [],
			}),
		);
		withRunStorage(storage, () => patchRunStatus(runId, { state: "complete" }));

		expect(
			withRunStorage(storage, () => claimTerminalNotificationReceipt(runId, oldRequest.requestId, "pi", "session")),
		).toBe(false);
		expect(() =>
			withRunStorage(storage, () => markTerminalNotificationReceipt(runId, oldRequest.requestId, "pi", "session")),
		).toThrow(/no longer active/);
		expect(
			withRunStorage(storage, () => claimTerminalNotificationReceipt(runId, newRequest.requestId, "pi", "session")),
		).toBe(true);
		expect(withRunStorage(storage, () => hasTerminalNotificationReceipt(runId, "pi", "session"))).toBe(false);
		withRunStorage(storage, () => markTerminalNotificationReceipt(runId, newRequest.requestId, "pi", "session"));
		expect(withRunStorage(storage, () => hasTerminalNotificationReceipt(runId, "pi", "session"))).toBe(true);

		const stalePath = withRunStorage(storage, () =>
			terminalNotificationReceiptPath(runId, oldRequest.requestId, "pi", "session"),
		);
		mkdirSync(dirname(stalePath), { recursive: true });
		writeFileSync(
			stalePath,
			`${JSON.stringify({
				version: 1,
				requestId: oldRequest.requestId,
				host: "pi",
				sessionId: "session",
				state: "confirmed",
				deliveredAt: new Date().toISOString(),
			})}\n`,
		);
		expect(withRunStorage(storage, () => hasTerminalNotificationReceipt(runId, "pi", "session"))).toBe(true);
	});

	it("gives a recreated post-rewind outbox a fresh identity even for an identical payload", () => {
		const storage: RunStorage = { kind: "jsonl", rootDir: tempRoot(), layout: "sha256" };
		const runId = "run";
		const runDir = resolveRunPaths(runId, storage).runDir;
		mkdirSync(runDir);
		const payload = {
			runId: "run",
			branchId: "main",
			chartId: "chart",
			outcome: "complete" as const,
			prompt: "same terminal payload",
			artifacts: [],
		};
		const beforeRewind = withRunStorage(storage, () => persistTerminalNotificationRequest(runId, payload));
		expect(withRunStorage(storage, () => persistTerminalNotificationRequest(runId, payload)).requestId).toBe(
			beforeRewind.requestId,
		);
		withRunStorage(storage, () => removeTerminalNotificationOutbox(runId));
		const afterRewind = withRunStorage(storage, () => persistTerminalNotificationRequest(runId, payload));
		expect(afterRewind.requestId).not.toBe(beforeRewind.requestId);
	});

	it("reclaims an unconfirmed delivery after its lease but never reclaims a confirmation", () => {
		const storage: RunStorage = { kind: "jsonl", rootDir: tempRoot(), layout: "sha256" };
		const runId = "run";
		const runDir = resolveRunPaths(runId, storage).runDir;
		mkdirSync(runDir);
		const request = withRunStorage(storage, () =>
			persistTerminalNotificationRequest(runId, {
				runId: "run",
				branchId: "main",
				chartId: "chart",
				outcome: "complete",
				prompt: "done",
				artifacts: [],
			}),
		);
		expect(
			withRunStorage(storage, () =>
				claimTerminalNotificationReceipt(runId, request.requestId, "claude", "session", { now: 1_000, leaseMs: 100 }),
			),
		).toBe(true);
		expect(withRunStorage(storage, () => hasTerminalNotificationReceipt(runId, "claude", "session"))).toBe(false);
		expect(
			withRunStorage(storage, () =>
				claimTerminalNotificationReceipt(runId, request.requestId, "claude", "session", { now: 1_050, leaseMs: 100 }),
			),
		).toBe(false);
		expect(
			withRunStorage(storage, () =>
				claimTerminalNotificationReceipt(runId, request.requestId, "claude", "session", { now: 1_101, leaseMs: 100 }),
			),
		).toBe(true);
		withRunStorage(storage, () => markTerminalNotificationReceipt(runId, request.requestId, "claude", "session"));
		expect(withRunStorage(storage, () => hasTerminalNotificationReceipt(runId, "claude", "session"))).toBe(true);
		expect(
			withRunStorage(storage, () =>
				claimTerminalNotificationReceipt(runId, request.requestId, "claude", "session", { now: 10_000, leaseMs: 100 }),
			),
		).toBe(false);
	});

	it("recovers a stale dead run by writing the failed request before terminal status", () => {
		const storage: RunStorage = { kind: "jsonl", rootDir: tempRoot(), layout: "sha256" };
		const runId = "run";
		const runDir = resolveRunPaths(runId, storage).runDir;
		mkdirSync(runDir);
		withRunStorage(storage, () =>
			patchRunStatus(runId, {
				branchIds: ["main"],
				chartId: "chart",
				state: "running",
				heartbeatAt: 1,
				error: "worker crashed",
			}),
		);

		const request = withRunStorage(storage, () => recoverStaleRunTerminalNotification(runId, 20_000));
		expect(request?.payload).toMatchObject({ outcome: "failed", error: "worker crashed" });
		expect(
			readFileSync(
				withRunStorage(storage, () => terminalNotificationRequestPath(runId)),
				"utf8",
			),
		).toContain("worker crashed");
		expect(withRunStorage(storage, () => readRunStatus(runId))).toMatchObject({
			state: "failed",
			error: "worker crashed",
			exitCode: 1,
		});
		expect(withRunStorage(storage, () => readDeliverableTerminalNotificationRequest(runId))?.requestId).toBe(
			request?.requestId,
		);
	});

	it("preserves a same-attempt outbox written before a hard crash and terminalizes status to its outcome", () => {
		const storage: RunStorage = { kind: "jsonl", rootDir: tempRoot(), layout: "sha256" };
		const runId = "run";
		const runDir = resolveRunPaths(runId, storage).runDir;
		mkdirSync(runDir);
		withRunStorage(storage, () =>
			patchRunStatus(runId, {
				branchIds: ["main"],
				chartId: "chart",
				state: "running",
				pid: 999_999_999,
				heartbeatAt: 1,
			}),
		);
		const request = withRunStorage(storage, () =>
			persistTerminalNotificationRequest(runId, {
				runId: "run",
				branchId: "main",
				chartId: "chart",
				outcome: "complete",
				prompt: "completed before status write",
				artifacts: [],
			}),
		);

		expect(withRunStorage(storage, () => recoverStaleRunTerminalNotification(runId, 20_000))?.requestId).toBe(
			request.requestId,
		);
		expect(withRunStorage(storage, () => readRunStatus(runId))).toMatchObject({ state: "complete", exitCode: 0 });
		expect(withRunStorage(storage, () => readDeliverableTerminalNotificationRequest(runId))?.requestId).toBe(
			request.requestId,
		);
	});

	it("fails a dead resumed attempt instead of inheriting its predecessor before archival", () => {
		const storage: RunStorage = { kind: "jsonl", rootDir: tempRoot(), layout: "sha256" };
		const runId = "run";
		const runDir = resolveRunPaths(runId, storage).runDir;
		mkdirSync(runDir);
		withRunStorage(storage, () =>
			patchRunStatus(runId, { branchIds: ["main"], chartId: "chart", state: "complete", attemptId: "attempt-old" }),
		);
		const previous = withRunStorage(storage, () =>
			persistTerminalNotificationRequest(runId, {
				runId: "run",
				branchId: "main",
				chartId: "chart",
				outcome: "complete",
				prompt: "previous success",
				artifacts: [],
			}),
		);
		withRunStorage(storage, () =>
			patchRunStatus(runId, {
				state: "starting",
				attemptId: "attempt-new",
				pid: 999_999_999,
				heartbeatAt: 1,
				error: "resumed runner died before archival",
			}),
		);

		const recovered = withRunStorage(storage, () => recoverStaleRunTerminalNotification(runId, 20_000));
		expect(recovered?.requestId).not.toBe(previous.requestId);
		expect(recovered?.attemptId).toBe("attempt-new");
		expect(recovered?.payload).toMatchObject({ outcome: "failed", error: "resumed runner died before archival" });
		expect(withRunStorage(storage, () => readRunStatus(runId))).toMatchObject({
			state: "failed",
			attemptId: "attempt-new",
			exitCode: 1,
		});
		expect(withRunStorage(storage, () => readDeliverableTerminalNotificationRequest(runId))?.requestId).toBe(
			recovered?.requestId,
		);
	});

	it("preserves explicit failed outcomes independently of final names", () => {
		const ast = normalized(chart({ kind: "chart", id: "named", initial: "done", states: { done: failed() } }));
		expect(ast.states.done).toMatchObject({ kind: "final", outcome: "failed" });
	});
});
