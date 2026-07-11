import { actionUidKey } from "../core/action_uid.js";
import type { DurableLogRecord } from "../core/durable_events.js";
import type { HyperchartInspectResult, HyperchartInspectState } from "../core/inspect.js";
import { renderPendingActionInvocation, type ActionEffect, type RenderedArtifact } from "../core/machine.js";
import {
	createBranchProjection,
	projectBranch,
	type PendingAction,
	type ProjectionSkippedRecord,
} from "../core/projection.js";
import type { ActionUID, ChartAst, ChartEvent, StatePath } from "../core/types.js";
import { instancePathFor, nearestInstance, nodeAt, templatePath, underScope } from "../core/paths.js";
import type {
	HyperchartInputInfo,
	HyperchartIssueInfo,
	HyperchartStateInfo,
	HyperchartRefInfo,
	HyperchartRunInfo,
	HyperchartRenderedArtifactInfo,
	HyperchartVisitInfo,
	HyperchartVisitInvocationInfo,
	HyperchartRunStatus,
	HyperchartStateStatus,
} from "./models.js";

export type HyperchartRunFromInspectOptions = {
	runId?: string;
	status?: HyperchartRunInfo["status"];
	cwd?: string;
	createdAt?: number;
	updatedAt?: number;
	args?: Record<string, unknown>;
	description?: string;
};

export function hyperchartRunFromInfo(
	info: import("./models.js").HyperchartInfo,
	options: Pick<HyperchartRunFromInspectOptions, "cwd"> = {},
): HyperchartRunInfo | undefined {
	if (!info.states) return undefined;
	const updatedAt = info.updatedAt ?? Date.now();
	return {
		runId: `chart:${info.name}`,
		chartName: info.name,
		mode: "static",
		...(info.definitionSource === undefined ? {} : { definitionSource: info.definitionSource }),
		description: info.description,
		status: "paused",
		cwd: options.cwd ?? "",
		createdAt: updatedAt,
		updatedAt,
		args: info.args ?? {},
		states: info.states,
		stateCount: info.stateCount,
	};
}

export function hyperchartRunFromInspectResult(
	result: HyperchartInspectResult,
	options: HyperchartRunFromInspectOptions = {},
): HyperchartRunInfo {
	const now = Date.now();
	const states = result.states.map(stateFromInspectState);
	return {
		runId: options.runId ?? `inspect:${result.chartId}`,
		chartName: result.chartId,
		mode: "static",
		...(result.definitionSource === undefined ? {} : { definitionSource: result.definitionSource }),
		...(options.description === undefined ? {} : { description: options.description }),
		status: options.status ?? "paused",
		cwd: options.cwd ?? "",
		createdAt: options.createdAt ?? now,
		updatedAt: options.updatedAt ?? now,
		args: options.args ?? {},
		states,
		stateCount: states.length,
	};
}

export function hyperchartRunFromToolDetails(
	details: unknown,
	options: HyperchartRunFromInspectOptions = {},
): HyperchartRunInfo | undefined {
	if (isRunInfo(details)) return details;
	const inspector = isRecord(details) ? details.inspector : undefined;
	if (isRunInfo(inspector)) return inspector;
	if (!isInspectResult(details)) return undefined;
	return hyperchartRunFromInspectResult(details, options);
}

type RuntimeStatusInfo = {
	runId?: string;
	runDir?: string;
	chartId?: string;
	state?: string;
	pid?: number;
	startedAt?: number;
	updatedAt?: number;
	heartbeatAt?: number;
	exitCode?: number;
	error?: string;
	replayWarnings?: readonly string[];
};

export type HyperchartRuntimeSessionProgressInfo = {
	actionUid: ActionUID;
	actionKey?: string;
	actionName?: string;
	status?: string;
	startedAt?: number;
	lastActivityAt?: number;
	completedAt?: number;
	sessionFile?: string;
	model?: string;
	turnCount?: number;
	toolCount?: number;
	tokenCount?: number;
	error?: string;
};

export type HyperchartRuntimeSessionProgressFile = {
	updatedAt?: number;
	sessions: Record<string, HyperchartRuntimeSessionProgressInfo>;
};

export type HyperchartRunFromRuntimeOptions = {
	runId?: string;
	status?: RuntimeStatusInfo;
	sessionProgress?: HyperchartRuntimeSessionProgressFile;
	cwd?: string;
	createdAt?: number;
	updatedAt?: number;
	description?: string;
	now?: number;
};

export function hyperchartRunFromRuntime(
	inspect: HyperchartInspectResult,
	ast: ChartAst,
	records: readonly DurableLogRecord[],
	options: HyperchartRunFromRuntimeOptions = {},
): HyperchartRunInfo {
	const skipped: ProjectionSkippedRecord[] = [];
	const projection = projectBranch(createBranchProjection(ast), ast, records, [], skipped);
	const staticRun = hyperchartRunFromInspectResult(inspect, {
		runId: options.runId ?? options.status?.runId ?? `run:${ast.id}`,
		status: runtimeRunStatus(options.status?.state),
		cwd: options.cwd ?? "",
		createdAt: options.createdAt ?? options.status?.startedAt ?? firstTimestamp(records) ?? options.now ?? Date.now(),
		updatedAt: options.updatedAt ?? options.status?.updatedAt ?? lastTimestamp(records) ?? options.now ?? Date.now(),
		args: projection.args === undefined ? {} : { ...projection.args },
		...(options.description === undefined ? {} : { description: options.description }),
	});
	const runtime = runtimeFacts(ast, records, projection, skipped, options.sessionProgress);
	const staticStates = staticRun.states.map((state) => overlayRuntimeState(state, ast, projection, runtime));
	const states = markStaleRuntimeStates([
		...staticStates,
		...materializedMapStates(staticRun.states, ast, projection, runtime),
	]);
	const issues = runIssues(options.status);
	return {
		...staticRun,
		mode: "run",
		status: runtimeRunStatus(options.status?.state, states),
		...(options.status?.pid === undefined ? {} : { pid: options.status.pid }),
		detached: options.status?.state === "stopped",
		states,
		stateCount: states.length,
		...(issues.length === 0 ? {} : { issues }),
	};
}

