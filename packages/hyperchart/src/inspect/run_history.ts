import { basename, resolve } from "node:path";
import type {
	HyperchartActorMessageBatchInfo,
	HyperchartAgentSessionInfo,
	HyperchartVisitInfo,
} from "../host/models.js";
import type { HyperchartInspectorDataSource } from "../host/adapter.js";
import { openRunLogStore } from "../runtime/generic/log_store_factory.js";
import { BranchExecution } from "../execution/branch_execution.js";
import { projectBranch } from "../core/projection.js";
import { renderPendingActionInvocation, type ActionEffect, type RenderedArtifact } from "../core/machine.js";
import { nearestInstance } from "../core/paths.js";
import type { ChartAst } from "../core/types.js";
import type {
	ActorMessageHistoryItem,
	HistoryChunk,
	HistoryCursor,
	StateVisitHistoryItem,
} from "../runtime/generic/log_store.js";
import { loadRunMeta } from "../runtime/generic/run_dir.js";
import { readSessionProgress } from "../runtime/generic/session_progress.js";
import { parseChartModuleSync } from "../core/inspect.js";
import type { SessionTranscriptReader } from "./run_inspect.js";
import { actorGenerationHistoryItemToHost, actorMessageHistoryItemsToHost, actorMessageHistoryItemToHost, durableRecordToHost, mapVisitHistoryItemToHost, stateVisitHistoryItemToHost } from "./history_mapping.js";
import { runtimeVisitHistoriesForInspector } from "../host/adapters.js";

export async function createRunInspectorDataSource(
	runDir: string,
	options: { readTranscript?: SessionTranscriptReader } = {},
): Promise<HyperchartInspectorDataSource> {
	const absoluteRunDir = resolve(runDir);
	const runId = basename(absoluteRunDir);
	const meta = await loadRunMeta(absoluteRunDir);
	const parsed = parseChartModuleSync(meta.chartPath, meta.exportName === undefined ? {} : { exportName: meta.exportName });
	if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	const assertRun = (candidate: string) => {
		if (candidate !== runId) throw new Error(`Inspector data source is bound to run '${runId}'`);
	};
	const withStore = async <T>(operation: (store: Awaited<ReturnType<typeof openRunLogStore>>) => Promise<T>): Promise<T> => {
		const store = await openRunLogStore(absoluteRunDir, { access: "read" });
		try { return await operation(store); }
		finally { await store.close(); }
	};
	return {
		listBranches: async ({ runId: candidate, cursor }) => {
			assertRun(candidate);
			return withStore((store) => store.listBranches(cursor));
		},
		readStateVisits: async ({ runId: candidate, snapshot, stateId, cursor }) => {
			assertRun(candidate);
			return withStore(async (store) => {
				const chunk = await readChunkOrEmpty(store, snapshot, () => store.readStateVisits({ snapshot, state: stateId, ...(cursor === undefined ? {} : { cursor }) }));
				const records = await collectSnapshotRecordsForMapping(store, snapshot);
				const semanticVisits = runtimeVisitHistoriesForInspector(parsed.ast, records).get(stateId) ?? [];
				return mapChunkAsync(chunk, (item) => stateVisitWithProjection(store, parsed.ast, snapshot.branchId, item, semanticVisits.find((visit) => visit.invokeSeqId === item.seqId)));
			});
		},
		readMapVisits: async ({ runId: candidate, snapshot, mapPath, cursor }) => {
			assertRun(candidate);
			return withStore(async (store) => mapChunk(
				await readChunkOrEmpty(store, snapshot, () => store.readMapVisits({ snapshot, mapPath, ...(cursor === undefined ? {} : { cursor }) })),
				mapVisitHistoryItemToHost,
			));
		},
		readActorGenerations: async ({ runId: candidate, snapshot, logicalOccurrence, cursor }) => {
			assertRun(candidate);
			return withStore(async (store) => mapChunk(
				await readChunkOrEmpty(store, snapshot, () => store.readActorGenerations({ snapshot, logicalOccurrence, ...(cursor === undefined ? {} : { cursor }) })),
				actorGenerationHistoryItemToHost,
			));
		},
		readActorMessages: async ({ runId: candidate, snapshot, occurrence, cursor }) => {
			assertRun(candidate);
			return withStore(async (store) => {
				const chunk = await readChunkOrEmpty(store, snapshot, () => store.readActorMessages({ snapshot, occurrence, ...(cursor === undefined ? {} : { cursor }) }));
				const records = await collectSnapshotRecordsForMapping(store, snapshot);
				const items = actorMessageHistoryItemsToHost(chunk.items, parsed.ast, records);
				return { ...chunk, items };
			});
		},
		readRecords: async ({ runId: candidate, snapshot, cursor }) => {
			assertRun(candidate);
			return withStore(async (store) => mapChunk(
				await readChunkOrEmpty(store, snapshot, () => store.readRecords({ snapshot, ...(cursor === undefined ? {} : { cursor }) })),
				durableRecordToHost,
			));
		},
		cursorAt: async ({ runId: candidate, ...input }) => {
			assertRun(candidate);
			return withStore(async (store) => {
				try { return await store.cursorAt(input); }
				catch (error) {
					if (isMissingSyntheticBranch(error) && input.snapshot.headSeqId === null && await store.countRecords() === 0) return undefined;
					throw error;
				}
			});
		},
		readVisitSession: async ({ runId: candidate, branchId, invokeSeqId }) => {
			assertRun(candidate);
			const progress = readSessionProgress(resolve(absoluteRunDir, "sessions"));
			const match = Object.values(progress.sessions).find((session) => session.branchId === branchId && session.invokeSeqId === invokeSeqId);
			if (match === undefined) return undefined;
			const summary = sessionFromProgress(match);
			const messages = options.readTranscript === undefined || match.sessionId === undefined
				? undefined
				: await options.readTranscript({ sessionId: match.sessionId });
			return { ...summary, ...(messages === undefined ? {} : { messages }) };
		},
	};
}

