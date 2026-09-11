import { explainReplay, type ReplayBrokenRecord } from "../core/replay_check.js";
import { historyItemsForSubject } from "../runtime/generic/log_store.js";
import { resolveRunPaths, withRunStorage } from "../runtime/generic/run_paths.js";
import { actionUidKey } from "../core/action_uid.js";
import { basename, resolve } from "node:path";
import type {
	HyperchartActorMessageBatchInfo,
	HyperchartAgentSessionInfo,
	HyperchartRecordInfo,
	HyperchartVisitInfo,
} from "../host/models.js";
import type { HyperchartInspectorDataSource } from "../host/adapter.js";
import { openRunLogStore } from "../runtime/generic/log_store_factory.js";
import { BranchExecution } from "../execution/branch_execution.js";
import type { DurableLogRecord } from "../core/durable_events.js";
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
import {
	actorGenerationHistoryItemToHost,
	actorMessageHistoryItemsToHost,
	actorMessageHistoryItemToHost,
	durableRecordToHost,
	mapVisitHistoryItemToHost,
	stateVisitHistoryItemToHost,
} from "./history_mapping.js";
import { runtimeVisitHistoriesForInspector } from "../host/adapters.js";

export async function createRunInspectorDataSource(
	runId: string,
	options: {
		ast?: ChartAst;
		readTranscript?: SessionTranscriptReader;
	} = {},
): Promise<HyperchartInspectorDataSource> {
	const { runDir: absoluteRunDir, storage } = resolveRunPaths(runId);
	const meta = await loadRunMeta(runId);
	const parsed =
		options.ast === undefined
			? parseChartModuleSync(meta.chartPath, meta.exportName === undefined ? {} : { exportName: meta.exportName })
			: { ok: true as const, ast: options.ast };
	if (!parsed.ok) {
		throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	}
	const assertRun = (candidate: string) => {
		if (candidate !== runId) {
			throw new Error(`Inspector data source is bound to run '${runId}'`);
		}
	};
	const withStore = async <T>(
		operation: (store: Awaited<ReturnType<typeof openRunLogStore>>) => Promise<T>,
	): Promise<T> =>
		withRunStorage(storage, async () => {
			const store = await openRunLogStore(runId, {
				access: "read",
				storage,
			});
			try {
				return await operation(store);
			} finally {
				await store.close();
			}
		});
	return {
		listBranches: async ({ runId: candidate, cursor }) => {
			assertRun(candidate);
			return withStore((store) => store.listBranches(cursor));
		},
		readStateVisits: async ({ runId: candidate, snapshot, stateId, cursor }) => {
			assertRun(candidate);
			return withStore(async (store) => {
				const chunk = await readChunkOrEmpty(store, snapshot, () =>
					store.readStateVisits({ snapshot, state: stateId, ...(cursor === undefined ? {} : { cursor }) }),
				);
				const records = await collectSnapshotRecordsForMapping(store, snapshot);
				const broken = explainReplay(parsed.ast, records).broken;
				if (broken !== undefined) {
					return mapChunk(chunk, (item) => incompatibleStateVisitToHost(item, broken));
				}
				const semanticVisits = runtimeVisitHistoriesForInspector(parsed.ast, records).get(stateId) ?? [];
				return mapChunkAsync(chunk, (item) =>
					stateVisitWithProjection(
						store,
						parsed.ast,
						snapshot.branchId,
						item,
						semanticVisits.find((visit) => visit.invokeSeqId === item.seqId),
					),
				);
			});
		},
		readMapVisits: async ({ runId: candidate, snapshot, mapPath, cursor }) => {
			assertRun(candidate);
			return withStore(async (store) =>
				mapChunk(
					await readChunkOrEmpty(store, snapshot, () =>
						store.readMapVisits({ snapshot, mapPath, ...(cursor === undefined ? {} : { cursor }) }),
					),
					mapVisitHistoryItemToHost,
				),
			);
		},
		readActorGenerations: async ({ runId: candidate, snapshot, logicalOccurrence, cursor }) => {
			assertRun(candidate);
			return withStore(async (store) =>
				mapChunk(
					await readChunkOrEmpty(store, snapshot, () =>
						store.readActorGenerations({ snapshot, logicalOccurrence, ...(cursor === undefined ? {} : { cursor }) }),
					),
					actorGenerationHistoryItemToHost,
				),
			);
		},
		readActorMessages: async ({ runId: candidate, snapshot, occurrence, cursor }) => {
			assertRun(candidate);
			return withStore(async (store) => {
				const chunk = await readChunkOrEmpty(store, snapshot, () =>
					store.readActorMessages({ snapshot, occurrence, ...(cursor === undefined ? {} : { cursor }) }),
				);
				const records = await collectSnapshotRecordsForMapping(store, snapshot);
				const items =
					explainReplay(parsed.ast, records).broken === undefined
						? actorMessageHistoryItemsToHost(chunk.items, parsed.ast, records)
						: chunk.items.map((item) => actorMessageHistoryItemToHost(item));
				return { ...chunk, items };
			});
		},
		readRecords: async ({ runId: candidate, snapshot, cursor, includeActionVisits }) => {
			assertRun(candidate);
			return withStore(async (store) => {
				const chunk = await readChunkOrEmpty(store, snapshot, () =>
					store.readRecords({ snapshot, ...(cursor === undefined ? {} : { cursor }) }),
				);
				if (includeActionVisits !== true || !chunk.items.some(isActionInvoke)) {
					return mapChunk(chunk, durableRecordToHost);
				}
				const ancestry = await collectSnapshotRecordsForMapping(store, snapshot);
				return {
					...chunk,
					items: actionVisitRecordsToHost(chunk.items, parsed.ast, ancestry),
				};
			});
		},
		cursorAt: async ({ runId: candidate, ...input }) => {
			assertRun(candidate);
			return withStore(async (store) => {
				try {
					return await store.cursorAt(input);
				} catch (error) {
					if (
						isMissingSyntheticBranch(error) &&
						input.snapshot.headSeqId === null &&
						(await store.countRecords()) === 0
					) {
						return undefined;
					}
					throw error;
				}
			});
		},
		readVisitSession: async ({ runId: candidate, snapshot, invokeSeqId }) => {
			assertRun(candidate);
			return withStore(async (store) => {
				const live = await store.captureSnapshot(snapshot.branchId);
				if (
					snapshot.headSeqId !== null &&
					!(await store.containsInHistory({ headSeqId: live.headSeqId, seqId: snapshot.headSeqId }))
				) {
					return undefined;
				}
				if (!(await store.containsInHistory({ headSeqId: snapshot.headSeqId, seqId: invokeSeqId }))) {
					return undefined;
				}
				const record = await store.getRecord(invokeSeqId);
				if (!isActionInvoke(record) || record.definition.kind !== "agent") {
					return undefined;
				}
				const records = await collectSnapshotRecordsForMapping(store, snapshot);
				const broken = explainReplay(parsed.ast, records).broken;
				const visits =
					broken === undefined
						? runtimeVisitHistoriesForInspector(parsed.ast, records)
						: incompatibleVisitHistories(records, broken);
				const visit = visits.get(record.actionUid.state)?.find((item) => item.invokeSeqId === invokeSeqId);
				if (visit === undefined) {
					return undefined;
				}
				const liveBoundary = live.headSeqId === snapshot.headSeqId;
				const boundary = records.at(-1)?.timestamp;
				const end = visit.endedAt ?? (broken === undefined && liveBoundary ? Date.now() : boundary);
				// A reused session can contain later invocations. Never leak them into an
				// unresolved record-only visit whose semantic exit could not be derived.
				const nextInvoke = records.find(
					(candidate) =>
						isActionInvoke(candidate) && candidate.seqId > invokeSeqId && candidate.sessionId === record.sessionId,
				);
				const progress = readSessionProgress(resolve(absoluteRunDir, "sessions"));
				const match = Object.values(progress.sessions)
					.filter(
						(session) =>
							session.sessionId === record.sessionId &&
							session.branchId === record.branchId &&
							session.invokeSeqId >= invokeSeqId &&
							session.invokeSeqId <= (snapshot.headSeqId ?? 0),
					)
					.sort((a, b) => b.invokeSeqId - a.invokeSeqId)[0];
				const messages = await options.readTranscript?.({ sessionId: record.sessionId });
				return {
					...(match === undefined || broken !== undefined ? {} : sessionFromProgress(match)),
					actionKey: actionUidKey(record.actionUid),
					status: visit.status === "done" ? "completed" : visit.status,
					startedAt: visit.startedAt,
					...(end === undefined ? {} : { lastActivityAt: end }),
					...(messages === undefined
						? {}
						: {
								messages: messages.filter(
									(message) =>
										message.timestamp !== undefined &&
										message.timestamp >= visit.startedAt &&
										end !== undefined &&
										message.timestamp <= end &&
										(broken === undefined || nextInvoke === undefined || message.timestamp < nextInvoke.timestamp),
								),
							}),
				};
			});
		},
	};
}