function stateFromInspectState(state: HyperchartInspectState): HyperchartStateInfo {
	const refs = refsInfo(state.refs);
	const inputs = state.inputs?.map(
		(input): HyperchartInputInfo => ({
			name: input.name,
			required: input.required,
			defaulted: !input.required,
			schema: { schema: input.schema },
			...(input.defaultValue === undefined ? {} : { preview: JSON.stringify(input.defaultValue) }),
		}),
	);
	return {
		id: state.id,
		status: state.kind === "final" ? "done" : "pending",
		type: inspectStateKindToStateType(state.kind),
		...(state.definitionSource === undefined ? {} : { definitionSource: state.definitionSource }),
		...(state.kind === "final" ? { final: true } : {}),
		...(state.agent === undefined ? {} : { agent: state.agent }),
		...(state.model === undefined ? {} : { model: state.model }),
		...(state.thinking === undefined ? {} : { thinking: state.thinking }),
		...(state.tools === undefined ? {} : { tools: [...state.tools] }),
		...(state.agentDefinitionUnavailable === true ? { agentDefinitionUnavailable: true } : {}),
		...(state.task === undefined ? {} : { taskPreview: previewText(state.task), taskPrompt: state.task }),
		...(state.command === undefined ? {} : { commandPreview: state.command }),
		...(state.env === undefined
			? {}
			: {
					env: state.env.map((env) => ({
						name: env.name,
						type: env.type,
						...(env.value === undefined ? {} : { value: env.value }),
						...(env.schema === undefined ? {} : { schema: { schema: env.schema } }),
					})),
				}),
		...(state.reads === undefined ? {} : { reads: state.reads }),
		...(state.transitions === undefined ? {} : { transitions: state.transitions }),
		...(inputs === undefined ? {} : { inputs }),
		...(refs === undefined ? {} : { refs }),
		...(state.onReenter === undefined
			? {}
			: {
					onReenter:
						state.onReenter.mode === "restart"
							? { mode: "restart" as const }
							: {
									mode: "resume" as const,
									...(state.onReenter.message === undefined
										? {}
										: { messagePreview: previewText(state.onReenter.message) }),
									...(refsInfo(state.onReenter.refs) === undefined ? {} : { refs: refsInfo(state.onReenter.refs) }),
								},
				}),
		...(state.artifacts === undefined
			? {}
			: {
					artifacts: state.artifacts.map((artifact) => ({
						name: artifact.name,
						...(artifact.path === undefined ? {} : { path: artifact.path }),
						...(artifact.shape === undefined ? {} : { schema: { schema: artifact.shape } }),
					})),
				}),
		...(state.reply === undefined ? {} : { replySchema: { schema: state.reply } }),
		...(state.guard === undefined ? {} : { guard: guardInfo(state.guard) }),
		...(state.onReject === undefined ? {} : { onReject: state.onReject }),
		...(state.over === undefined && state.overSchema === undefined
			? {}
			: {
					mapConfig: {
						...(state.over === undefined ? {} : { over: state.over }),
						...(state.overSchema === undefined ? {} : { overSchema: { schema: state.overSchema } }),
					},
				}),
		...(state.concurrency === undefined ? {} : { concurrency: state.concurrency }),
		...(state.regions === undefined && state.branches === undefined
			? {}
			: { parallelConfig: inspectParallelConfig(state) }),
		...(state.retries === undefined ? {} : { retry: { max: state.retries } }),
	} as HyperchartStateInfo;
}

type StateRuntimeFacts = {
	invokedAt?: number;
	completedAt?: number;
	completedEvent?: ChartEvent;
	validatedAt?: number;
	validationAttempts?: number;
	latestRejectedReason?: string;
	attempts?: number;
	visits?: number;
	visitHistory?: HyperchartVisitInfo[];
};

type RuntimeFacts = {
	byState: Map<StatePath, StateRuntimeFacts>;
	pendingByState: Map<StatePath, PendingAction>;
	issuesByState: Map<StatePath, HyperchartIssueInfo[]>;
};

