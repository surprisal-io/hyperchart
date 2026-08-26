import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { actionUidKey } from "../core/action_uid.js";
import {
	inspectChartAst,
	parseChartModuleSync,
	type HyperchartInspectAgentDefaults,
} from "../core/inspect.js";
import type { ActionUID, ChartAst } from "../core/types.js";
import type { BranchId, DurableLogRecord } from "../core/durable_events.js";
import { hyperchartRunFromRuntime } from "../host/index.js";
import type { HyperchartRunInfo, HyperchartSessionMessageInfo } from "../host/index.js";
import { resolveAgentDefaults } from "../runtime/generic/agent_definitions.js";
import type { NormalizedRunLog } from "../runtime/generic/log_store.js";
import { openRunLogStore } from "../runtime/generic/log_store_factory.js";
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
	records?: readonly DurableLogRecord[];
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
	const meta = options.meta ?? loadRunMeta(absoluteRunDir);
	const ast = options.ast ?? parsedRunAst(meta);
	const agentDefaults = runAgentDefaults(absoluteRunDir, options.agentDefaults);
	const inspect = inspectChartAst(ast, {
		chartPath: meta.chartPath,
		...(meta.exportName === undefined ? {} : { exportName: meta.exportName }),
		...(agentDefaults === undefined ? {} : { agentDefaults }),
	});
	const status = readRunStatus(absoluteRunDir);
	const branchId = options.branchId ?? "main";
	let records = options.records;
	let normalized: NormalizedRunLog | undefined;
	if (records === undefined) {
		const store = await openRunLogStore(absoluteRunDir, { branchId });
		try {
			normalized = await store.read();
			records = normalized.entries.length === 0 ? [] : normalized.ancestry(branchId);
		} finally {
			await store.close();
		}
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
	const sessionProgress = options.includeTranscripts === true
		? await sessionProgressWithVisitTranscripts(
				records,
				branchSessionProgress,
				options.readTranscript,
			)
		: branchSessionProgress;
	const createdAt = Date.parse(meta.createdAt);
	const run = hyperchartRunFromRuntime(inspect, ast, records, {
		runId,
		...(status === undefined ? {} : { status }),
		sessionProgress,
		cwd: meta.workDir,
		branchWorkspace: join(absoluteRunDir, "workspaces", branchId),
		...(Number.isNaN(createdAt) ? {} : { createdAt }),
		...(options.now === undefined ? {} : { now: options.now }),
	});
	return {
		...run,
		branchId,
		...(status === undefined ? {} : { runnerBranchIds: status.branchIds }),
		...(normalized === undefined ? {} : {
			branches: [...normalized.branches.values()].map((branch) => ({
				branchId: branch.branchId,
				headSeqId: branch.headSeqId,
				...(branch.metadata?.name === undefined ? {} : { name: branch.metadata.name }),
				...(branch.metadata?.reason === undefined ? {} : { reason: branch.metadata.reason }),
			})),
			recordTree: normalized.records.map((record) => ({ seqId: record.seqId, parentId: record.parentId, branchId: record.branchId, type: record.type, timestamp: record.timestamp })),
		}),
	};
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
