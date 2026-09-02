import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { actionUidKey } from "../core/action_uid.js";
import { templatePath } from "../core/paths.js";
import {
	inspectChartAst,
	parseChartModuleSync,
	type HyperchartInspectAgentDefaults,
} from "../core/inspect.js";
import type { ActionUID, ChartAst } from "../core/types.js";
import type { BranchProjection } from "../core/projection.js";
import type { BranchId, DurableLogRecord } from "../core/durable_events.js";
import { hyperchartRunFromRuntime } from "../host/adapters.js";
import type { HyperchartRunInfo, HyperchartRunOverview, HyperchartSessionMessageInfo } from "../host/index.js";
import { resolveAgentDefaults } from "../runtime/generic/agent_definitions.js";
import type { BranchHead } from "../core/durable_events.js";
import { openRunLogStore } from "../runtime/generic/log_store_factory.js";
import type { BranchListChunk, HistorySnapshot } from "../runtime/generic/log_store.js";
import { loadBranchProjection, projectionContractForAst } from "../runtime/generic/projection_loader.js";
import { loadRunMeta, type RunMeta } from "../runtime/generic/run_dir.js";
import { readRunStatus } from "../runtime/generic/run_status.js";
import { readRunnerConfig } from "../runtime/generic/runner_main.js";
import { readSessionProgress, sessionProgressKey } from "../runtime/generic/session_progress.js";

export type InvocationTranscriptBinding = Readonly<{ sessionId: string }>;

export type SessionTranscriptReader = (
	binding: InvocationTranscriptBinding,
) => Promise<HyperchartSessionMessageInfo[] | undefined>;

export type HyperchartRunFromRunDirBaseOptions = {
	/** Explicit non-durable branch selection; defaults only for internal/static callers. */
	branchId?: BranchId;
	meta?: RunMeta;
	ast?: ChartAst;
	agentDefaults?: (agentName: string) => HyperchartInspectAgentDefaults | undefined;
	now?: number;
};

export type HyperchartRunFromRunDirOptions = HyperchartRunFromRunDirBaseOptions & (
	| {
			/** Compact inspection without transcript message payloads. */
			includeTranscripts?: false;
	  }
	| {
			/** Full inspection requires an explicit host-owned transcript reader. */
			includeTranscripts: true;
			readTranscript: SessionTranscriptReader;
	  }
);