function markStaleRuntimeStates(states: HyperchartStateInfo[]): HyperchartStateInfo[] {
	const byId = new Map(states.map((state) => [state.id, state]));
	const controlEdges = runtimeControlEdges(states);
	const staleIds = new Set<string>();
	for (const source of states) {
		const currentVisit = source.visitHistory?.at(-1);
		if ((source.visitHistory?.length ?? 0) < 2 || currentVisit === undefined) continue;
		const queue = [...(controlEdges.get(source.id) ?? [])];
		const visited = new Set<string>([source.id]);
		while (queue.length > 0) {
			const stateId = queue.shift();
			if (stateId === undefined || visited.has(stateId)) continue;
			visited.add(stateId);
			const candidate = byId.get(stateId);
			if (candidate === undefined) continue;
			const candidateVisit = candidate.visitHistory?.at(-1);
			if (
				candidate.status === "done" &&
				candidateVisit !== undefined &&
				candidateVisit.invokeSeqId < currentVisit.invokeSeqId
			) {
				staleIds.add(candidate.id);
			}
			for (const target of controlEdges.get(candidate.id) ?? []) queue.push(target);
		}
	}
	let addedContainer = true;
	while (addedContainer) {
		addedContainer = false;
		for (const state of states) {
			if (state.status !== "done" || staleIds.has(state.id)) continue;
			if (state.type !== "map" && state.type !== "parallel" && state.type !== "compound" && state.type !== "region")
				continue;
			if ([...staleIds].some((stateId) => stateId.startsWith(`${state.id}.`) || stateId.startsWith(`${state.id}#`))) {
				staleIds.add(state.id);
				addedContainer = true;
			}
		}
	}
	return states.map((state) => {
		const isStale = staleIds.has(state.id);
		const mapItemsWithStale = state.mapConfig?.items?.map((item) => {
			if (
				item.status !== "done" ||
				item.state === undefined ||
				![...staleIds].some((stateId) => stateId === item.state || stateId.startsWith(`${item.state}.`))
			)
				return item;
			return { ...item, status: "stale" as const };
		});
		const staleFanoutCount =
			state.type === "map"
				? (mapItemsWithStale?.filter((item) => item.status === "stale").length ?? 0)
				: state.type === "parallel"
					? (state.parallelConfig?.branches?.filter((branch) => {
							if (branch.id === undefined) return false;
							const branchStates = states.filter(
								(candidate) => candidate.id === branch.id || candidate.id.startsWith(`${branch.id}.`),
							);
							const hasCurrentWork = branchStates.some(
								(candidate) => candidate.status === "running" || candidate.status === "failed",
							);
							return !hasCurrentWork && branchStates.some((candidate) => staleIds.has(candidate.id));
						}).length ?? 0)
					: 0;
		const subProgress =
			state.subProgress === undefined || staleFanoutCount === 0
				? state.subProgress
				: {
						...state.subProgress,
						done: Math.max(0, state.subProgress.done - staleFanoutCount),
						stale: staleFanoutCount,
					};
		return {
			...state,
			...(isStale ? { status: "stale" as const } : {}),
			...(mapItemsWithStale === undefined ? {} : { mapConfig: { ...state.mapConfig, items: mapItemsWithStale } }),
			...(subProgress === undefined ? {} : { subProgress }),
			...(isStale && state.transitions !== undefined
				? {
						transitions: state.transitions.map(({ taken: _taken, ...transition }) => transition),
					}
				: {}),
		};
	});
}

function runtimeControlEdges(states: readonly HyperchartStateInfo[]): Map<string, Set<string>> {
	const edges = new Map<string, Set<string>>();
	const add = (source: string, target: string) => {
		if (source === target) return;
		const targets = edges.get(source) ?? new Set<string>();
		targets.add(target);
		edges.set(source, targets);
	};
	const containers = states.filter(
		(state) =>
			state.type === "compound" || state.type === "region" || state.type === "parallel" || state.type === "map",
	);
	for (const state of states) {
		for (const transition of state.transitions ?? []) add(state.id, transition.target);
		if (state.type === "final") {
			for (const container of containers) {
				if (!isRuntimeDescendant(state.id, container.id)) continue;
				for (const transition of container.transitions ?? []) add(state.id, transition.target);
			}
		}
	}
	for (const container of containers) {
		for (const candidate of states) {
			if (isRuntimeDescendant(candidate.id, container.id)) add(container.id, candidate.id);
		}
	}
	return edges;
}

function isRuntimeDescendant(stateId: string, scopeId: string): boolean {
	return stateId.startsWith(`${scopeId}.`) || stateId.startsWith(`${scopeId}#`);
}

function runtimeRunStatus(value: string | undefined, states: readonly HyperchartStateInfo[] = []): HyperchartRunStatus {
	if (value === "complete") return "completed";
	if (value === "failed") return "failed";
	if (value === "stopped" || value === "stopping") return "paused";
	if (value === "running" || value === "starting") return "running";
	if (states.some((state) => state.status === "failed")) return "failed";
	if (states.some((state) => state.status === "running")) return "running";
	if (states.length > 0 && states.every((state) => state.status === "done" || state.status === "skipped"))
		return "completed";
	return "paused";
}

function firstTimestamp(records: readonly DurableLogRecord[]): number | undefined {
	return records.find((record) => typeof record.timestamp === "number")?.timestamp;
}

function lastTimestamp(records: readonly DurableLogRecord[]): number | undefined {
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index];
		if (record !== undefined && typeof record.timestamp === "number") return record.timestamp;
	}
	return undefined;
}

