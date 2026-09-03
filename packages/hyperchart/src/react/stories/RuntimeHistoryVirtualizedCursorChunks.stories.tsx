import { useEffect, useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, within } from "storybook/test";
import { z } from "zod";
import { actor, arg, chart, compound, final, map as mapState, message, protocol, receive, reply, send, script } from "../../core/dsl.js";
import { loop } from "../../execution/execution_loop.js";
import type { DurableLogRecord } from "../../core/durable_events.js";
import { createMachine, type Effect, type MachineEvent } from "../../core/machine.js";
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

const LOAD_TEST_VISITS = 10_000;
const snapshot = { branchId: "main", headSeqId: LOAD_TEST_VISITS * 2 + 1 } as const;
type Fixture = {
	/** Adapter-derived seed rows; the cursor source scales identity/cardinality without replaying 10k records in the browser. */
	rows: readonly StoryRow[];
	rowCount: number;
	state: HyperchartStateInfo;
	allStates: readonly HyperchartStateInfo[];
};

let fixturePromise: Promise<Fixture> | undefined;
function runtimeFixture(): Promise<Fixture> {
	fixturePromise ??= captureRuntime(1).then((fixture) => scaleFixture(fixture));
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
	await runtime.runEffects([{ kind: "durable_records", id: "args", records: [{ type: "args", args }] }]);
	const semantic = { machineState: () => createMachine(normalized.ast, structuredClone(runtime.projection)) };
	try { await loop(runtime, semantic); } catch (error) { if (!(error instanceof CaptureFinished)) throw error; }
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
	return { rows: stateRows(items), rowCount: items.length, state: withoutElapsedHistory(state), allStates: run.states.map(withoutElapsedHistory) };
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
	return { rows, rowCount: rows.length, state: withoutElapsedHistory(selected), allStates: run.states.map(withoutElapsedHistory) };
}

const semanticFixturePromises = new Map<"map" | "generations" | "messages", Promise<Fixture>>();
function semanticFixtureRows(kind: "map" | "generations" | "messages"): Promise<Fixture> {
	const existing = semanticFixturePromises.get(kind);
	if (existing !== undefined) return existing;
	const captured = captureSemanticRows(kind, 1).then((fixture) => scaleFixture(fixture));
	semanticFixturePromises.set(kind, captured);
	return captured;
}

async function captureSemanticRows(kind: "map" | "generations" | "messages", count: number): Promise<Fixture> {
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

function scaleFixture(fixture: Fixture): Fixture {
	if (fixture.rows.length === 0) throw new Error("Runtime History load-test seed is empty");
	return {
		...fixture,
		rowCount: LOAD_TEST_VISITS,
		state: { ...fixture.state, ...(fixture.rows[0]?.kind === "visit" ? { visits: LOAD_TEST_VISITS } : {}) },
	};
}

function scaledStoryRow(seed: StoryRow, index: number): StoryRow {
	const ordinal = LOAD_TEST_VISITS - index;
	const seqId = ordinal * 2;
	switch (seed.kind) {
		case "visit": {
			const value = { ...seed.value, visit: ordinal, invokeSeqId: seqId, startedAt: 1_700_100_000_000 + seqId, ...(seed.value.endedAt === undefined ? {} : { endedAt: 1_700_100_000_001 + seqId }) };
			return { kind: "visit", id: String(value.invokeSeqId), value };
		}
		case "map": {
			const value = { ...seed.value, visit: ordinal, spawnSeqId: seqId, startedAt: 1_700_100_000_000 + seqId };
			return { kind: "map", id: String(value.spawnSeqId), value };
		}
		case "generation": {
			const value = { ...seed.value, occurrencePath: `${seed.value.logicalOccurrence}~${ordinal}`, generation: ordinal, createdSeqId: seqId, createdAt: 1_700_100_000_000 + seqId };
			return { kind: "generation", id: `${value.occurrencePath}:${value.createdSeqId}`, value };
		}
		case "messages": {
			const value = {
				...seed.value,
				enqueueSeqId: seqId,
				enqueuedAt: 1_700_100_000_000 + seqId,
				messages: seed.value.messages.map((message) => ({ ...message, messageId: `${message.messageId}:${ordinal}`, producerVisit: String(ordinal) })),
			};
			return { kind: "messages", id: `${value.occurrencePath}:${value.enqueueSeqId}`, value };
		}
	}
}

function stateRows(items: readonly StateVisitHistoryItem[]): readonly StoryRow[] {
	return items.map((item): StoryRow => { const value = stateVisitHistoryItemToHost(item); return { kind: "visit", id: String(value.invokeSeqId), value }; });
}

function storyChunk(fixture: Fixture, cursor?: HistoryCursor): HistoryChunk<StoryRow> {
	let start = 0;
	if (cursor !== undefined) {
		const [direction, raw] = cursor.split(":");
		const boundary = Number(raw);
		if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary >= fixture.rowCount) throw new Error("Invalid story history cursor");
		start = direction === "older" ? boundary + 1 : direction === "newer" ? Math.max(0, boundary - 100) : boundary;
	}
	const end = Math.min(fixture.rowCount, start + 100);
	const seed = fixture.rows[0]!;
	const items = Array.from({ length: end - start }, (_, offset) => scaledStoryRow(seed, start + offset));
	return { snapshot, items, ...(end < fixture.rowCount ? { older: `older:${end - 1}` } : {}), ...(start > 0 ? { newer: `newer:${start}` } : {}) };
}