export function stateVisitHistoryChunkToHost(
	chunk: HistoryChunk<StateVisitHistoryItem>,
): HistoryChunk<HyperchartVisitInfo> {
	return mapChunk(chunk, (item) => stateVisitHistoryItemToHost(item));
}

export function actorMessageHistoryChunkToHost(
	chunk: HistoryChunk<ActorMessageHistoryItem>,
): HistoryChunk<HyperchartActorMessageBatchInfo> {
	return mapChunk(chunk, (item) => actorMessageHistoryItemToHost(item));
}

export function actionVisitRecordsToHost(
	pageRecords: readonly DurableLogRecord[],
	ast: ChartAst,
	ancestry: readonly DurableLogRecord[],
): HyperchartRecordInfo[] {
	const requested = new Set(pageRecords.filter(isActionInvoke).map((record) => record.seqId));
	const visitsBySeqId = new Map<number, HyperchartVisitInfo>();
	const broken = explainReplay(ast, ancestry).broken;
	const semantic =
		broken === undefined
			? runtimeVisitHistoriesForInspector(ast, ancestry)
			: incompatibleVisitHistories(ancestry, broken);
	for (const visits of semantic.values()) {
		for (const visit of visits) {
			if (requested.has(visit.invokeSeqId)) {
				visitsBySeqId.set(visit.invokeSeqId, visit);
			}
		}
		if (visitsBySeqId.size === requested.size) {
			break;
		}
	}
	return pageRecords.map((record) => {
		const base = durableRecordToHost(record);
		const actionVisit = isActionInvoke(record) ? visitsBySeqId.get(record.seqId) : undefined;
		return actionVisit === undefined ? base : { ...base, actionVisit };
	});
}