function runtimeFacts(
	ast: ChartAst,
	records: readonly DurableLogRecord[],
	projection: ReturnType<typeof createBranchProjection>,
	skipped: readonly ProjectionSkippedRecord[],
	sessionProgress: HyperchartRuntimeSessionProgressFile | undefined,
): RuntimeFacts {
	const byState = new Map<StatePath, StateRuntimeFacts>();
	const pendingByState = new Map<StatePath, PendingAction>();
	const issuesByState = new Map<StatePath, HyperchartIssueInfo[]>();
	const skippedRecords = new Set(skipped.map((entry) => entry.record));
	for (const pending of projection.pendingActions) pendingByState.set(pending.actionUid.state, pending);
	for (const record of records) {
		if (record.type !== "state_action" || skippedRecords.has(record)) continue;
		const stateId = record.actionUid.state;
		const facts = byState.get(stateId) ?? {};
		if (record.kind === "invoke") {
			facts.invokedAt = record.timestamp;
			facts.attempts = (facts.attempts ?? 0) + 1;
			delete facts.completedAt;
			delete facts.completedEvent;
			delete facts.validatedAt;
			delete facts.validationAttempts;
			delete facts.latestRejectedReason;
		}
		if (record.kind === "complete") {
			const state = nodeAt(ast, stateId);
			const requiresValidation =
				state?.kind === "state" && state.validate !== undefined && record.event.type !== "FAILED";
			if (!requiresValidation) {
				facts.completedAt = record.timestamp;
				facts.completedEvent = record.event;
			}
			if (record.event.type === "FAILED") {
				appendIssue(issuesByState, stateId, failedActionIssue(stateId, record.event, record.seqId, record.timestamp));
			}
		}
		if (record.kind === "validated") {
			facts.validatedAt = record.timestamp;
			facts.validationAttempts = (facts.validationAttempts ?? 0) + 1;
			const rejectionReason = validationRejectionReason(record.outcome);
			if (rejectionReason === undefined) {
				facts.completedAt = record.timestamp;
				facts.completedEvent = record.event;
			} else {
				facts.latestRejectedReason = rejectionReason;
				appendIssue(issuesByState, stateId, {
					severity: "warning",
					kind: "validation_rejected",
					message: rejectionReason,
					source: "durable_log",
					stateId,
					seqId: record.seqId,
					timestamp: record.timestamp,
					payload: record.outcome,
				});
				const state = nodeAt(ast, stateId);
				const retries = state?.kind === "state" ? state.retries : undefined;
				if (retries !== undefined && facts.validationAttempts > retries) {
					facts.completedAt = record.timestamp;
					facts.completedEvent = { type: "FAILED", error: rejectionReason };
				}
			}
		}
		byState.set(stateId, facts);
	}
	for (const [path, state] of Object.entries(ast.states)) {
		if (state.kind !== "state") continue;
		const key = actionUidKey({ ...state.action.uid, state: path });
		const visits = projection.stateVisits[key];
		if (visits === undefined) continue;
		const facts = byState.get(path) ?? {};
		facts.visits = visits;
		byState.set(path, facts);
	}
	for (const [stateId, visitHistory] of runtimeVisitHistories(ast, records, skippedRecords)) {
		const facts = byState.get(stateId) ?? {};
		facts.visitHistory = visitHistory;
		facts.visits = visitHistory.length;
		byState.set(stateId, facts);
	}
	appendSessionIssues(issuesByState, sessionProgress);
	return { byState, pendingByState, issuesByState };
}

function runtimeVisitHistories(
	ast: ChartAst,
	records: readonly DurableLogRecord[],
	skippedRecords: ReadonlySet<DurableLogRecord>,
): Map<StatePath, HyperchartVisitInfo[]> {
	const histories = new Map<StatePath, HyperchartVisitInfo[]>();
	const replay = createBranchProjection(ast);
	for (const record of records) {
		const pendingBefore = [...replay.pendingActions];
		projectBranch(replay, ast, [record]);
		closeExitedVisits(histories, pendingBefore, replay.pendingActions, record);
		if (record.type !== "state_action" || skippedRecords.has(record)) continue;
		const stateId = record.actionUid.state;
		if (record.kind === "invoke") {
			const pending = replay.pendingActions.find(
				(candidate): candidate is Extract<PendingAction, { phase: "running" }> =>
					candidate.phase === "running" &&
					candidate.invokeSeqId === record.seqId &&
					actionUidKey(candidate.actionUid) === actionUidKey(record.actionUid),
			);
			if (pending === undefined) continue;
			const inputs = replay.inputs[stateId];
			const instance = nearestInstance(stateId);
			const mapValue = instance === undefined ? undefined : replay.spawns[instance.container]?.[instance.key];
			const visit: HyperchartVisitInfo = {
				visit: pending.visitId,
				invokeSeqId: record.seqId,
				startedAt: record.timestamp,
				status: "running",
				...(inputs === undefined || Object.keys(inputs).length === 0 ? {} : { inputs: { ...inputs } }),
				...(instance === undefined
					? {}
					: {
							mapItem: {
								key: instance.key,
								...(mapValue === undefined ? {} : { value: mapValue }),
							},
						}),
				invocation: visitInvocationInfo(renderPendingActionInvocation(ast, replay, pending)),
			};
			histories.set(stateId, [...(histories.get(stateId) ?? []), visit]);
			continue;
		}
		const visit = histories.get(stateId)?.at(-1);
		if (visit === undefined) continue;
		if (record.kind === "complete") {
			const state = nodeAt(ast, stateId);
			const requiresValidation =
				state?.kind === "state" && state.validate !== undefined && record.event.type !== "FAILED";
			if (!requiresValidation) completeVisit(visit, record.event, record.timestamp);
			continue;
		}
		if (record.kind === "validated") {
			visit.validationAttempts = (visit.validationAttempts ?? 0) + 1;
			const rejectionReason = validationRejectionReason(record.outcome);
			if (rejectionReason === undefined) {
				completeVisit(visit, record.event, record.timestamp);
				continue;
			}
			const state = nodeAt(ast, stateId);
			const retries = state?.kind === "state" ? state.retries : undefined;
			if (retries !== undefined && visit.validationAttempts > retries) {
				visit.status = "failed";
				visit.completedEvent = "FAILED";
				visit.endedAt = record.timestamp;
				delete visit.endedReason;
			}
		}
	}
	return histories;
}

