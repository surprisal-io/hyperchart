import { captureReplayIncompatibleHistory } from "../scripts/story-fixtures/validation-histories.js";
/** @vitest-environment jsdom */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { HyperchartInspectorSidePanel } from "../packages/hyperchart/src/react/components/inspector/HyperchartInspectorSidePanel.js";
import { BranchExecution } from "../packages/hyperchart/src/execution/branch_execution.js";
import { explainReplay } from "../packages/hyperchart/src/core/replay_check.js";
import { hyperchartRunFromRuntime } from "../packages/hyperchart/src/host/adapters.js";
import { hyperchartRunFromRunId, hyperchartRunOverviewFromRunId, readBranchExecutionOverview } from "../packages/hyperchart/src/inspect/run_inspect.js";
import { createRunInspectorDataSource } from "../packages/hyperchart/src/inspect/run_history.js";
import { ArtifactStore } from "../packages/hyperchart/src/runtime/generic/artifact_store.js";
import { JsonlLogStore, type HistoryCursor } from "../packages/hyperchart/src/runtime/generic/log_store.js";
import { withRunStorage, type RunStorage } from "../packages/hyperchart/src/runtime/generic/run_paths.js";
import { changedReplayScenario, originalReplayScenario } from "../packages/hyperchart/src/react/fixtures/replay-incompatible-fixture.js";
import { executionGraph } from "../packages/hyperchart/src/react/components/inspector/history/ActionVisitGraph.js";
import { RunOverview } from "../packages/hyperchart/src/react/components/inspector/details/RunOverview.js";
import { VisitHistory } from "../packages/hyperchart/src/react/components/inspector/details/VisitHistory.js";

const roots: string[] = [];
afterEach(() => { cleanup(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "hyperchart-replay-recovery-")); roots.push(root);
	const runId = "run";
	const runDir = join(root, runId); mkdirSync(runDir);
	const storage: RunStorage = { kind: "jsonl", rootDir: root, layout: "run-id" };
	const store = new JsonlLogStore(join(runDir, "log.jsonl"));
	await store.writeRunMeta({ runId, chartPath: join(root, "chart.ts"), workDir: root, chartId: originalReplayScenario.ast.id, createdAt: new Date(0).toISOString() });
	await store.initializeRootBranch();
	const candidatePath = join(root, "candidate.txt");
	writeFileSync(candidatePath, "provisional candidate");
	const candidatePin = await new ArtifactStore(runDir).put(candidatePath);
	const captured = await captureReplayIncompatibleHistory((drafts) => store.appendDrafts(drafts), { "candidate.txt": candidatePin });
	const snapshot = await store.captureSnapshot("main");
	// The incompatible validation is inherited by a fixed historical child head.
	await store.createBranch("historical", snapshot.headSeqId!);
	const inherited = await store.captureSnapshot("historical");
	return { runId, runDir, storage, store, snapshot: inherited, ...captured };
}

function bytes(root: string): Record<string, string> {
	return Object.fromEntries(readdirSync(root).flatMap((name): [string, string][] => {
		const path = join(root, name);
		return statSync(path).isDirectory() ? Object.entries(bytes(path)).map(([child, value]) => [`${name}/${child}`, value]) : [[name, readFileSync(path).toString("base64")]];
	}));
}