export async function hyperchartRunFromRunDir(
	runDir: string,
	options: HyperchartRunFromRunDirOptions = {},
): Promise<HyperchartRunInfo> {
	const absoluteRunDir = resolve(runDir);
	const meta = options.meta ?? await loadRunMeta(absoluteRunDir);
	const ast = options.ast ?? parsedRunAst(meta);
	const agentDefaults = runAgentDefaults(absoluteRunDir, options.agentDefaults);
	const inspect = inspectChartAst(ast, {
		chartPath: meta.chartPath,
		...(meta.exportName === undefined ? {} : { exportName: meta.exportName }),
		...(agentDefaults === undefined ? {} : { agentDefaults }),
	});
	const status = readRunStatus(absoluteRunDir);
	const branchId = options.branchId ?? "main";
	let records: readonly DurableLogRecord[] = [];
	let branches: readonly BranchHead[] | undefined;
	let initialBranches: BranchListChunk | undefined;
	let snapshot: HistorySnapshot | undefined;
	let projection: BranchProjection | undefined;
	const store = await openRunLogStore(absoluteRunDir, { access: "read", branchId });
	try {
		let syntheticEmptyBranch = false;
		try {
			snapshot = await store.captureSnapshot(branchId);
		} catch (error) {
			if (await store.countRecords() !== 0) throw error;
			snapshot = { branchId, headSeqId: null };
			syntheticEmptyBranch = true;
		}
		const loaded = await loadBranchProjection({ ast, branchId, store, contract: projectionContractForAst(ast), snapshot, saveCheckpoint: "never" });
		projection = loaded.projection;
		const [recordChunk, branchChunk] = await Promise.all([
			syntheticEmptyBranch ? Promise.resolve({ snapshot, items: [] as readonly DurableLogRecord[] }) : store.readRecords({ snapshot }),
			store.listBranches(),
		]);
		records = [...recordChunk.items].reverse();
		initialBranches = branchChunk;
		branches = branchChunk.items;
	} finally {
		await store.close();
	}
	const sessionsDir = resolve(absoluteRunDir, "sessions");
	const rawSessionProgress = readSessionProgress(sessionsDir);
	const branchSessionProgress = {
		...rawSessionProgress,
		sessions: Object.fromEntries(
			Object.entries(rawSessionProgress.sessions).filter(([, session]) => session.branchId === branchId),
		),
	};
	const runId = status?.runId ?? basename(absoluteRunDir);
	const runtimeRecords = records;
	const overviewSessionProgress = projection !== undefined && options.includeTranscripts !== true
		? currentSessionProgress(branchSessionProgress, projection)
		: branchSessionProgress;
	const sessionProgress = options.includeTranscripts === true
		? await sessionProgressWithVisitTranscripts(
				runtimeRecords,
				branchSessionProgress,
				options.readTranscript,
			)
		: overviewSessionProgress;
	const createdAt = Date.parse(meta.createdAt);
	const run = hyperchartRunFromRuntime(inspect, ast, runtimeRecords, {
		runId,
		...(status === undefined ? {} : { status }),
		sessionProgress,
		cwd: meta.workDir,
		branchWorkspace: join(absoluteRunDir, "workspaces", branchId),
		...(Number.isNaN(createdAt) ? {} : { createdAt }),
		...(options.now === undefined ? {} : { now: options.now }),
		...(projection === undefined ? {} : { projection }),
	});
	const selected = projection !== undefined && options.includeTranscripts !== true ? overviewOnly(run, projection) : run;
	return {
		...selected,
		...(snapshot === undefined ? {} : { historySnapshot: snapshot }),
		branchId,
		...(status === undefined ? {} : { runnerBranchIds: status.branchIds }),
		...(initialBranches === undefined ? {} : { branchCount: initialBranches.totalCount, ...(initialBranches.next === undefined ? {} : { branchListNext: initialBranches.next }) }),
		...(branches === undefined ? {} : {
			branches: branches.map((branch) => ({
				branchId: branch.branchId,
				headSeqId: branch.headSeqId,
				...(branch.metadata?.name === undefined ? {} : { name: branch.metadata.name }),
				...(branch.metadata?.reason === undefined ? {} : { reason: branch.metadata.reason }),
			})),
		}),
	};
}

export async function hyperchartRunOverviewFromRunDir(
	runDir: string,
	options: Omit<HyperchartRunFromRunDirOptions, "includeTranscripts" | "readTranscript"> = {},
): Promise<HyperchartRunOverview> {
	const run = await hyperchartRunFromRunDir(runDir, { ...options, includeTranscripts: false });
	if (run.historySnapshot === undefined) throw new Error("Bounded run overview did not capture a history snapshot");
	const store = await openRunLogStore(resolve(runDir), { access: "read", branchId: run.historySnapshot.branchId });
	try {
		const initialBranches = await store.listBranches();
		return { run, branchCount: initialBranches.totalCount, initialBranches, snapshot: run.historySnapshot };
	} finally { await store.close(); }
}

function currentSessionProgress(
	progress: ReturnType<typeof readSessionProgress>,
	projection: BranchProjection,
): ReturnType<typeof readSessionProgress> {
	const pendingInvokes = new Set(projection.pendingActions.map((pending) => pending.invokeSeqId));
	const retainedSessionIds = new Set(Object.values(projection.sessions));
	const latestByAction = new Map<string, number>();
	const summaryKey = (session: (typeof progress.sessions)[string]) => `${templatePath(session.actionUid.state)}:${session.actionUid.action}`;
	for (const session of Object.values(progress.sessions)) latestByAction.set(summaryKey(session), Math.max(latestByAction.get(summaryKey(session)) ?? 0, session.invokeSeqId));
	return {
		...progress,
		sessions: Object.fromEntries(Object.entries(progress.sessions).filter(([, session]) =>
			pendingInvokes.has(session.invokeSeqId)
			|| session.sessionId !== undefined && retainedSessionIds.has(session.sessionId)
			|| latestByAction.get(summaryKey(session)) === session.invokeSeqId,
		)),
	};
}

