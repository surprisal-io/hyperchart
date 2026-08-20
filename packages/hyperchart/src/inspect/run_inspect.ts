import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { actionUidDirName, actionUidKey, sanitizeSegment } from "../core/action_uid.js";
import {
	inspectChartAst,
	parseChartModuleSync,
	type HyperchartInspectAgentDefaults,
} from "../core/inspect.js";
import type { ActionUID, ChartAst } from "../core/types.js";
import type { BranchId, DurableLogRecord } from "../core/durable_events.js";
import { hyperchartRunFromRuntime } from "../host/index.js";
import type { HyperchartRunInfo } from "../host/index.js";
import { resolveAgentDefaults } from "../runtime/generic/agent_definitions.js";
import { branchSessionSegment } from "../runtime/generic/executor_helpers.js";
import type { NormalizedRunLog } from "../runtime/generic/log_store.js";
import { openRunLogStore } from "../runtime/generic/log_store_factory.js";
import { loadRunMeta, type RunMeta } from "../runtime/generic/run_dir.js";
import { readRunStatus } from "../runtime/generic/run_status.js";
import { readRunnerConfig } from "../runtime/generic/runner_main.js";
import { readSessionProgress, sessionProgressKey } from "../runtime/generic/session_progress.js";
import { readNeutralSessionTranscript, type SessionTranscriptReader } from "./session_transcript.js";

export type HyperchartRunFromRunDirOptions = {
	/** Explicit non-durable branch selection; defaults only for internal/static callers. */
	branchId?: BranchId;
	meta?: RunMeta;
	ast?: ChartAst;
	records?: readonly DurableLogRecord[];
	agentDefaults?: (agentName: string) => HyperchartInspectAgentDefaults | undefined;
	now?: number;
	/** Load and attach transcript message payloads. Defaults to false for compact snapshots. */
	includeTranscripts?: boolean;
	/** Host-specific session transcript reader; defaults to the neutral JSONL format when transcripts are included. */
	readTranscript?: SessionTranscriptReader;
};

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
			records = normalized.mutations.length === 0 ? [] : normalized.ancestry(branchId);
		} finally {
			await store.close();
		}
	}
	const sessionsDir = resolve(absoluteRunDir, "sessions");
	const readTranscript = options.readTranscript ?? readNeutralSessionTranscript;
	const transcriptCache = new Map<string, ReturnType<SessionTranscriptReader>>();
	const readFullTranscript: SessionTranscriptReader = (_sessionsDir, sessionFile) => {
		if (sessionFile === undefined) return undefined;
		if (transcriptCache.has(sessionFile)) return transcriptCache.get(sessionFile);
		const messages = readTranscript(sessionsDir, sessionFile, { limit: false });
		transcriptCache.set(sessionFile, messages);
		return messages;
	};
	const rawSessionProgress = readSessionProgress(sessionsDir);
	const branchSessionProgress = {
		...rawSessionProgress,
		sessions: Object.fromEntries(
			Object.entries(rawSessionProgress.sessions).filter(([, session]) => session.branchId === branchId),
		),
	};
	const sessionProgress = options.includeTranscripts === true
		? sessionProgressWithVisitTranscripts(sessionsDir, records, branchSessionProgress, readFullTranscript)
		: branchSessionProgress;
	const createdAt = Date.parse(meta.createdAt);
	const run = hyperchartRunFromRuntime(inspect, ast, records, {
		runId: status?.runId ?? basename(absoluteRunDir),
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

function sessionProgressWithVisitTranscripts(
	sessionsDir: string,
	records: readonly DurableLogRecord[],
	progress: ReturnType<typeof readSessionProgress>,
	readTranscript: SessionTranscriptReader,
) {
	const invocations = agentInvocationsByAction(records);
	const sessions = Object.fromEntries(
		Object.entries(progress.sessions).map(([key, session]) => {
			const messages = readTranscript(sessionsDir, session.sessionFile);
			const visit = session.visit ?? invocations.get(session.actionKey)?.at(-1)?.visit;
			return [
				key,
				{
					...session,
					...(visit === undefined ? {} : { visit }),
					...(messages === undefined ? {} : { messages }),
				},
			];
		}),
	);
	const knownVisits = new Set(
		Object.values(sessions)
			.filter((session) => session.visit !== undefined && session.messages !== undefined)
			.map((session) => `${session.actionKey}:${session.visit}`),
	);
	for (const visits of invocations.values()) {
		for (const invocation of visits) {
			if (knownVisits.has(`${invocation.actionKey}:${invocation.visit}`)) continue;
			const sessionFile = latestVisitTranscript(sessionsDir, invocation.branchId, invocation.actionUid, invocation.actionKey, invocation.visit);
			if (sessionFile === undefined) continue;
			const messages = readTranscript(sessionsDir, sessionFile);
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
				lastActivityAt: statSync(sessionFile).mtimeMs,
				sessionFile,
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
				) {
					delete sessions[key];
				}
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
			startedAt: record.timestamp,
		});
		byAction.set(actionKey, visits);
	}
	return byAction;
}

function latestVisitTranscript(
	sessionsDir: string,
	branchId: string,
	actionUid: ActionUID,
	actionKey: string,
	visit: number,
): string | undefined {
	const root = join(sessionsDir, branchSessionSegment(branchId), actionUidDirName(actionUid), sanitizeSegment(`${actionKey}:${visit}`));
	if (!existsSync(root)) return undefined;
	const candidates = transcriptFiles(root);
	return candidates.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

function transcriptFiles(root: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...transcriptFiles(path));
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
	}
	return files;
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