/** Durable catalog mapping only: no current-AST invocation rendering or scope-exit inference. */
function incompatibleStateVisitToHost(item: StateVisitHistoryItem, broken: ReplayBrokenRecord): HyperchartVisitInfo {
	const base = stateVisitHistoryItemToHost(item);
	const { artifactPins: _pins, endedAt: _end, completedEvent: _event, status: _status, ...recorded } = base;
	// Without the historical guard contract, a completion is only a claim, even
	// when no validation has been recorded yet. Never infer acceptance from its absence.
	const terminal = [...item.records]
		.reverse()
		.find(
			(record) =>
				record.type === "failure_intent" ||
				(record.type === "state_action" &&
					(record.kind === "timer_fired" ||
						(record.kind === "complete" && record.event.type === "FAILED") ||
						(record.kind === "validated" && record.outcome === true))),
		);
	const event =
		terminal?.type === "failure_intent"
			? "FAILED"
			: terminal?.type === "state_action" && (terminal.kind === "complete" || terminal.kind === "validated")
				? terminal.event.type
				: undefined;
	const acceptedCompletion =
		terminal?.type === "state_action" && terminal.kind === "validated" && event !== "FAILED"
			? [...item.records]
					.reverse()
					.find(
						(record) => record.type === "state_action" && record.kind === "complete" && record.seqId < terminal.seqId,
					)
			: undefined;
	const recordedInputs = [...item.records]
		.reverse()
		.find(
			(record) =>
				(record.type === "state_action" || record.type === "user_interaction") &&
				"input" in record &&
				record.input !== undefined,
		);
	return {
		...recorded,
		status:
			terminal === undefined
				? "unknown"
				: event === "FAILED"
					? "failed"
					: terminal.type === "state_action" && terminal.kind === "timer_fired"
						? "cancelled"
						: "done",
		...(terminal === undefined ? {} : { endedAt: terminal.timestamp }),
		...(event === undefined ? {} : { completedEvent: event }),
		replayWarning: `Replay incompatible at seqId ${broken.seqId}: ${broken.error}. Recorded facts only; invocation templates are not rendered, runtime status and scope exits cannot be derived. Completion claims without explicit acceptance remain unknown.`,
		...(recordedInputs !== undefined &&
		(recordedInputs.type === "state_action" || recordedInputs.type === "user_interaction") &&
		"input" in recordedInputs
			? { inputs: { ...recordedInputs.input } }
			: {}),
		...(acceptedCompletion?.type === "state_action" &&
		acceptedCompletion.kind === "complete" &&
		acceptedCompletion.artifacts !== undefined
			? {
					artifactPins: Object.entries(acceptedCompletion.artifacts).map(([path, pin]) => ({
						path,
						hash: pin.hash,
						size: pin.size,
					})),
				}
			: {}),
	};
}