export function stateVisitHistoryChunkToHost(chunk: HistoryChunk<StateVisitHistoryItem>): HistoryChunk<HyperchartVisitInfo> {
	return mapChunk(chunk, (item) => stateVisitHistoryItemToHost(item));
}

export function actorMessageHistoryChunkToHost(chunk: HistoryChunk<ActorMessageHistoryItem>): HistoryChunk<HyperchartActorMessageBatchInfo> {
	return mapChunk(chunk, (item) => actorMessageHistoryItemToHost(item));
}

async function readChunkOrEmpty<T>(
	store: Awaited<ReturnType<typeof openRunLogStore>>,
	snapshot: { branchId: string; headSeqId: number | null },
	read: () => Promise<HistoryChunk<T>>,
): Promise<HistoryChunk<T>> {
	try { return await read(); }
	catch (error) {
		if (isMissingSyntheticBranch(error) && snapshot.headSeqId === null && await store.countRecords() === 0) return { snapshot, items: [] };
		throw error;
	}
}

function isMissingSyntheticBranch(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("Unknown Hyperchart branch '");
}

async function mapChunkAsync<A, B>(chunk: HistoryChunk<A>, map: (item: A, index: number) => Promise<B>): Promise<HistoryChunk<B>> {
	return {
		snapshot: chunk.snapshot,
		items: await Promise.all(chunk.items.map(map)),
		...(chunk.older === undefined ? {} : { older: chunk.older }),
		...(chunk.newer === undefined ? {} : { newer: chunk.newer }),
	};
}

async function stateVisitWithProjection(
	store: Awaited<ReturnType<typeof openRunLogStore>>,
	ast: ChartAst,
	branchId: string,
	item: StateVisitHistoryItem,
	semanticVisit?: HyperchartVisitInfo,
): Promise<HyperchartVisitInfo> {
	const base = semanticVisit ?? stateVisitHistoryItemToHost(item);
	const parent = await BranchExecution.restore({ ast, branchId, store, snapshot: { branchId, headSeqId: item.invoke.parentId }, saveCheckpoint: "never" });
	const projection = parent.inspectionProjection();
	projectBranch(projection, ast, [item.invoke]);
	const pending = projection.pendingActions.find((candidate): candidate is Extract<(typeof projection.pendingActions)[number], { phase: "running" }> => candidate.phase === "running" && candidate.invokeSeqId === item.seqId);
	if (pending === undefined) return base;
	const invocation = actionEffectInfo(renderPendingActionInvocation(ast, projection, pending));
	const inputs = item.invoke.input ?? projection.inputs[item.state];
	const hasRecordedInput = item.invoke.input !== undefined;
	const instance = nearestInstance(item.state);
	const mapValue = instance === undefined ? undefined : projection.spawns[instance.container]?.[instance.key];
	return {
		...base,
		invocation,
		...(inputs === undefined || !hasRecordedInput && Object.keys(inputs).length === 0 ? {} : { inputs: { ...inputs } }),
		...(instance === undefined ? {} : { mapItem: { key: instance.key, ...(mapValue === undefined ? {} : { value: mapValue }) } }),
	};
}