it("recovers a changed action identity as definition-only while preserving inherited, pageable post-break visits and transcripts without writes", async () => {
	const f = await fixture();
	try {
		const before = bytes(f.runDir);
		const { ast } = changedReplayScenario;
		expect(explainReplay(originalReplayScenario.ast, f.records).broken).toBeUndefined();
		expect(f.broken.error).toContain("Invalid action invoke");
		expect(f.records.filter((record) => record.type === "state_action" && record.kind === "validated" && record.actionUid.state === "experiment").map((record) => record.type === "state_action" && record.kind === "validated" && record.outcome)).toEqual([{ ok: false, reason: "record lab notes and retry" }, true]);
		await expect(BranchExecution.restore({ ast, branchId: "historical", store: f.store, snapshot: f.snapshot, saveCheckpoint: "never" })).rejects.toThrow("Invalid action invoke");
		await expect(readBranchExecutionOverview(ast, "historical", f.store, f.snapshot)).rejects.toThrow("Invalid action invoke");
		expect(() => hyperchartRunFromRuntime(changedReplayScenario.inspect, ast, f.records)).toThrow("Invalid action invoke");
		const overview = await withRunStorage(f.storage, () => hyperchartRunOverviewFromRunId(f.runId, { ast, snapshot: f.snapshot }));
		expect(overview.snapshot).toEqual(f.snapshot);
		expect(overview.run).toMatchObject({ mode: "static", status: "blocked", replayIncompatibility: { seqId: f.broken.seqId, stateId: "experiment" } });
		expect(overview.run.issues?.[0]).toMatchObject({ kind: "replay_warning", source: "durable_log", seqId: f.broken.seqId });
		expect(overview.run.states).toEqual(changedReplayScenario.staticRun().states);
		expect(overview.run.finalOutput).toBeUndefined();
		expect(renderToStaticMarkup(createElement(RunOverview, { run: overview.run }))).toContain("Current definition only");
		const invocations = f.records.filter((record) => record.type === "state_action" && record.kind === "invoke");
		const last = [...invocations].reverse().find((record) => record.type === "state_action" && record.actionUid.state === "after")!;
		if (last.type !== "state_action" || last.kind !== "invoke") throw new Error("missing final invocation");
		const lastCompletion = [...f.records].reverse().find((record) => record.type === "state_action" && record.kind === "complete" && record.actionUid.state === "after")!;
		const readTranscript = vi.fn(async ({ sessionId }: { sessionId: string }) => sessionId === last.sessionId ? [
			{ id: "after", role: "assistant" as const, text: "recorded after incompatibility", timestamp: lastCompletion.timestamp },
			{ id: "future", role: "assistant" as const, text: "not in snapshot", timestamp: Number.MAX_SAFE_INTEGER },
		] : []);
		const source = await withRunStorage(f.storage, () => createRunInspectorDataSource(f.runId, { ast, readTranscript }));
		const returned = [];
		let cursor: HistoryCursor | undefined;
		do {
			const page = await source.readRecords({ runId: f.runId, snapshot: f.snapshot, includeActionVisits: true, ...(cursor === undefined ? {} : { cursor }) });
			expect(page.items.length).toBeLessThanOrEqual(100);
			returned.push(...page.items); cursor = page.older;
		} while (cursor !== undefined);
		expect(returned.map((record) => record.seqId)).toEqual([...f.records].reverse().map((record) => record.seqId));
		expect(returned.filter((record) => record.actionVisit !== undefined)).toHaveLength(invocations.length);
		expect(returned.find((record) => record.seqId === last.seqId)?.actionVisit).toMatchObject({ status: "unknown", originBranchId: "main", replayWarning: expect.stringContaining("Recorded facts only") });
		const afterVisits = await source.readStateVisits({ runId: f.runId, snapshot: f.snapshot, stateId: "after" });
		expect(afterVisits.items).toHaveLength(55);
		expect(afterVisits.items[0]).toMatchObject({ invokeSeqId: last.seqId, status: "unknown", originBranchId: "main", inputs: { topic: "durable evidence" }, invocation: { task: "Record {{…}}" } });
		const experiment = await source.readStateVisits({ runId: f.runId, snapshot: f.snapshot, stateId: "experiment" });
		expect(experiment.items[0]).toMatchObject({ status: "done", validationAttempts: 2, replayWarning: expect.stringContaining("not rendered") });
		expect(renderToStaticMarkup(createElement(VisitHistory, { visits: [...experiment.items], state: overview.run.states[0]!, allStates: overview.run.states }))).toContain("Recorded facts only");
		const rejectedSnapshot = { branchId: "historical", headSeqId: f.records.find((record) => record.type === "state_action" && record.kind === "validated")!.seqId };
		const rejected = await source.readStateVisits({ runId: f.runId, snapshot: rejectedSnapshot, stateId: "experiment" });
		expect(rejected.items[0]).toMatchObject({ status: "unknown", validationAttempts: 1 });
		expect(rejected.items[0]?.endedAt).toBeUndefined();
		expect(rejected.items[0]?.artifactPins).toBeUndefined();
		const rejectedGraph = executionGraph(overview.run, [{ invokeSeqId: rejected.items[0]!.invokeSeqId, statePath: "experiment", graphStateId: "experiment", originBranchId: "main", visit: rejected.items[0]! }]);
		expect(rejectedGraph.nodes[0]?.data).toMatchObject({ state: { status: "unknown" } });
		for (const [statePath, kind] of [["persistScript", "script"], ["persistImport", "tsImport"]] as const) {
			const visits = await source.readStateVisits({ runId: f.runId, snapshot: f.snapshot, stateId: statePath });
			const visit = visits.items[0]!;
			expect(visit.invocation.kind).toBe(kind);
			const graph = executionGraph(overview.run, [{ invokeSeqId: visit.invokeSeqId, statePath, originBranchId: "main", visit }]);
			expect(graph.nodes[0]?.data).toMatchObject({ displayType: kind, state: { type: kind, status: "unknown" } });
		}
		await expect(source.readVisitSession({ runId: f.runId, snapshot: f.snapshot, invokeSeqId: last.seqId })).resolves.toMatchObject({ status: "unknown", messages: [{ id: "after", text: "recorded after incompatibility" }] });
		await expect(source.readVisitSession({ runId: f.runId, snapshot: rejectedSnapshot, invokeSeqId: last.seqId })).resolves.toBeUndefined();
		const full = await withRunStorage(f.storage, () => hyperchartRunFromRunId(f.runId, { ast, snapshot: f.snapshot, includeTranscripts: true, readTranscript }));
		expect(full.replayIncompatibility).toEqual(overview.run.replayIncompatibility);
		expect(bytes(f.runDir)).toEqual(before);
	} finally { await f.store.close(); }
});

