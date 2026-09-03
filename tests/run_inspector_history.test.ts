import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableLogRecord, DurableRecordDraft } from "../packages/hyperchart/src/core/durable_events.js";
import { createRunInspectorDataSource } from "../packages/hyperchart/src/inspect/run_history.js";
import { actorMessageHistoryItemToHost, stateVisitHistoryItemToHost } from "../packages/hyperchart/src/inspect/history_mapping.js";
import { actorPoolAst, actorPoolCompleteRecords, actorPoolOutOfOrderRun } from "../packages/hyperchart/src/react/fixtures/actor-fixtures.js";
import { parseChartModuleSync } from "../packages/hyperchart/src/core/inspect.js";
import { JsonlLogStore } from "../packages/hyperchart/src/runtime/generic/log_store.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "hyperchart-history-source-"));
	roots.push(root);
	const runDir = join(root, "run-1");
	mkdirSync(join(runDir, "sessions"), { recursive: true });
	const chartPath = join(root, "chart.ts");
	writeFileSync(chartPath, `import { chart, final } from "@surprisal/hyperchart"; export default chart({ kind: "chart", id: "history", initial: "done", states: { done: final() } });\n`);
	const store = new JsonlLogStore(join(runDir, "log.jsonl"));
	await store.writeRunMeta({ chartPath, workDir: root, chartId: "history", createdAt: new Date(0).toISOString() });
	await store.initializeRootBranch();
	for (let batch = 0; batch < 101; batch++) {
		await store.appendDrafts([{
			type: "actor_messages_enqueued",
			occurrence: "worker",
			generation: 1,
			source: {
				producerState: "send",
				kind: "sendBatch",
				definition: { kind: "sendBatch" },
				targetDeclaration: "worker",
				event: "TASK",
				inputSchema: { kind: "schema", schema: {} },
			},
			messages: [0, 1].map((index) => ({
				messageId: `batch-${batch}-message-${index}`,
				event: "TASK",
				input: { batch, index },
				producerState: "send",
				producerVisit: batch + 1,
				batchIndex: index,
			})),
		} as unknown as DurableRecordDraft]);
	}
	return { runDir, store };
}