/** @internal Bounded transport projection characterized independently from disk loading. */
export function overviewOnly(run: HyperchartRunInfo, projection: BranchProjection): HyperchartRunInfo {
	const states = run.states.map((state) => {
		const visitCount = Object.entries(projection.stateVisits)
			.filter(([key]) => key.includes(`:${state.runtimeStatePath ?? state.id}:`))
			.reduce((total, [, count]) => total + count, 0);
		const latestVisit = state.visitHistory?.at(-1);
		const session = state.session === undefined ? undefined : withoutMessages(state.session);
		const hasMapRuntime = state.type === "map" && projection.spawns[state.id] !== undefined;
		const actorMessageCount = state.actorOccurrence?.mailbox.totalCount ?? state.actorMessageHistory?.length ?? 0;
		const actorOccurrence = state.actorOccurrence === undefined ? undefined : actorOccurrenceOverview(state.actorOccurrence);
		const actorInternal = state.actorInternal === undefined ? undefined : (() => {
			const generations = state.actorInternal.generations?.slice(-1).map((generation) => {
				const { visitHistory: _visits, actorMessageHistory: _messages, actorMessages: _sent, ...current } = generation;
				return current;
			});
			const { generations: _old, ...current } = state.actorInternal;
			return { ...current, ...(generations === undefined ? {} : { generations }) };
		})();
		const actorMessageLink = state.actorMessageLink === undefined ? undefined : (() => {
			const { messages: _messages, ...current } = state.actorMessageLink;
			return current;
		})();
		const mapConfig = state.mapConfig === undefined ? undefined : (() => {
			const { visitHistory: _visits, ...current } = state.mapConfig;
			return current;
		})();
		const { visitHistory: _visits, actorMessageHistory: _actorMessages, mapConfig: _map, actorOccurrence: _actor, actorInternal: _internal, actorMessageLink: _link, ...base } = state;
		return {
			...base,
			...(mapConfig === undefined ? {} : { mapConfig }),
			...(session === undefined ? {} : { session }),
			...(actorOccurrence === undefined ? {} : { actorOccurrence }),
			...(actorInternal === undefined ? {} : { actorInternal }),
			...(actorMessageLink === undefined ? {} : { actorMessageLink }),
			runtimeSummary: {
				status: state.status,
				visitCount,
				...(latestVisit === undefined ? {} : { latestVisit: { visit: latestVisit.visit, invokeSeqId: latestVisit.invokeSeqId, startedAt: latestVisit.startedAt, ...(latestVisit.endedAt === undefined ? {} : { endedAt: latestVisit.endedAt }), status: latestVisit.status } }),
				...(session === undefined ? {} : { activeSession: session }),
				...(state.usage === undefined ? {} : { usage: state.usage }),
				issueCount: state.issues?.length ?? 0,
				actorMessageCount,
				hasOlderRuntime: visitCount > 0 || actorMessageCount > 0 || hasMapRuntime,
			},
		};
	});
	const actorOccurrences = run.actorOccurrences?.map(actorOccurrenceOverview);
	const { recordTree: _tree, actorOccurrences: _actors, ...baseRun } = run;
	return { ...baseRun, states, ...(actorOccurrences === undefined ? {} : { actorOccurrences }) };
}

function actorOccurrenceOverview(actor: NonNullable<HyperchartRunInfo["actorOccurrences"]>[number]) {
	const { generationHistory: _generations, messageHistory: _messages, batchCalls: _batchCalls, ...current } = actor;
	const mailbox = { totalCount: actor.mailbox.totalCount, ...(actor.mailbox.head === undefined ? {} : { head: actor.mailbox.head }) };
	const mailboxInstances = current.mailboxInstances.slice(-1).map((instance) => {
		const { messageHistory: _history, mailbox: instanceMailbox, ...summary } = instance;
		return { ...summary, mailbox: { totalCount: instanceMailbox.totalCount, ...(instanceMailbox.head === undefined ? {} : { head: instanceMailbox.head }) } };
	});
	const workers = current.workers?.map((worker) => {
		const { messageHistory: _workerMessages, visitHistory: _workerVisits, session, ...summary } = worker;
		return { ...summary, ...(session === undefined ? {} : { session: withoutMessages(session) }) };
	});
	return { ...current, mailbox, mailboxInstances, ...(workers === undefined ? {} : { workers }) };
}

function withoutMessages(session: NonNullable<HyperchartRunInfo["states"][number]["session"]>) {
	const { messages: _messages, ...summary } = session;
	return summary;
}