it("does not turn unrelated restoration failures into read-only replay recovery", async () => {
	const f = await fixture();
	try {
		vi.spyOn(BranchExecution, "restore").mockRejectedValue(new Error("checkpoint IO failed"));
		await expect(withRunStorage(f.storage, () => hyperchartRunFromRunId(f.runId, { ast: changedReplayScenario.ast, snapshot: f.snapshot }))).rejects.toThrow("checkpoint IO failed");
	} finally { await f.store.close(); }
});


it("opens the exact selected post-break visit and its transcript from the production definition-only side panel", async () => {
	const f = await fixture();
	try {
		const run = await withRunStorage(f.storage, () => hyperchartRunFromRunId(f.runId, { ast: changedReplayScenario.ast, snapshot: f.snapshot }));
		const invoke = [...f.records].reverse().find((record) => record.type === "state_action" && record.kind === "invoke" && record.actionUid.state === "after")!;
		const source = await withRunStorage(f.storage, () => createRunInspectorDataSource(f.runId, {
			ast: changedReplayScenario.ast,
			readTranscript: async () => [{ id: "selected", role: "assistant", text: "exact selected durable transcript", timestamp: invoke.timestamp }],
		}));
		const readVisits = vi.spyOn(source, "readStateVisits");
		const readSession = vi.spyOn(source, "readVisitSession");
		render(createElement(HyperchartInspectorSidePanel, { run, selectedStateId: "after", selectedInvokeSeqId: invoke.seqId, historyDataSource: source }));
		expect(await screen.findByText("Recorded history")).toBeDefined();
		expect(await screen.findByText("Visit 55")).toBeDefined();
		expect(within(screen.getByText("Visit 55").closest("summary")!).getByText("unknown")).toBeDefined();
		expect(screen.queryByText("pending")).toBeNull();
		expect(screen.getByText("Current definition only · Runtime status unavailable")).toBeDefined();
		expect(screen.getByText("Recorded prompt template")).toBeDefined();
		expect(screen.queryByText("resolved prompt")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "View session for visit 55" }));
		expect(await screen.findByText("exact selected durable transcript")).toBeDefined();
		expect(readVisits).toHaveBeenCalledWith(expect.objectContaining({ snapshot: f.snapshot, stateId: "after" }));
		expect(readSession).toHaveBeenCalledWith({ runId: f.runId, snapshot: f.snapshot, invokeSeqId: invoke.seqId });
	} finally { await f.store.close(); }
});