function closeExitedVisits(
	histories: Map<StatePath, HyperchartVisitInfo[]>,
	before: readonly PendingAction[],
	after: readonly PendingAction[],
	record: DurableLogRecord,
): void {
	const remaining = new Set(after.map(pendingVisitKey));
	for (const pending of before) {
		if (remaining.has(pendingVisitKey(pending))) continue;
		const visit = histories.get(pending.actionUid.state)?.find((entry) => entry.visit === pending.visitId);
		if (visit === undefined || visit.status !== "running") continue;
		const timedOut =
			record.type === "state_action" &&
			record.kind === "timer_fired" &&
			actionUidKey(record.actionUid) === actionUidKey(pending.actionUid);
		visit.status = "cancelled";
		visit.endedAt = record.timestamp;
		visit.endedReason = timedOut ? "timed_out" : "scope_exit";
	}
}

function pendingVisitKey(pending: PendingAction): string {
	return `${actionUidKey(pending.actionUid)}:${pending.visitId}`;
}

function completeVisit(visit: HyperchartVisitInfo, event: ChartEvent, timestamp: number): void {
	visit.status = event.type === "FAILED" ? "failed" : "done";
	visit.completedEvent = event.type;
	visit.endedAt = timestamp;
	delete visit.endedReason;
}

function visitInvocationInfo(effect: ActionEffect): HyperchartVisitInvocationInfo {
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
		case "user":
			return { kind: "user", prompt: effect.prompt };
	}
}

function renderedArtifactInfo(artifact: RenderedArtifact): HyperchartRenderedArtifactInfo {
	return {
		...(artifact.name === undefined ? {} : { name: artifact.name }),
		path: artifact.path,
		...(artifact.select === undefined ? {} : { select: artifact.select }),
	};
}

function runIssues(status: RuntimeStatusInfo | undefined): HyperchartIssueInfo[] {
	const issues: HyperchartIssueInfo[] = [];
	if (status?.error !== undefined || (status?.exitCode !== undefined && status.exitCode !== 0)) {
		issues.push({
			severity: "error",
			kind: "run_failed",
			message: status.error ?? `Run exited with code ${status.exitCode}`,
			source: "status",
			...(status.updatedAt === undefined ? {} : { timestamp: status.updatedAt }),
			...(status.exitCode === undefined ? {} : { payload: { exitCode: status.exitCode } }),
		});
	}
	const updatedAt = status?.updatedAt;
	for (const warning of status?.replayWarnings ?? []) {
		issues.push({
			severity: "warning",
			kind: "replay_warning",
			message: warning,
			source: "status",
			...(updatedAt === undefined ? {} : { timestamp: updatedAt }),
		});
	}
	return issues;
}

function appendIssue(map: Map<StatePath, HyperchartIssueInfo[]>, stateId: StatePath, issue: HyperchartIssueInfo): void {
	map.set(stateId, [...(map.get(stateId) ?? []), issue]);
}

function failedActionIssue(
	stateId: StatePath,
	event: ChartEvent,
	seqId: number,
	timestamp: number,
): HyperchartIssueInfo {
	const error = "error" in event ? event.error : undefined;
	return {
		severity: "error",
		kind: "action_failed",
		message: issueMessageFromPayload(error, "Action failed"),
		source: "durable_log",
		stateId,
		seqId,
		timestamp,
		...(error === undefined ? {} : { payload: error }),
	};
}

function validationRejectionReason(outcome: unknown): string | undefined {
	if (outcome === true) return undefined;
	if (typeof outcome === "object" && outcome !== null && typeof (outcome as { reason?: unknown }).reason === "string")
		return (outcome as { reason: string }).reason;
	if (outcome === false) return "Validation rejected the completion.";
	return undefined;
}

function appendSessionIssues(
	map: Map<StatePath, HyperchartIssueInfo[]>,
	progress: HyperchartRuntimeSessionProgressFile | undefined,
): void {
	if (progress === undefined) return;
	for (const session of Object.values(progress.sessions)) {
		if (session.error === undefined && session.status !== "failed") continue;
		const stateId = session.actionUid.state;
		const timestamp = session.completedAt ?? session.lastActivityAt ?? session.startedAt;
		appendIssue(map, stateId, {
			severity: "error",
			kind: "session_failed",
			message: session.error ?? "Agent session failed.",
			source: "session_progress",
			stateId,
			...(timestamp === undefined ? {} : { timestamp }),
			payload: compactSessionPayload(session),
		});
	}
}

function compactSessionPayload(session: HyperchartRuntimeSessionProgressInfo): Record<string, unknown> {
	return {
		status: session.status,
		...(session.actionName === undefined ? {} : { actionName: session.actionName }),
		...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
		...(session.model === undefined ? {} : { model: session.model }),
		...(session.turnCount === undefined ? {} : { turnCount: session.turnCount }),
		...(session.toolCount === undefined ? {} : { toolCount: session.toolCount }),
		...(session.tokenCount === undefined ? {} : { tokenCount: session.tokenCount }),
		...(session.error === undefined ? {} : { error: session.error }),
	};
}