type Scenario = "state-visits" | "map" | "generations" | "messages";

function ProductionHistoryStory({ fixture, scenario, source }: { fixture: Fixture; scenario: Scenario; source: { load(cursor?: HistoryCursor): Promise<HistoryChunk<StoryRow>> } }) {
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
		cursorAt: async () => undefined,
		readVisitSession: async () => undefined,
	}), [source]);
	return (
		<div className="min-h-screen bg-[var(--bg-primary)] p-6 text-[var(--text-primary)]" data-history-scenario={scenario} data-selected-history-subject={fixture.state.runtimeStatePath ?? fixture.state.id}>
			<div className="mx-auto max-w-3xl rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4">
				<div className="mb-3"><h2 className="text-sm font-semibold">Runtime History — Virtualized Cursor Chunks</h2><p className="text-xs text-[var(--text-muted)]">{scenario} · HyperchartInspectorDataSource → production RuntimeSection</p></div>
				<RuntimeSection state={fixture.state} allStates={[...fixture.allStates]} history={{ runId: "storybook-runtime-history", snapshot, dataSource }} />
			</div>
		</div>
	);
}

function RuntimeHistoryStory({ scenario }: { scenario: Scenario }) {
	const [loaded, setLoaded] = useState<{ scenario: Scenario; fixture: Fixture }>();
	const fixture = loaded?.scenario === scenario ? loaded.fixture : undefined;
	useEffect(() => {
		let current = true;
		const pending = scenario === "map" || scenario === "generations" || scenario === "messages"
			? semanticFixtureRows(scenario)
			: runtimeFixture();
		void pending.then((value) => { if (current) setLoaded({ scenario, fixture: value }); });
		return () => { current = false; };
	}, [scenario]);
	const source = useMemo(() => ({ load: async (cursor?: HistoryCursor) => fixture === undefined ? { snapshot, items: [] } : storyChunk(fixture, cursor) }), [fixture]);
	if (fixture === undefined) return <div className="p-6 text-sm">Preparing the 10,000-row cursor source…</div>;
	return <ProductionHistoryStory key={scenario} fixture={fixture} scenario={scenario} source={source} />;
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

const loadTestStory = (scenario: Scenario): Story => ({
	args: { scenario },
	play: async ({ canvasElement }) => {
		const list = await storyHistoryList(canvasElement);
		expect(Number(list.getAttribute("data-retained-items"))).toBeGreaterThan(0);
		expect(Number(list.getAttribute("data-retained-items"))).toBeLessThanOrEqual(1_000);
	},
});

export const TenThousandStateVisits = loadTestStory("state-visits");
export const TenThousandMapLaunches = loadTestStory("map");
export const TenThousandActorGenerations = loadTestStory("generations");
export const TenThousandActorMessageBatches = loadTestStory("messages");