async function sessionProgressWithVisitTranscripts(
	records: readonly DurableLogRecord[],
	progress: ReturnType<typeof readSessionProgress>,
	readTranscript: SessionTranscriptReader,
) {
	const invocations = agentInvocationsByAction(records);
	const resolvedSessions = await Promise.all(
		Object.entries(progress.sessions).map(async ([key, session]) => {
			const invocation = invocations.get(session.actionKey)?.find(
				(candidate) => candidate.invokeSeqId === session.invokeSeqId,
			);
			const sessionId = session.sessionId ?? invocation?.sessionId;
			const messages = sessionId === undefined ? undefined : await readTranscript({ sessionId });
			const visit = session.visit ?? invocations.get(session.actionKey)?.at(-1)?.visit;
			return [key, {
				...session,
				...(visit === undefined ? {} : { visit }),
				...(messages === undefined ? {} : { messages }),
			}] as const;
		}),
	);
	const sessions = Object.fromEntries(resolvedSessions);
	const knownVisits = new Set(
		Object.values(sessions)
			.filter((session) => session.visit !== undefined && session.messages !== undefined)
			.map((session) => `${session.actionKey}:${session.visit}`),
	);
	for (const visits of invocations.values()) {
		for (const invocation of visits) {
			if (knownVisits.has(`${invocation.actionKey}:${invocation.visit}`)) continue;
			const messages = await readTranscript({ sessionId: invocation.sessionId });
			if (messages === undefined) continue;
			const progressKey = sessionProgressKey(
				invocation.actionUid,
				`${invocation.actionKey}:${invocation.visit}:${invocation.invokeSeqId}`,
				invocation.branchId,
			);
			sessions[progressKey] = {
				...sessions[progressKey],
				actionKey: invocation.actionKey,
				branchId: invocation.branchId,
				invokeSeqId: invocation.invokeSeqId,
				actionUid: invocation.actionUid,
				visit: invocation.visit,
				actionName: invocation.actionName,
				status: "completed",
				startedAt: invocation.startedAt,
				lastActivityAt: invocation.startedAt,
				turnCount: 0,
				toolCount: 0,
				messages,
			};
			for (const [key, candidate] of Object.entries(sessions)) {
				if (
					key !== progressKey &&
					candidate.actionKey === invocation.actionKey &&
					candidate.visit === invocation.visit &&
					candidate.messages === undefined
				) delete sessions[key];
			}
			knownVisits.add(`${invocation.actionKey}:${invocation.visit}`);
		}
	}
	return { ...progress, sessions };
}

type AgentInvocationVisit = {
	branchId: string;
	actionUid: ActionUID;
	actionKey: string;
	actionName: string;
	visit: number;
	invokeSeqId: number;
	sessionId: string;
	startedAt: number;
};

function agentInvocationsByAction(records: readonly DurableLogRecord[]): Map<string, AgentInvocationVisit[]> {
	const byAction = new Map<string, AgentInvocationVisit[]>();
	for (const record of records) {
		if (record.type !== "state_action" || record.kind !== "invoke" || record.definition.kind !== "agent") continue;
		const actionKey = actionUidKey(record.actionUid);
		const visits = byAction.get(actionKey) ?? [];
		visits.push({
			branchId: record.branchId,
			actionUid: record.actionUid,
			actionKey,
			actionName: record.definition.name,
			visit: visits.length + 1,
			invokeSeqId: record.seqId,
			sessionId: record.sessionId,
			startedAt: record.timestamp,
		});
		byAction.set(actionKey, visits);
	}
	return byAction;
}

function runAgentDefaults(
	runDir: string,
	resolver: HyperchartRunFromRunDirOptions["agentDefaults"],
): HyperchartRunFromRunDirOptions["agentDefaults"] {
	if (resolver === undefined) return undefined;
	const configPath = resolve(runDir, "runner.config.json");
	if (!existsSync(configPath)) return resolver;
	try {
		const config = readRunnerConfig(configPath);
		return (agentName) => {
			const defaults = resolver(agentName);
			return defaults === undefined
				? undefined
				: resolveAgentDefaults(defaults, {
						...(config.defaultModel === undefined ? {} : { defaultModel: config.defaultModel }),
						...(config.modelRoles === undefined ? {} : { modelRoles: config.modelRoles }),
						...(config.toolsets === undefined ? {} : { toolsets: config.toolsets }),
					});
		};
	} catch {
		return (agentName) => {
			const defaults = resolver(agentName);
			if (defaults === undefined) return undefined;
			const declared = { ...defaults };
			delete declared.resolvedModel;
			delete declared.resolvedTools;
			return declared;
		};
	}
}

function parsedRunAst(meta: RunMeta): ChartAst {
	const parsed = parseChartModuleSync(
		meta.chartPath,
		meta.exportName === undefined ? {} : { exportName: meta.exportName },
	);
	if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	return parsed.ast;
}