it("does not accept a guarded suffix completion before its first validation or truncate the pending transcript", async () => {
	let now = Date.UTC(2026, 8, 9);
	vi.spyOn(Date, "now").mockImplementation(() => now += 1_000);
	const f = await fixture();
	try {
		const before = bytes(f.runDir);
		const stateId = "suffix.guarded.work";
		const invoke = f.records.find((record) => record.type === "state_action" && record.kind === "invoke" && record.actionUid.state === stateId);
		const claim = f.records.find((record) => record.type === "state_action" && record.kind === "complete" && record.actionUid.state === stateId);
		const clock = f.records.find((record) => record.type === "state_action" && record.kind === "complete" && record.actionUid.state === "suffix.clock.work");
		const accepted = f.records.find((record) => record.type === "state_action" && record.kind === "validated" && record.actionUid.state === stateId);
		if (invoke?.type !== "state_action" || invoke.kind !== "invoke" || claim?.type !== "state_action" || claim.kind !== "complete" || clock === undefined || accepted === undefined) throw new Error("Missing executed suffix facts");
		expect(f.broken.seqId).toBeLessThan(invoke.seqId);
		expect(claim.artifacts?.["candidate.txt"]).toBeDefined();
		expect(clock.timestamp).toBeGreaterThan(claim.timestamp);
		expect(clock.seqId).toBeLessThan(accepted.seqId);
		const snapshot = { branchId: "historical", headSeqId: clock.seqId };
		const original = await BranchExecution.restore({ ast: originalReplayScenario.ast, branchId: snapshot.branchId, store: f.store, snapshot, saveCheckpoint: "never" });
		expect(original.inspectionProjection().pendingActions).toEqual(expect.arrayContaining([expect.objectContaining({ actionUid: invoke.actionUid, phase: "validating" })]));
		const readTranscript = vi.fn(async ({ sessionId }: { sessionId: string }) => sessionId === invoke.sessionId ? [
			{ id: "claim", role: "assistant" as const, text: "candidate completion claimed", timestamp: claim.timestamp },
			{ id: "pending", role: "assistant" as const, text: "still waiting for first validation", timestamp: clock.timestamp },
			{ id: "future", role: "assistant" as const, text: "later acceptance", timestamp: accepted.timestamp },
		] : []);
		const source = await withRunStorage(f.storage, () => createRunInspectorDataSource(f.runId, { ast: changedReplayScenario.ast, readTranscript }));
		for (const headSeqId of [claim.seqId, clock.seqId]) {
			const boundary = { branchId: snapshot.branchId, headSeqId };
			const visits = await source.readStateVisits({ runId: f.runId, snapshot: boundary, stateId });
			const page = await source.readRecords({ runId: f.runId, snapshot: boundary, includeActionVisits: true });
			const visit = visits.items[0]!;
			expect(page.items.find((record) => record.seqId === invoke.seqId)?.actionVisit).toEqual(visit);
			expect(visit).toMatchObject({ invokeSeqId: invoke.seqId, status: "unknown", replayWarning: expect.stringContaining("Completion claims without explicit acceptance remain unknown") });
			expect(visit.endedAt).toBeUndefined();
			expect(visit.artifactPins).toBeUndefined();
			expect(visit.completedEvent).toBeUndefined();
			expect(visit.validationAttempts).toBeUndefined();
			// Claim provenance stays in the raw record, not an accepted-visit field.
			expect(page.items.find((record) => record.seqId === claim.seqId)?.record).toEqual(claim);
		}
		const session = await source.readVisitSession({ runId: f.runId, snapshot, invokeSeqId: invoke.seqId });
		expect(session).toMatchObject({ status: "unknown", lastActivityAt: clock.timestamp });
		expect(session?.messages?.map((message) => message.id)).toEqual(["claim", "pending"]);
		const run = await withRunStorage(f.storage, () => hyperchartRunFromRunId(f.runId, { ast: changedReplayScenario.ast, snapshot }));
		const visits = await source.readStateVisits({ runId: f.runId, snapshot, stateId });
		const graph = executionGraph(run, [{ invokeSeqId: invoke.seqId, statePath: stateId, graphStateId: stateId, originBranchId: "main", visit: visits.items[0]! }]);
		expect(graph.nodes.find((node) => node.id === `visit-${invoke.seqId}`)?.data).toMatchObject({ state: { status: "unknown" } });
		render(createElement(HyperchartInspectorSidePanel, { run, selectedStateId: stateId, selectedInvokeSeqId: invoke.seqId, historyDataSource: source }));
		const visitLabel = await screen.findByText("Visit 1");
		expect(within(visitLabel.closest("summary")!).getByText("unknown")).toBeDefined();
		expect(screen.queryByText("pinned deliverables")).toBeNull();
		expect(screen.queryByText("completed event")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "View session for visit 1" }));
		expect(await screen.findByText("still waiting for first validation")).toBeDefined();
		expect(screen.queryByText("later acceptance")).toBeNull();
		// The later explicit accepted validation establishes both the end and pins.
		const acceptedVisits = await source.readStateVisits({ runId: f.runId, snapshot: f.snapshot, stateId });
		expect(acceptedVisits.items[0]).toMatchObject({ status: "done", endedAt: accepted.timestamp, completedEvent: "DONE", artifactPins: [{ path: "candidate.txt", ...claim.artifacts!["candidate.txt"] }] });
		expect(bytes(f.runDir)).toEqual(before);
	} finally { await f.store.close(); }
});
