import { useEffect, useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, waitFor, within } from "storybook/test";
import { z } from "zod";
import { actor, agent, arg, chart, compound, final, map as mapState, message, protocol, receive, reply, send, script } from "../../core/dsl.js";
import { actionUidKey } from "../../core/action_uid.js";
import { start } from "../../core/execution_loop.js";
import type { DurableLogRecord } from "../../core/durable_events.js";
import type { Effect, MachineEvent } from "../../core/machine.js";
import { createBranchProjection, projectBranch, type BranchProjection } from "../../core/projection.js";
import { explainReplay } from "../../core/replay_check.js";
import { normalizeChartConfig } from "../../core/normalize.js";
import { inspectChartAst } from "../../core/inspect_ast.js";
import type { ChartAst, ChartCst } from "../../core/types.js";
import { actorGenerationHistoryItemToHost, actorMessageHistoryItemsToHost, mapVisitHistoryItemToHost, stateVisitHistoryItemToHost } from "../../inspect/history_mapping.js";
import type { ActorGenerationHistoryItem, ActorMessageHistoryItem, HistoryChunk, HistoryCursor, MapVisitHistoryItem, StateVisitHistoryItem } from "../../runtime/generic/log_store.js";
import type { Runtime } from "../../runtime/runtime.js";
import type { HyperchartInspectorDataSource } from "../../host/adapter.js";
import { hyperchartRunFromRuntime } from "../../host/adapters.js";
import type { HyperchartActorGenerationInfo, HyperchartActorMessageBatchInfo, HyperchartMapVisitInfo, HyperchartStateInfo, HyperchartVisitInfo } from "../types.js";
import { RuntimeSection } from "../components/inspector/details/RuntimeSection.js";

const VISITS = 10_000;
const snapshot = { branchId: "main", headSeqId: VISITS * 2 + 1 } as const;
type Fixture = {
	rows: readonly StoryRow[];
	state: HyperchartStateInfo;
	allStates: readonly HyperchartStateInfo[];
	middle?: HistoryCursor;
	transcript?: NonNullable<HyperchartVisitInfo["session"]>;
};

let fixturePromise: Promise<Fixture> | undefined;
function runtimeFixture(): Promise<Fixture> {
	fixturePromise ??= captureRuntime(VISITS);
	return fixturePromise;
}

class CaptureFinished extends Error {}

class SemanticStoryRuntime implements Runtime {
	readonly branchId = "main";
	readonly records: DurableLogRecord[] = [];
	readonly projection: BranchProjection;
	private readonly queued: MachineEvent[] = [];
	private readonly waiters: Array<() => void> = [];
	private seqId = 0;
	private targetCount = 0;
	constructor(readonly ast: ChartAst, private readonly targetType: DurableLogRecord["type"], private readonly count: number) { this.projection = createBranchProjection(ast); }
	async loadAst() { return this.ast; }
	async loadProjection() { return this.projection; }
	async runEffects(effects: Effect[]) {
		for (const effect of effects) {
			if (effect.kind === "durable_records") {
				const records = effect.records.map((draft): DurableLogRecord => ({ ...draft, seqId: ++this.seqId, parentId: this.seqId === 1 ? null : this.seqId - 1, branchId: "main", timestamp: 1_700_100_000_000 + this.seqId }) as DurableLogRecord);
				this.records.push(...records);
				if (effect.id === "args") projectBranch(this.projection, this.ast, records);
				this.targetCount += records.filter((record) => record.type === this.targetType).length;
				if (this.targetCount >= this.count) throw new CaptureFinished();
				this.push({ kind: "durable_records_added", effectId: effect.id, records });
			} else if (effect.kind === "script") this.push({ kind: "script", effectId: effect.id, event: { type: "DONE" } });
			else if (effect.kind === "agent") this.push({ kind: "agent", effectId: effect.id, event: { type: "DONE" } });
			else if (effect.kind === "actor_create" || effect.kind === "actor_enqueue" || effect.kind === "actor_reply") this.push({ kind: "actor_effect", effectId: effect.id, operation: effect.kind === "actor_create" ? "create" : effect.kind === "actor_enqueue" ? "enqueue" : "reply", ok: true });
			else if (effect.kind !== "cancel") throw new Error(`Unexpected semantic story effect ${effect.kind}`);
		}
	}
	async *eventsQueue(): AsyncIterable<MachineEvent> { while (true) { if (this.queued.length === 0) await new Promise<void>((resolve) => this.waiters.push(resolve)); const event = this.queued.shift(); if (event !== undefined) yield event; } }
	private push(event: MachineEvent) { this.queued.push(event); this.waiters.shift()?.(); }
}