describe("run inspector stateless history source", () => {
	it("maps a visit with the AST and its parent projection so rendered inputs stay concrete", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-history-render-"));
		roots.push(root);
		const runDir = join(root, "render-run");
		mkdirSync(join(runDir, "sessions"), { recursive: true });
		const chartPath = join(root, "render.chart.ts");
		writeFileSync(chartPath, `import { arg, chart, final, script, t } from "@surprisal/hyperchart"; export default chart({ kind: "chart", id: "render", initial: "work", states: { work: { kind: "state", action: script("echo", [], { env: { TOPIC: t\`topic=\${arg("topic")}\` } }), transitions: { DONE: "done" } }, done: final() } });\n`);
		const parsed = parseChartModuleSync(chartPath);
		if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
		const action = parsed.ast.states.work;
		if (action?.kind !== "state") throw new Error("work action missing");
		const store = new JsonlLogStore(join(runDir, "log.jsonl"));
		await store.writeRunMeta({ chartPath, workDir: root, chartId: "render", createdAt: new Date(0).toISOString() });
		await store.initializeRootBranch();
		await store.appendDrafts([
			{ type: "args", args: { topic: "cursor chunks" } },
			{ type: "state_action", kind: "invoke", actionUid: action.action.uid, sessionId: "visit-session", definition: action.action },
		]);
		writeFileSync(join(runDir, "sessions", "progress.json"), JSON.stringify({
			version: 1,
			updatedAt: 3,
			sessions: {
				visit: {
					actionKey: "history:work:script",
					actionUid: action.action.uid,
					branchId: "main",
					invokeSeqId: 2,
					visit: 1,
					actionName: "script",
					status: "completed",
					startedAt: 2,
					lastActivityAt: 3,
					turnCount: 0,
					toolCount: 0,
				},
			},
		}));
		const source = await createRunInspectorDataSource(runDir);
		const snapshot = await store.captureSnapshot("main");
		const visits = await source.readStateVisits({ runId: "render-run", snapshot, stateId: "work" });
		expect(visits.items).toHaveLength(1);
		expect(visits.items[0]?.invocation).toMatchObject({ kind: "script", env: { TOPIC: "topic=cursor chunks" } });
		expect(visits.items[0]?.visit).toBe(1);
		expect(visits.items[0]?.session).toBeUndefined();
		await expect(source.readVisitSession({ runId: "render-run", branchId: "main", invokeSeqId: 2 })).resolves.toMatchObject({ actionKey: "history:work:script", status: "completed" });
	});

	it("uses full replay semantics for a timed-out lazy visit", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-history-timeout-")); roots.push(root);
		const runDir = join(root, "timeout-run"); mkdirSync(join(runDir, "sessions"), { recursive: true });
		const chartPath = join(root, "timeout.chart.ts");
		writeFileSync(chartPath, `import { chart, final, script } from "@surprisal/hyperchart"; export default chart({ kind: "chart", id: "timeout", initial: "work", states: { work: { kind: "state", action: script("true"), after: { delayMs: 10, target: "timed" }, transitions: { DONE: "done" } }, timed: final(), done: final() } });`);
		const parsed = parseChartModuleSync(chartPath); if (!parsed.ok) throw new Error("timeout fixture invalid");
		const action = parsed.ast.states.work; if (action?.kind !== "state") throw new Error("timeout action missing");
		const store = new JsonlLogStore(join(runDir, "log.jsonl")); await store.writeRunMeta({ chartPath, workDir: root, chartId: "timeout", createdAt: new Date(0).toISOString() }); await store.initializeRootBranch();
		await store.appendDrafts([{ type: "args", args: {} }, { type: "state_action", kind: "invoke", actionUid: action.action.uid, sessionId: "session", definition: action.action }, { type: "state_action", kind: "timer_fired", actionUid: action.action.uid }]);
		const source = await createRunInspectorDataSource(runDir); const snapshot = await store.captureSnapshot("main");
		const visits = await source.readStateVisits({ runId: "timeout-run", snapshot, stateId: "work" });
		expect(visits.items[0]).toMatchObject({ status: "cancelled", endedReason: "timed_out" });
	});

	it("does not hide a failed completion after validation attempts", () => {
		const actionUid = { chart: "validated", state: "work", action: "agent" };
		const invoke = { type: "state_action", kind: "invoke", actionUid, sessionId: "session", definition: { kind: "agent", uid: actionUid, name: "worker" }, seqId: 1, parentId: null, branchId: "main", timestamp: 1 } as const;
		const validated = { type: "state_action", kind: "validated", actionUid, event: { type: "DONE" }, guard: { kind: "tsImport", module: "./check.js", export: "ok" }, outcome: { ok: false, reason: "retry" }, seqId: 2, parentId: 1, branchId: "main", timestamp: 2 } as const;
		const complete = { type: "state_action", kind: "complete", actionUid, event: { type: "FAILED", error: "retry failed" }, seqId: 3, parentId: 2, branchId: "main", timestamp: 3 } as const;
		const visit = stateVisitHistoryItemToHost({ kind: "state-visit", state: "work", seqId: 1, visit: 1, invoke, records: [invoke, validated, complete] });
		expect(visit).toMatchObject({ status: "failed", endedAt: 3, completedEvent: "FAILED", validationAttempts: 1 });
	});

	it("keeps multi-message enqueues as bounded batch rows without overflow or drops", async () => {
		const { runDir, store } = await fixture();
		const source = await createRunInspectorDataSource(runDir);
		const snapshot = await store.captureSnapshot("main");
		const first = await source.readActorMessages({ runId: "run-1", snapshot, occurrence: "worker" });
		expect(first.items).toHaveLength(100);
		expect(first.items.flatMap((batch) => batch.messages)).toHaveLength(200);
		expect(new Set(first.items.map((batch) => batch.enqueueSeqId)).size).toBe(100);
		expect(first.older).toBeDefined();
		const second = await source.readActorMessages({ runId: "run-1", snapshot, occurrence: "worker", cursor: first.older! });
		expect(second.items).toHaveLength(1);
		expect(second.items[0]?.messages.map((message) => message.messageId)).toEqual(["batch-0-message-0", "batch-0-message-1"]);
		expect(second.newer).toBeDefined();
		const targetSeqId = first.items[50]!.enqueueSeqId;
		const at = await source.cursorAt({ runId: "run-1", snapshot, subject: { kind: "actor-messages", occurrence: "worker" }, seqId: targetSeqId });
		expect(at).toBeDefined();
		const targeted = await source.readActorMessages({ runId: "run-1", snapshot, occurrence: "worker", cursor: at! });
		expect(targeted.items[0]?.enqueueSeqId).toBe(targetSeqId);
		expect(targeted.newer).toBeDefined();
	});

	it("preserves full AST-aware pool worker and reply identity", () => {
		const enqueued = actorPoolCompleteRecords.find((record): record is Extract<DurableLogRecord, { type: "actor_messages_enqueued" }> => record.type === "actor_messages_enqueued");
		if (enqueued === undefined) throw new Error("pool enqueue fixture missing");
		const records = actorPoolCompleteRecords.filter((record) => record.seqId >= enqueued.seqId && (record.type !== "actor_message" || record.occurrence === enqueued.occurrence));
		const batch = actorMessageHistoryItemToHost({ kind: "actor-message-batch", occurrence: enqueued.occurrence, seqId: enqueued.seqId, enqueued, records }, actorPoolAst, actorPoolCompleteRecords);
		const expected = actorPoolOutOfOrderRun.actorOccurrences?.[0]?.mailboxInstances.flatMap((instance) => instance.messageHistory ?? []) ?? [];
		for (const message of batch.messages) {
			const parity = expected.find((candidate) => candidate.messageId === message.messageId);
			if (parity === undefined || parity.workerIndex === undefined) throw new Error("host actor message parity fixture missing");
			expect(message).toMatchObject({
				actorOccurrencePath: "@workers",
				actorLogicalPath: "@workers",
				workerIndex: parity?.workerIndex,
				workerOccurrencePath: parity?.workerOccurrencePath,
				receiveState: parity?.receiveState,
				replyState: `@workers.$worker-${parity.workerIndex}.settle`,
				replySchema: parity.replySchema,
				validation: parity.validation,
				status: parity.status,
			});
		}
	});

	it("binds every request to its run and snapshot", async () => {
		const { runDir, store } = await fixture();
		const source = await createRunInspectorDataSource(runDir);
		const snapshot = await store.captureSnapshot("main");
		await expect(source.readRecords({ runId: "another-run", snapshot })).rejects.toThrow(/bound to run/);
		const records = await source.readRecords({ runId: "run-1", snapshot });
		expect(records.items.length).toBeLessThanOrEqual(100);
		expect(records.items.every((record) => record.record !== undefined)).toBe(true);
	});
});