function issueMessageFromPayload(payload: unknown, fallback: string): string {
	if (payload === undefined || payload === null) return fallback;
	if (typeof payload === "string") return payload;
	if (typeof payload === "object") {
		const record = payload as Record<string, unknown>;
		if (typeof record.message === "string") return record.message;
		if (typeof record.stderr === "string" && record.stderr.trim().length > 0) {
			const prefix = typeof record.code === "number" ? `Script exited with code ${record.code}` : "Script failed";
			return `${prefix}: ${oneLine(record.stderr)}`;
		}
		const details = [
			typeof record.code === "number" ? `code ${record.code}` : undefined,
			typeof record.signal === "string" ? record.signal : undefined,
		]
			.filter(Boolean)
			.join(" · ");
		if (details.length > 0) return `Action failed (${details})`;
	}
	try {
		return previewText(JSON.stringify(payload)) ?? fallback;
	} catch {
		return String(payload);
	}
}

function oneLine(value: string): string {
	return (
		previewText(
			value
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean)
				.at(-1) ?? value.trim(),
		) ?? ""
	);
}

function materializedMapStates(
	staticStates: readonly HyperchartStateInfo[],
	ast: ChartAst,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
): HyperchartStateInfo[] {
	const expanded: HyperchartStateInfo[] = [];
	const mapTemplates = staticStates.filter((state) => state.type === "map");
	for (const [concreteMapPath, instances] of Object.entries(projection.spawns)) {
		const templateMapPath = templatePath(concreteMapPath);
		const mapState = mapTemplates.find((state) => state.id === templateMapPath);
		if (mapState === undefined) continue;
		const descendants = staticStates.filter(
			(candidate) =>
				candidate.id.startsWith(`${templateMapPath}.`) &&
				!mapTemplates.some(
					(nestedMap) =>
						nestedMap.id !== templateMapPath &&
						nestedMap.id.startsWith(`${templateMapPath}.`) &&
						candidate.id.startsWith(`${nestedMap.id}.`),
				),
		);
		for (const key of Object.keys(instances)) {
			for (const descendant of descendants) {
				const clone = materializeMapState(descendant, templateMapPath, concreteMapPath, key);
				expanded.push(overlayRuntimeState(clone, ast, projection, runtime));
			}
		}
	}
	return expanded;
}

function materializeMapState(
	state: HyperchartStateInfo,
	templateMapPath: StatePath,
	concreteMapPath: StatePath,
	key: string,
): HyperchartStateInfo {
	return {
		...state,
		id: materializeMapPath(state.id, templateMapPath, concreteMapPath, key),
		...(state.transitions === undefined
			? {}
			: {
					transitions: state.transitions.map((transition) => ({
						...transition,
						target: materializeMapPath(transition.target, templateMapPath, concreteMapPath, key),
					})),
				}),
		...(state.parallelConfig?.branches === undefined
			? {}
			: {
					parallelConfig: {
						...state.parallelConfig,
						branches: state.parallelConfig.branches.map((branch) => ({
							...branch,
							...(branch.id === undefined
								? {}
								: { id: materializeMapPath(branch.id, templateMapPath, concreteMapPath, key) }),
						})),
					},
				}),
	};
}

function materializeMapPath(
	path: StatePath,
	templateMapPath: StatePath,
	concreteMapPath: StatePath,
	key: string,
): StatePath {
	const instanceRoot = `${concreteMapPath}#${key}`;
	if (path === templateMapPath) return instanceRoot;
	if (path.startsWith(`${templateMapPath}.`)) return `${instanceRoot}${path.slice(templateMapPath.length)}`;
	return instancePathFor(path, concreteMapPath);
}

function runtimeValidationAttempts(
	facts: StateRuntimeFacts | undefined,
	pending: PendingAction | undefined,
): number | undefined {
	if (facts?.validationAttempts !== undefined) return facts.validationAttempts;
	return pending?.phase === "validating" || pending?.phase === "rejected" ? pending.validationAttempts : undefined;
}

function pendingRejectedReason(pending: PendingAction | undefined): string | undefined {
	return pending?.phase === "rejected" ? pending.reason : undefined;
}

function runtimeMapItemInfo(
	stateId: StatePath,
	projection: ReturnType<typeof createBranchProjection>,
): Pick<HyperchartStateInfo, "mapKey" | "mapItemLabel"> | undefined {
	const instance = nearestInstance(stateId);
	if (instance === undefined) return undefined;
	const value = projection.spawns[instance.container]?.[instance.key];
	return {
		mapKey: instance.key,
		mapItemLabel: mapItemLabel(instance.key, value),
	};
}