async function captureSemantic(cst: ChartCst, args: Readonly<Record<string, unknown>>, targetType: DurableLogRecord["type"], count: number) {
	const normalized = normalizeChartConfig(cst, { path: "storybook:runtime-history-semantic" });
	if (!normalized.ok) throw new Error(normalized.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	const runtime = new SemanticStoryRuntime(normalized.ast, targetType, count);
	try { await start(runtime, args); } catch (error) { if (!(error instanceof CaptureFinished)) throw error; }
	const replay = explainReplay(normalized.ast, runtime.records);
	if (replay.broken !== undefined || replay.prefixEnd !== runtime.records.length || replay.skipped.length > 0 || replay.stale.length > 0) throw new Error("Semantic Runtime History fixture failed replay validation");
	return { ast: normalized.ast, records: runtime.records };
}

async function captureRuntime(visits: number): Promise<Fixture> {
	const cst = chart({
		kind: "chart",
		id: "virtual-history-story",
		initial: "work",
		states: {
			work: { kind: "state", action: script("node", ["-e", "process.exit(0)"]), transitions: { DONE: "work", STOP: "done" } },
			done: final(),
		},
	});
	const runtime = await captureSemantic(cst, {}, "state_action", visits * 2);
	const ascending: Array<{ kind: "state-visit"; state: string; seqId: number; visit: number; invoke: Extract<DurableLogRecord, { type: "state_action"; kind: "invoke" }>; records: DurableLogRecord[] }> = [];
	for (const record of runtime.records) {
		if (record.type === "state_action" && record.kind === "invoke" && record.actionUid.state === "work") {
			ascending.push({ kind: "state-visit", state: "work", seqId: record.seqId, visit: ascending.length + 1, invoke: record, records: [record] });
		} else if (record.type === "state_action" && record.actionUid.state === "work") ascending.at(-1)?.records.push(record);
	}
	const items: readonly StateVisitHistoryItem[] = ascending.reverse();
	const run = hyperchartRunFromRuntime(inspectChartAst(runtime.ast, { chartPath: "storybook:runtime-history" }), runtime.ast, runtime.records);
	const state = run.states.find((candidate) => candidate.id === "work");
	if (state === undefined) throw new Error("Runtime History story state is missing");
	return { rows: stateRows(items), state: withoutElapsedHistory(state), allStates: run.states.map(withoutElapsedHistory), middle: `at:${Math.floor(items.length / 2)}` };
}

type StoryRow =
	| { kind: "visit"; id: string; value: HyperchartVisitInfo }
	| { kind: "map"; id: string; value: HyperchartMapVisitInfo }
	| { kind: "generation"; id: string; value: HyperchartActorGenerationInfo }
	| { kind: "messages"; id: string; value: HyperchartActorMessageBatchInfo };

function withoutElapsedHistory(state: HyperchartStateInfo): HyperchartStateInfo {
	const { visitHistory: _visitHistory, ...summary } = state;
	const mapConfig = state.mapConfig === undefined ? undefined : (({ visitHistory: _mapHistory, ...value }) => value)(state.mapConfig);
	const actorOccurrence = state.actorOccurrence === undefined ? undefined : (({ generationHistory: _generationHistory, messageHistory: _messageHistory, mailboxInstances: _mailboxInstances, ...value }) => ({ ...value, mailboxInstances: [] }))(state.actorOccurrence);
	return { ...summary, ...(mapConfig === undefined ? {} : { mapConfig }), ...(actorOccurrence === undefined ? {} : { actorOccurrence }) };
}

function fixtureFromRuntime(captured: { ast: ChartAst; records: readonly DurableLogRecord[] }, rows: readonly StoryRow[], state: (states: readonly HyperchartStateInfo[]) => HyperchartStateInfo | undefined): Fixture {
	const run = hyperchartRunFromRuntime(inspectChartAst(captured.ast, { chartPath: `storybook:${captured.ast.id}` }), captured.ast, captured.records);
	const selected = state(run.states);
	if (selected === undefined) throw new Error(`Runtime History story state is missing for ${captured.ast.id}`);
	return { rows, state: withoutElapsedHistory(selected), allStates: run.states.map(withoutElapsedHistory) };
}

const semanticFixturePromises = new Map<"map" | "generations" | "messages", Promise<Fixture>>();
function semanticFixtureRows(kind: "map" | "generations" | "messages"): Promise<Fixture> {
	const existing = semanticFixturePromises.get(kind);
	if (existing !== undefined) return existing;
	const captured = captureSemanticRows(kind);
	semanticFixturePromises.set(kind, captured);
	return captured;
}

async function captureSemanticRows(kind: "map" | "generations" | "messages", count = VISITS): Promise<Fixture> {
	if (kind === "map") {
		const cst = chart({ kind: "chart", id: "history-map", args: { items: { default: { only: 1 } } }, initial: "items", states: { items: mapState({ over: arg("items"), initial: "work", onDone: "items", states: { work: { kind: "state", action: script("true"), transitions: { DONE: "done" } }, done: final() } }) } });
		const captured = await captureSemantic(cst, { items: { only: 1 } }, "spawned", count);
		const rows = captured.records.filter((record): record is Extract<DurableLogRecord, { type: "spawned" }> => record.type === "spawned").map((spawn, index): StoryRow => { const value = mapVisitHistoryItemToHost({ kind: "map-visit", mapPath: spawn.path, seqId: spawn.seqId, visit: index + 1, spawn, records: [spawn] } satisfies MapVisitHistoryItem); return { kind: "map", id: String(value.spawnSeqId), value }; }).reverse();
		return fixtureFromRuntime(captured, rows, (states) => states.find((state) => state.id === "items"));
	}
	const Work = protocol({ WORK: message({ input: z.object({ index: z.number() }).strict(), reply: z.object({ ok: z.boolean() }).strict() }) });
	const Worker = actor({ input: z.object({}).strict(), protocol: Work, initial: "idle", states: { idle: receive({ on: { WORK: "reply" } }), reply: reply({ target: "idle", output: { ok: true } }) } });
	const worker = Worker({});
	if (kind === "generations") {
		const cst = chart({ kind: "chart", id: "history-generations", initial: "phase", states: { phase: compound({ actors: { worker }, initial: "dispatch", onDone: "pause", states: { dispatch: send({ to: worker, event: "WORK", input: { index: 1 }, target: "done" }), done: final() } }), pause: { kind: "state", action: script("true"), transitions: { DONE: "phase" } } } });
		const captured = await captureSemantic(cst, {}, "actor_created", count);
		const rows = captured.records.filter((record): record is Extract<DurableLogRecord, { type: "actor_created" }> => record.type === "actor_created").map((created): StoryRow => { const value = actorGenerationHistoryItemToHost({ kind: "actor-generation", logicalOccurrence: created.occurrence.replace(/~\d+$/, ""), seqId: created.seqId, created, records: [created] } satisfies ActorGenerationHistoryItem); return { kind: "generation", id: `${value.occurrencePath}:${value.createdSeqId}`, value }; }).reverse();
		const logicalOccurrence = rows.find((row) => row.kind === "generation")?.value.logicalOccurrence;
		return fixtureFromRuntime(captured, rows, (states) => states.find((state) => state.actorOccurrence?.logicalPath === logicalOccurrence || state.actorInternal?.logicalOccurrencePath === logicalOccurrence));
	}
	const cst = chart({ kind: "chart", id: "history-messages", actors: { worker }, initial: "send", states: { send: send({ to: worker, event: "WORK", input: { index: 1 }, target: "send" }) } });
	const captured = await captureSemantic(cst, {}, "actor_messages_enqueued", count);
	const historyItems = captured.records.filter((record): record is Extract<DurableLogRecord, { type: "actor_messages_enqueued" }> => record.type === "actor_messages_enqueued").map((enqueued) => ({ kind: "actor-message-batch", occurrence: enqueued.occurrence, seqId: enqueued.seqId, enqueued, records: [enqueued] } satisfies ActorMessageHistoryItem));
	const rows = actorMessageHistoryItemsToHost(historyItems, captured.ast, captured.records).map((value): StoryRow => ({ kind: "messages", id: `${value.occurrencePath}:${value.enqueueSeqId}`, value })).reverse();
	const occurrence = rows.find((row) => row.kind === "messages")?.value.occurrencePath;
	return fixtureFromRuntime(captured, rows, (states) => states.find((state) => state.actorOccurrence?.occurrencePath === occurrence || state.actorInternal?.occurrencePath === occurrence));
}

let transcriptFixturePromise: Promise<Fixture> | undefined;
function transcriptFixture(): Promise<Fixture> {
	transcriptFixturePromise ??= captureTranscriptFixture();
	return transcriptFixturePromise;
}

async function captureTranscriptFixture(): Promise<Fixture> {
	const cst = chart({ kind: "chart", id: "history-transcript", initial: "work", states: { work: { kind: "state", action: agent("runtime-history-agent"), transitions: { DONE: "done" } }, done: final() } });
	const captured = await captureSemantic(cst, {}, "state_action", 2);
	const invoke = captured.records.find((record): record is Extract<DurableLogRecord, { type: "state_action"; kind: "invoke" }> => record.type === "state_action" && record.kind === "invoke");
	if (invoke === undefined) throw new Error("Transcript story invocation is missing");
	const actionKey = actionUidKey(invoke.actionUid);
	const transcript = { actionKey, status: "completed" as const, startedAt: invoke.timestamp, messages: [{ id: "assistant-1", role: "assistant" as const, text: "Loaded through readVisitSession" }] };
	const run = hyperchartRunFromRuntime(inspectChartAst(captured.ast, { chartPath: "storybook:history-transcript" }), captured.ast, captured.records, {
		sessionProgress: { updatedAt: invoke.timestamp + 1, sessions: { work: { actionUid: invoke.actionUid, visit: 1, ...transcript } } },
	});
	const state = run.states.find((candidate) => candidate.id === "work");
	const visit = state?.visitHistory?.find((candidate) => candidate.invokeSeqId === invoke.seqId);
	if (state === undefined || visit?.session === undefined) throw new Error("Transcript story session summary is missing");
	const { messages: _messages, ...sessionSummary } = visit.session;
	const summaryVisit: HyperchartVisitInfo = { ...visit, session: sessionSummary };
	return { rows: [{ kind: "visit", id: String(summaryVisit.invokeSeqId), value: summaryVisit }], state: withoutElapsedHistory(state), allStates: run.states.map(withoutElapsedHistory), transcript };
}

function stateRows(items: readonly StateVisitHistoryItem[]): readonly StoryRow[] {
	return items.map((item): StoryRow => { const value = stateVisitHistoryItemToHost(item); return { kind: "visit", id: String(value.invokeSeqId), value }; });
}

function storyChunk(items: readonly StoryRow[], cursor?: HistoryCursor): HistoryChunk<StoryRow> {
	let start = 0;
	if (cursor !== undefined) {
		const [direction, raw] = cursor.split(":");
		const boundary = Number(raw);
		if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary >= items.length) throw new Error("Invalid story history cursor");
		start = direction === "older" ? boundary + 1 : direction === "newer" ? Math.max(0, boundary - 100) : boundary;
	}
	const end = Math.min(items.length, start + 100);
	return { snapshot, items: items.slice(start, end), ...(end < items.length ? { older: `older:${end - 1}` } : {}), ...(start > 0 ? { newer: `newer:${start}` } : {}) };
}