/**
 * Internal correctness scaffolding: existing AST-aware visit/message mapping still needs the
 * captured prefix. It drains only bounded public pages and never exposes this array. Replace
 * it with predecessor-catalog-backed targeted mapping after that catalog passes its benchmark.
 */
async function collectSnapshotRecordsForMapping(
	store: Awaited<ReturnType<typeof openRunLogStore>>,
	snapshot: { branchId: string; headSeqId: number | null },
): Promise<readonly import("../core/durable_events.js").DurableLogRecord[]> {
	const newestFirst: import("../core/durable_events.js").DurableLogRecord[] = [];
	let cursor: HistoryCursor | undefined;
	do {
		const chunk = await store.readRecords({ snapshot, ...(cursor === undefined ? {} : { cursor }) });
		newestFirst.push(...chunk.items);
		cursor = chunk.older;
	} while (cursor !== undefined);
	return newestFirst.reverse();
}

function actionEffectInfo(effect: ActionEffect): HyperchartVisitInfo["invocation"] {
	switch (effect.kind) {
		case "agent": return {
			kind: "agent",
			...(effect.task === undefined ? {} : { task: effect.task }),
			...(effect.resume?.message === undefined ? {} : { resumeMessage: effect.resume.message }),
			...(effect.reads === undefined ? {} : { reads: effect.reads.map(renderedArtifactInfo) }),
			...(effect.artifacts === undefined ? {} : { artifacts: effect.artifacts.map(renderedArtifactInfo) }),
		};
		case "script": return {
			kind: "script", command: effect.command, args: [...effect.args],
			...(effect.env === undefined ? {} : { env: Object.fromEntries(Object.entries(effect.env).map(([name, value]) => [name, typeof value === "string" ? value : renderedArtifactInfo(value)])) }),
			...(effect.artifacts === undefined ? {} : { artifacts: effect.artifacts.map(renderedArtifactInfo) }),
		};
		case "user": return { kind: "user", prompt: effect.prompt };
	}
}

function renderedArtifactInfo(artifact: RenderedArtifact) {
	return {
		...(artifact.name === undefined ? {} : { name: artifact.name }),
		...(artifact.sourceState === undefined ? {} : { sourceState: artifact.sourceState }),
		...(artifact.readKind === undefined ? {} : { readKind: artifact.readKind }),
		path: artifact.path,
		...(artifact.select === undefined ? {} : { select: artifact.select }),
		...(artifact.shape === undefined ? {} : { schema: { schema: artifact.shape.schema } }),
	};
}

function mapChunk<A, B>(chunk: HistoryChunk<A>, map: (item: A, index: number) => B): HistoryChunk<B> {
	return {
		snapshot: chunk.snapshot,
		items: chunk.items.map(map),
		...(chunk.older === undefined ? {} : { older: chunk.older }),
		...(chunk.newer === undefined ? {} : { newer: chunk.newer }),
	};
}

function sessionFromProgress(session: ReturnType<typeof readSessionProgress>["sessions"][string]): HyperchartAgentSessionInfo {
	return {
		actionKey: session.actionKey,
		status: session.status,
		startedAt: session.startedAt,
		lastActivityAt: session.lastActivityAt,
		...(session.role === undefined ? {} : { role: session.role }),
		...(session.model === undefined ? {} : { model: session.model }),
		...(session.thinking === undefined ? {} : { thinking: session.thinking }),
		...(session.toolset === undefined ? {} : { toolset: session.toolset }),
		...(session.tools === undefined ? {} : { tools: session.tools }),
		turnCount: session.turnCount,
		toolCount: session.toolCount,
		...(session.tokenCount === undefined ? {} : { tokenCount: session.tokenCount }),
		...(session.error === undefined ? {} : { error: session.error }),
	};
}