function overlayRuntimeState(
	state: HyperchartStateInfo,
	ast: ChartAst,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
): HyperchartStateInfo {
	const facts = runtime.byState.get(state.id);
	const pending = runtime.pendingByState.get(state.id);
	const validationAttempts = runtimeValidationAttempts(facts, pending);
	const mapItem = runtimeMapItemInfo(state.id, projection);
	const issues = runtime.issuesByState.get(state.id);
	const latestRejectedReason = facts?.latestRejectedReason ?? pendingRejectedReason(pending);
	const acceptedCompletion = pending === undefined ? facts?.completedEvent : undefined;
	const acceptedCompletionAt = pending === undefined ? facts?.completedAt : undefined;
	const next: HyperchartStateInfo = {
		...state,
		status: runtimeStateStatus(state, ast, projection, runtime),
		...(facts?.invokedAt === undefined ? {} : { startedAt: facts.invokedAt }),
		...(acceptedCompletionAt === undefined ? {} : { endedAt: acceptedCompletionAt }),
		...(acceptedCompletion === undefined ? {} : { completedEvent: acceptedCompletion.type }),
		...(facts?.attempts === undefined ? {} : { attempts: facts.attempts }),
		...(validationAttempts === undefined ? {} : { validationAttempts }),
		...(latestRejectedReason === undefined ? {} : { validation: { latestRejectedReason } }),
		...(facts?.visits === undefined ? {} : { visits: facts.visits }),
		...(facts?.visitHistory === undefined ? {} : { visitHistory: facts.visitHistory }),
		...(issues === undefined || issues.length === 0 ? {} : { issues }),
		...(mapItem === undefined ? {} : mapItem),
	};
	if (next.transitions?.length && next.completedEvent !== undefined) {
		next.transitions = next.transitions.map((transition) => ({
			...transition,
			...(transition.event === next.completedEvent ? { taken: true } : {}),
		}));
	}
	if (state.type === "map") return overlayMapRuntime(next, ast, projection, runtime);
	if (state.type === "parallel") return overlayParallelRuntime(next, ast, projection, runtime);
	return next;
}

function runtimeStateStatus(
	state: HyperchartStateInfo,
	ast: ChartAst,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
): HyperchartStateStatus {
	const facts = runtime.byState.get(state.id);
	const pending = runtime.pendingByState.get(state.id);
	if (pending !== undefined) return "running";
	if (facts?.completedEvent?.type === "FAILED") return "failed";
	if (state.type === "final") return projection.activeLeaves.includes(state.id) ? "done" : "pending";
	if (projection.activeLeaves.some((leaf) => leaf === state.id || underScope(leaf, state.id))) return "running";
	if (facts?.completedAt !== undefined) return "done";
	if (state.type === "map") {
		const items = mapItems(state, ast, projection, runtime);
		if (items.length > 0 && items.every((item) => item.status === "done")) return "done";
		if (items.some((item) => item.status === "failed")) return "failed";
		if (items.some((item) => item.status === "running")) return "running";
	}
	if (state.type === "parallel") {
		const progress = fanoutProgressForScope(
			state.id,
			ast,
			projection,
			runtime,
			state.parallelConfig?.branches?.map((branch) => branch.id).filter((id): id is string => id !== undefined) ?? [],
		);
		if (progress.failed > 0) return "failed";
		if (progress.running > 0) return "running";
		if (progress.total > 0 && progress.done === progress.total) return "done";
	}
	const node = ast.states[state.id];
	if (
		node !== undefined &&
		(node.kind === "compound" || node.kind === "region") &&
		projection.activeLeaves.some((leaf) => underScope(leaf, state.id))
	)
		return "running";
	return state.status;
}

function overlayMapRuntime(
	state: HyperchartStateInfo,
	ast: ChartAst,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
): HyperchartStateInfo {
	const items = mapItems(state, ast, projection, runtime);
	if (items.length === 0 && projection.spawns[state.id] === undefined) return state;
	const done = items.filter((item) => item.status === "done").length;
	const running = items.filter((item) => item.status === "running").length;
	const failed = items.filter((item) => item.status === "failed").length;
	return {
		...state,
		mapConfig: { ...state.mapConfig, items },
		subProgress: { done, running, failed, total: items.length },
	};
}

function mapItems(
	state: HyperchartStateInfo,
	ast: ChartAst,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
): NonNullable<NonNullable<HyperchartStateInfo["mapConfig"]>["items"]> {
	const instances = projection.spawns[state.id];
	if (instances === undefined) return [];
	return Object.entries(instances).map(([key, value]) => {
		const instancePath = `${state.id}#${key}`;
		const summary = mapItemSummary(value);
		const issueCount = scopeIssueCount(instancePath, runtime);
		return {
			key,
			label: mapItemLabel(key, value),
			...(summary === undefined ? {} : { summary }),
			status: mapItemStatus(instancePath, projection, runtime, ast),
			state: instancePath,
			value,
			...(issueCount === 0 ? {} : { issueCount }),
		};
	});
}

function mapItemLabel(key: string, value: unknown): string {
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		if (typeof record.title === "string") return record.title;
		if (typeof record.label === "string") return record.label;
	}
	return key;
}

function mapItemSummary(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	return typeof record.summary === "string" ? record.summary : undefined;
}

function mapItemStatus(
	instancePath: StatePath,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
	ast: ChartAst | undefined,
): HyperchartStateStatus {
	const childFacts = [...runtime.byState.entries()].filter(([path]) => underScope(path, instancePath));
	if (childFacts.some(([, facts]) => facts.completedEvent?.type === "FAILED")) return "failed";
	const activeLeaves = projection.activeLeaves.filter((leaf) => underScope(leaf, instancePath));
	if (activeLeaves.length > 0)
		return ast !== undefined && activeLeaves.every((leaf) => nodeAt(ast, leaf)?.kind === "final") ? "done" : "running";
	if (childFacts.some(([, facts]) => facts.completedAt !== undefined)) return "done";
	return "pending";
}