type Scenario = "newest" | "middle" | "eviction" | "variable" | "map" | "generations" | "messages" | "empty" | "older-error" | "newer-error" | "switch" | "refresh" | "transcript";

function ProductionHistoryStory({ fixture, scenario, source, revision, onRefresh }: { fixture: Fixture; scenario: Scenario; source: { load(cursor?: HistoryCursor): Promise<HistoryChunk<StoryRow>> }; revision: number; onRefresh: () => void }) {
	const dataSource = useMemo<HyperchartInspectorDataSource>(() => ({
		listBranches: async () => ({ items: [], totalCount: 0 }),
		readStateVisits: async (input) => {
			const chunk = await source.load(input.cursor);
			return { ...chunk, snapshot: input.snapshot, items: chunk.items.flatMap((row) => row.kind === "visit" ? [row.value] : []) };
		},
		readMapVisits: async (input) => { const chunk = await source.load(input.cursor); return { ...chunk, snapshot: input.snapshot, items: chunk.items.flatMap((row) => row.kind === "map" ? [row.value] : []) }; },
		readActorGenerations: async (input) => { const chunk = await source.load(input.cursor); return { ...chunk, snapshot: input.snapshot, items: chunk.items.flatMap((row) => row.kind === "generation" ? [row.value] : []) }; },
		readActorMessages: async (input) => { const chunk = await source.load(input.cursor); return { ...chunk, snapshot: input.snapshot, items: chunk.items.flatMap((row) => row.kind === "messages" ? [row.value] : []) }; },
		readRecords: async (input) => ({ snapshot: input.snapshot, items: [] }),
		cursorAt: async () => scenario === "middle" || scenario === "newer-error" ? fixture.middle : undefined,
		readVisitSession: async ({ invokeSeqId }) => fixture.rows.some((row) => row.kind === "visit" && row.value.invokeSeqId === invokeSeqId) ? fixture.transcript : undefined,
	}), [fixture.middle, fixture.rows, fixture.transcript, scenario, source]);
	const historySnapshot = { branchId: scenario === "switch" && revision > 0 ? "experiment" : "main", headSeqId: snapshot.headSeqId + revision };
	return (
		<div className="min-h-screen bg-[var(--bg-primary)] p-6 text-[var(--text-primary)]" data-history-scenario={scenario} data-selected-history-subject={fixture.state.runtimeStatePath ?? fixture.state.id}>
			<div className="mx-auto max-w-3xl rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4">
				<div className="mb-3 flex items-center justify-between"><div><h2 className="text-sm font-semibold">Runtime History — Virtualized Cursor Chunks</h2><p className="text-xs text-[var(--text-muted)]">{scenario} · HyperchartInspectorDataSource → production RuntimeSection</p></div>{scenario === "refresh" && <button type="button" onClick={onRefresh}>Refresh to latest</button>}</div>
				<RuntimeSection state={fixture.state} allStates={[...fixture.allStates]} history={{ runId: "storybook-runtime-history", snapshot: historySnapshot, dataSource, ...((scenario === "middle" || scenario === "newer-error") && fixture.rows[5_000] !== undefined ? { targetSeqId: Number(fixture.rows[5_000].id.split(":").at(-1)) } : {}) }} />
			</div>
		</div>
	);
}