function incompatibleVisitHistories(
	records: readonly DurableLogRecord[],
	broken: ReplayBrokenRecord,
): ReadonlyMap<string, readonly HyperchartVisitInfo[]> {
	const states = new Set(records.filter(isActionInvoke).map((record) => record.actionUid.state));
	return new Map(
		[...states].map((state) => [
			state,
			historyItemsForSubject(records, { kind: "state-visits", state })
				.filter((item): item is StateVisitHistoryItem => "kind" in item && item.kind === "state-visit")
				.map((item) => incompatibleStateVisitToHost(item, broken))
				.reverse(),
		]),
	);
}

function isActionInvoke(
	record: DurableLogRecord | undefined,
): record is Extract<DurableLogRecord, { type: "state_action"; kind: "invoke" }> {
	return record?.type === "state_action" && record.kind === "invoke";
}

async function readChunkOrEmpty<T>(
	store: Awaited<ReturnType<typeof openRunLogStore>>,
	snapshot: { branchId: string; headSeqId: number | null },
	read: () => Promise<HistoryChunk<T>>,
): Promise<HistoryChunk<T>> {
	try {
		return await read();
	} catch (error) {
		if (isMissingSyntheticBranch(error) && snapshot.headSeqId === null && (await store.countRecords()) === 0) {
			return { snapshot, items: [] };
		}
		throw error;
	}
}

function isMissingSyntheticBranch(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("Unknown Hyperchart branch '");
}

async function mapChunkAsync<A, B>(
	chunk: HistoryChunk<A>,
	map: (item: A, index: number) => Promise<B>,
): Promise<HistoryChunk<B>> {
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
	const parent = await BranchExecution.restore({
		ast,
		branchId,
		store,
		snapshot: { branchId, headSeqId: item.invoke.parentId },
		saveCheckpoint: "never",
	});
	const projection = parent.inspectionProjection();
	projectBranch(projection, ast, [item.invoke]);
	const pending = projection.pendingActions.find(
		(candidate): candidate is Extract<(typeof projection.pendingActions)[number], { phase: "running" }> =>
			candidate.phase === "running" && candidate.invokeSeqId === item.seqId,
	);
	if (pending === undefined) {
		return base;
	}
	const invocation = actionEffectInfo(renderPendingActionInvocation(ast, projection, pending));
	const inputs = item.invoke.input ?? projection.inputs[item.state];
	const hasRecordedInput = item.invoke.input !== undefined;
	const instance = nearestInstance(item.state);
	const mapValue = instance === undefined ? undefined : projection.spawns[instance.container]?.[instance.key];
	return {
		...base,
		invocation,
		...(inputs === undefined || (!hasRecordedInput && Object.keys(inputs).length === 0)
			? {}
			: { inputs: { ...inputs } }),
		...(instance === undefined
			? {}
			: { mapItem: { key: instance.key, ...(mapValue === undefined ? {} : { value: mapValue }) } }),
	};
}

/**
 * Internal correctness scaffolding: existing AST-aware visit/message mapping still needs the
 * captured prefix. It drains only bounded public pages and never exposes this array. Replace
 * it with predecessor-catalog-backed targeted mapping after that catalog passes its benchmark.
 */
export async function collectSnapshotRecordsForMapping(
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
		case "agent":
			return {
				kind: "agent",
				...(effect.task === undefined ? {} : { task: effect.task }),
				...(effect.resume?.message === undefined ? {} : { resumeMessage: effect.resume.message }),
				...(effect.reads === undefined ? {} : { reads: effect.reads.map(renderedArtifactInfo) }),
				...(effect.artifacts === undefined ? {} : { artifacts: effect.artifacts.map(renderedArtifactInfo) }),
			};
		case "script":
			return {
				kind: "script",
				command: effect.command,
				args: [...effect.args],
				...(effect.env === undefined
					? {}
					: {
							env: Object.fromEntries(
								Object.entries(effect.env).map(([name, value]) => [
									name,
									typeof value === "string" ? value : renderedArtifactInfo(value),
								]),
							),
						}),
				...(effect.artifacts === undefined ? {} : { artifacts: effect.artifacts.map(renderedArtifactInfo) }),
			};
		case "tsImport":
			return {
				kind: "tsImport",
				module: effect.module,
				export: effect.export,
				...(effect.env === undefined
					? {}
					: {
							params: Object.fromEntries(
								Object.entries(effect.env).map(([name, value]) => [
									name,
									typeof value === "string" ? value : renderedArtifactInfo(value),
								]),
							),
						}),
				...(effect.artifacts === undefined ? {} : { artifacts: effect.artifacts.map(renderedArtifactInfo) }),
			};
		case "user":
			return { kind: "user", prompt: effect.prompt };
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

function sessionFromProgress(
	session: ReturnType<typeof readSessionProgress>["sessions"][string],
): HyperchartAgentSessionInfo {
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