function overlayParallelRuntime(
	state: HyperchartStateInfo,
	ast: ChartAst,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
): HyperchartStateInfo {
	const branches = state.parallelConfig?.branches ?? [];
	const branchIds = branches.map((branch) => branch.id).filter((id): id is string => id !== undefined);
	const progress = fanoutProgressForScope(state.id, ast, projection, runtime, branchIds);
	const count = progress.total || state.parallelConfig?.count;
	const branchesWithIssues = branches.map((branch) => {
		const issueCount = branch.id === undefined ? 0 : scopeIssueCount(branch.id, runtime);
		return { ...branch, ...(issueCount === 0 ? {} : { issueCount }) };
	});
	return {
		...state,
		parallelConfig: {
			...state.parallelConfig,
			...(count === undefined ? {} : { count }),
			branches: branchesWithIssues,
		},
		...(progress.total > 0 ? { subProgress: progress } : {}),
	};
}

function fanoutProgressForScope(
	scope: StatePath,
	ast: ChartAst | undefined,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
	childScopes: readonly StatePath[],
): NonNullable<HyperchartStateInfo["subProgress"]> {
	const scopes =
		childScopes.length > 0
			? childScopes
			: [
					...new Set(
						projection.activeLeaves
							.filter((leaf) => underScope(leaf, scope))
							.map((leaf) => directChildScope(scope, leaf))
							.filter((value): value is string => value !== undefined),
					),
				];
	let done = 0;
	let running = 0;
	let failed = 0;
	for (const childScope of scopes) {
		const status = scopeStatus(childScope, projection, runtime, ast);
		if (status === "done") done++;
		else if (status === "failed") failed++;
		else if (status === "running") running++;
	}
	return { done, running, failed, total: scopes.length };
}

function directChildScope(scope: StatePath, leaf: StatePath): string | undefined {
	if (!underScope(leaf, scope) || leaf === scope) return undefined;
	const rest = leaf.startsWith(`${scope}.`)
		? leaf.slice(scope.length + 1)
		: leaf.startsWith(`${scope}#`)
			? leaf.slice(scope.length + 1)
			: undefined;
	const first = rest?.split(".")[0];
	return first === undefined ? undefined : `${scope}.${first}`;
}

function scopeStatus(
	scope: StatePath,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
	ast: ChartAst | undefined,
): HyperchartStateStatus {
	const facts = [...runtime.byState.entries()].filter(([path]) => underScope(path, scope));
	if (facts.some(([, fact]) => fact.completedEvent?.type === "FAILED")) return "failed";
	const activeLeaves = projection.activeLeaves.filter((leaf) => underScope(leaf, scope));
	if (activeLeaves.length > 0)
		return ast !== undefined && activeLeaves.every((leaf) => nodeAt(ast, leaf)?.kind === "final") ? "done" : "running";
	if (facts.some(([, fact]) => fact.completedAt !== undefined)) return "done";
	return "pending";
}

function scopeIssueCount(scope: StatePath, runtime: RuntimeFacts): number {
	let count = 0;
	for (const [path, issues] of runtime.issuesByState) {
		if (underScope(path, scope)) count += issues.length;
	}
	return count;
}

function inspectParallelConfig(state: HyperchartInspectState): NonNullable<HyperchartStateInfo["parallelConfig"]> {
	const branches =
		state.branches?.map((branch) => ({
			id: branch.id,
			...(branch.agent === undefined ? {} : { agent: branch.agent }),
			...(branch.task === undefined ? {} : { taskPreview: previewText(branch.task) }),
		})) ??
		state.regions?.map((id) => ({ id })) ??
		[];
	return { count: state.regions?.length ?? branches.length, branches };
}

function inspectStateKindToStateType(kind: HyperchartInspectState["kind"]): HyperchartStateInfo["type"] {
	return kind;
}

function guardInfo(guard: NonNullable<HyperchartInspectState["guard"]>): NonNullable<HyperchartStateInfo["guard"]> {
	if (guard.kind === "script") {
		return {
			kind: "script",
			command: guard.command,
			...(guard.args === undefined ? {} : { args: [...guard.args] }),
		};
	}
	return { kind: "tsImport", module: guard.module, export: guard.export };
}

function refsInfo(refs: HyperchartInspectState["refs"]): HyperchartRefInfo | undefined {
	if (!refs || refs.length === 0) return undefined;
	const grouped: HyperchartRefInfo = {};
	for (const ref of refs) {
		appendRef(grouped, ref.kind === "artifactOf" || ref.kind === "joinArtifactOf" ? "artifact" : ref.kind, ref.preview);
	}
	return Object.keys(grouped).length === 0 ? undefined : grouped;
}

function appendRef(grouped: HyperchartRefInfo, kind: keyof HyperchartRefInfo, preview: string): void {
	grouped[kind] = [...new Set([...(grouped[kind] ?? []), preview])];
}

function previewText(text: string | undefined): string | undefined {
	if (!text) return undefined;
	return text.length > 220 ? `${text.slice(0, 219)}…` : text;
}

function isInspectResult(value: unknown): value is HyperchartInspectResult {
	if (!isRecord(value)) return false;
	return typeof value.chartId === "string" && Array.isArray(value.states);
}

function isRunInfo(value: unknown): value is HyperchartRunInfo {
	if (!isRecord(value)) return false;
	return typeof value.runId === "string" && typeof value.chartName === "string" && Array.isArray(value.states);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