function RuntimeHistoryStory({ scenario }: { scenario: Scenario }) {
	const [fixture, setFixture] = useState<Fixture>();
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		let current = true;
		const pending = scenario === "map" || scenario === "generations" || scenario === "messages"
			? semanticFixtureRows(scenario)
			: scenario === "transcript"
				? transcriptFixture()
				: runtimeFixture();
		void pending.then((value) => { if (current) setFixture(value); });
		return () => { current = false; };
	}, [scenario]);
	useEffect(() => {
		if (scenario !== "switch" || fixture === undefined || revision !== 0) return;
		const timer = window.setTimeout(() => setRevision(1), 20);
		return () => window.clearTimeout(timer);
	}, [fixture, revision, scenario]);
	const source = useMemo(() => {
		let failed = false;
		return {
			load: async (cursor?: HistoryCursor) => {
				if (scenario === "switch" && revision === 0) await new Promise((resolve) => window.setTimeout(resolve, 250));
				const failingDirection = scenario === "older-error" ? "older:" : scenario === "newer-error" ? "newer:" : undefined;
				if (failingDirection !== undefined && cursor?.startsWith(failingDirection) === true && !failed) {
					failed = true;
					throw new Error(`${scenario} injected failure`);
				}
				return storyChunk(scenario === "empty" ? [] : fixture?.rows ?? [], cursor);
			},
		};
	}, [fixture, scenario, revision]);
	if (fixture === undefined) return <div className="p-6 text-sm">Capturing durable history items through the production execution loop…</div>;
	return <ProductionHistoryStory fixture={fixture} scenario={scenario} source={source} revision={revision} onRefresh={() => setRevision((value) => value + 1)} />;
}

const meta = {
	title: "Hyperchart/Inspector/Runtime History — Virtualized Cursor Chunks",
	id: "hyperchart-runtime-history-virtualized-cursor-chunks",
	component: RuntimeHistoryStory,
	parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta<typeof RuntimeHistoryStory>;
export default meta;
type Story = StoryObj<typeof meta>;

async function storyHistoryList(canvasElement: HTMLElement) {
	const canvas = within(canvasElement);
	const runtime = canvas.queryByRole("button", { name: /Runtime/ });
	if (runtime?.getAttribute("aria-expanded") === "false") fireEvent.click(runtime);
	const scenario = canvasElement.querySelector<HTMLElement>("[data-history-scenario]")?.dataset.historyScenario;
	let disclosure: string | undefined;
	switch (scenario) {
		case "map": disclosure = "Load map launch history"; break;
		case "generations": disclosure = "Load actor generations"; break;
		case "messages": disclosure = "Load actor message history"; break;
		default: break;
	}
	if (disclosure !== undefined) fireEvent.click(await canvas.findByRole("button", { name: disclosure }, { timeout: 20_000 }));
	return canvas.findByTestId("virtualized-history", {}, { timeout: 20_000 });
}

const story = (scenario: Scenario): Story => ({ args: { scenario }, play: async ({ canvasElement }) => { const canvas = within(canvasElement); if (scenario === "empty") { const runtime = await canvas.findByRole("button", { name: /Runtime/ }, { timeout: 20_000 }); fireEvent.click(runtime); await expect(await canvas.findByText("No visits in this snapshot.")).toBeVisible(); } else { const list = await storyHistoryList(canvasElement); expect(Number(list.getAttribute("data-retained-items"))).toBeGreaterThan(0); expect(Number(list.getAttribute("data-retained-items"))).toBeLessThanOrEqual(1_000); } } });
export const TenThousandStateVisits: Story = {
	args: { scenario: "newest" },
	play: async ({ canvasElement }) => {
		const list = await storyHistoryList(canvasElement);
		const viewport = list.querySelector(".overflow-auto") as HTMLElement;
		viewport.scrollTop = viewport.scrollHeight;
		fireEvent.scroll(viewport);
		await waitFor(() => expect(Number(list.getAttribute("data-retained-items"))).toBeGreaterThan(100));
		expect(Number(list.getAttribute("data-retained-items"))).toBeLessThanOrEqual(1_000);
		expect(list.querySelectorAll("[data-history-row]").length).toBeLessThanOrEqual(60);
		viewport.scrollTop = 0;
		fireEvent.scroll(viewport);
		await waitFor(() => expect(list.querySelectorAll("[data-history-row]").length).toBeLessThanOrEqual(60));
	},
};
export const DeepLinkedMiddleChunk = story("middle");
export const OppositeEdgeEvictionAndReload: Story = { args: { scenario: "eviction" }, play: async ({ canvasElement }) => { const list = await storyHistoryList(canvasElement); const viewport = list.querySelector(".overflow-auto") as HTMLElement; for (let index = 0; index < 12; index++) { viewport.scrollTop = viewport.scrollHeight; fireEvent.scroll(viewport); await new Promise((resolve) => setTimeout(resolve, 10)); } await waitFor(() => expect(Number(list.getAttribute("data-retained-items"))).toBe(1_000)); viewport.scrollTop = 0; fireEvent.scroll(viewport); await waitFor(() => expect(Number(list.getAttribute("data-retained-items"))).toBeLessThanOrEqual(1_000)); } };
export const VariableHeightAnchorPreservation: Story = {
	args: { scenario: "variable" },
	play: async ({ canvasElement }) => {
		const list = await storyHistoryList(canvasElement);
		const viewport = list.querySelector(".overflow-auto") as HTMLElement;
		viewport.scrollTop = viewport.scrollHeight;
		fireEvent.scroll(viewport);
		const anchorRow = list.querySelector<HTMLElement>("[data-history-row]");
		if (anchorRow === null || anchorRow.dataset.historyRow === undefined) throw new Error("visible durable anchor missing");
		const anchorOffset = anchorRow.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
		await waitFor(() => expect(list.getAttribute("data-retained-items")).toBe("200"));
		const restored = list.querySelector<HTMLElement>(`[data-history-row="${anchorRow.dataset.historyRow}"]`);
		if (restored === null) throw new Error("durable anchor was not restored");
		expect(restored.getBoundingClientRect().top - viewport.getBoundingClientRect().top).toBe(anchorOffset);
	},
};
export const TenThousandMapLaunches = story("map");
export const TenThousandActorGenerations = story("generations");
export const TenThousandActorMessageBatches = story("messages");
export const EmptyHistory = story("empty");
export const OlderEdgeFailureAndRetry: Story = { args: { scenario: "older-error" }, play: async ({ canvasElement }) => { const canvas = within(canvasElement); const list = await storyHistoryList(canvasElement); const viewport = list.querySelector(".overflow-auto") as HTMLElement; viewport.scrollTop = viewport.scrollHeight; fireEvent.scroll(viewport); await canvas.findByText(/older load failed/); fireEvent.click(canvas.getByRole("button", { name: "Retry" })); await waitFor(() => expect(canvas.queryByText(/older load failed/)).toBeNull()); } };
export const NewerEdgeFailureAndRetry: Story = { args: { scenario: "newer-error" }, play: async ({ canvasElement }) => { const canvas = within(canvasElement); await storyHistoryList(canvasElement); await canvas.findByText(/newer load failed/, {}, { timeout: 20_000 }); fireEvent.click(canvas.getByRole("button", { name: "Retry" })); await waitFor(() => expect(canvas.queryByText(/newer load failed/)).toBeNull()); } };
export const BranchSnapshotSwitchCancelsInflight = story("switch");
export const RefreshToLatestWithOlderWindow: Story = { args: { scenario: "refresh" }, play: async ({ canvasElement }) => { const canvas = within(canvasElement); const list = await storyHistoryList(canvasElement); const viewport = list.querySelector(".overflow-auto") as HTMLElement; viewport.scrollTop = viewport.scrollHeight; fireEvent.scroll(viewport); await waitFor(() => expect(list.getAttribute("data-retained-items")).toBe("200")); expect(canvasElement.querySelector("[data-selected-history-subject]")?.getAttribute("data-selected-history-subject")).toBe("work"); fireEvent.click(canvas.getByRole("button", { name: "Refresh to latest" })); await waitFor(() => expect(canvas.getByTestId("virtualized-history").getAttribute("data-retained-items")).toBe("100")); expect(canvasElement.querySelector("[data-selected-history-subject]")?.getAttribute("data-selected-history-subject")).toBe("work"); } };
export const TranscriptOnDemand: Story = { args: { scenario: "transcript" }, play: async ({ canvasElement }) => { const canvas = within(canvasElement); await storyHistoryList(canvasElement); expect(canvas.queryByText("Loaded through readVisitSession")).toBeNull(); fireEvent.click(await canvas.findByRole("button", { name: "View session for visit 1" })); await expect(await canvas.findByText("Loaded through readVisitSession")).toBeVisible(); } };
