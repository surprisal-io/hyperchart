import type { HyperchartInspectResult, HyperchartInspectState } from "../core/inspect_ast.js";
import type { HyperchartRunInfo, HyperchartStateInfo } from "./models.js";

const PREVIEW_CHARS = 160;

/**
 * Model-facing digests of chart and run inspection results. The full objects
 * carry chart source and JSON schemas and easily exceed a context window; the
 * summaries keep identity, topology, status, and activity, and drop
 * `definitionSource`, schemas, env bindings, and session transcripts.
 */

export type ChartInspectStateSummary = {
	id: string;
	kind: HyperchartInspectState["kind"];
	initial?: boolean;
	agent?: string;
	model?: string;
	thinking?: string;
	tools?: readonly string[];
	agentDefinitionUnavailable?: boolean;
	description?: string;
	task?: string;
	command?: string;
	over?: string;
	concurrency?: number;
	regions?: string[];
	retries?: number;
	onReject?: HyperchartInspectState["onReject"];
	reads?: string[];
	artifacts?: string[];
	transitions?: Record<string, string>;
};

export type ChartInspectSummary = {
	chartId: string;
	chartPath?: string;
	exportName?: string;
	mode: "static";
	stateCount: number;
	unavailableAgents?: string[];
	states: ChartInspectStateSummary[];
};

export function summarizeChartInspect(result: HyperchartInspectResult): ChartInspectSummary {
	const unavailable = [
		...new Set(result.states.filter((state) => state.agentDefinitionUnavailable === true && state.agent !== undefined).map((state) => state.agent as string)),
	];
	return {
		chartId: result.chartId,
		...(result.chartPath === undefined ? {} : { chartPath: result.chartPath }),
		...(result.exportName === undefined ? {} : { exportName: result.exportName }),
		mode: result.mode,
		stateCount: result.states.length,
		...(unavailable.length === 0 ? {} : { unavailableAgents: unavailable }),
		states: result.states.map(summarizeInspectState),
	};
}

function summarizeInspectState(state: HyperchartInspectState): ChartInspectStateSummary {
	return {
		id: state.id,
		kind: state.kind,
		...(state.initial === true ? { initial: true } : {}),
		...(state.agent === undefined ? {} : { agent: state.agent }),
		...(state.model === undefined ? {} : { model: state.model }),
		...(state.thinking === undefined ? {} : { thinking: state.thinking }),
		...(state.tools === undefined ? {} : { tools: state.tools }),
		...(state.agentDefinitionUnavailable === true ? { agentDefinitionUnavailable: true } : {}),
		...(state.description === undefined ? {} : { description: state.description }),
		...(state.task === undefined ? {} : { task: truncate(state.task) }),
		...(state.command === undefined ? {} : { command: truncate(state.command) }),
		...(state.over === undefined ? {} : { over: state.over }),
		...(state.concurrency === undefined ? {} : { concurrency: state.concurrency }),
		...(state.regions === undefined ? {} : { regions: state.regions }),
		...(state.retries === undefined ? {} : { retries: state.retries }),
		...(state.onReject === undefined ? {} : { onReject: state.onReject }),
		...(state.reads === undefined ? {} : { reads: state.reads }),
		...(state.artifacts === undefined
			? {}
			: { artifacts: state.artifacts.flatMap((artifact) => (artifact.path === undefined ? [] : [artifact.path])) }),
		...(state.transitions === undefined
			? {}
			: { transitions: Object.fromEntries(state.transitions.map((transition) => [transition.event, transition.target])) }),
	};
}

export type IssueSummary = {
	severity: string;
	kind: string;
	message: string;
	stateId?: string;
};

export type RunInspectStateSummary = {
	id: string;
	type?: HyperchartStateInfo["type"];
	status: HyperchartStateInfo["status"];
	agent?: string;
	model?: string;
	completedEvent?: string;
	attempts?: number;
	validationAttempts?: number;
	visits?: number;
	mapKey?: string;
	subProgress?: HyperchartStateInfo["subProgress"];
	artifacts?: string[];
	session?: {
		status: string;
		model?: string;
		turnCount?: number;
		toolCount?: number;
		tokenCount?: number;
		lastMessage?: string;
		error?: string;
	};
	issues?: IssueSummary[];
};

export type RunInspectSummary = {
	runId: string;
	chartName: string;
	mode?: HyperchartRunInfo["mode"];
	status: HyperchartRunInfo["status"];
	cwd: string;
	createdAt: number;
	updatedAt: number;
	pid?: number;
	args: Record<string, unknown>;
	stateCount: number;
	finalOutput?: string;
	totalUsage?: HyperchartRunInfo["totalUsage"];
	issues?: IssueSummary[];
	/** States with activity or a non-pending status. */
	states: RunInspectStateSummary[];
	/** Structural states not started yet, listed by id only. */
	pendingStates?: string[];
};

export function summarizeRunInspect(run: HyperchartRunInfo): RunInspectSummary {
	const active: RunInspectStateSummary[] = [];
	const pending: string[] = [];
	for (const state of run.states) {
		if (state.status === "pending" && state.session === undefined && (state.issues?.length ?? 0) === 0) {
			pending.push(state.id);
			continue;
		}
		active.push(summarizeRunState(state));
	}
	return {
		runId: run.runId,
		chartName: run.chartName,
		...(run.mode === undefined ? {} : { mode: run.mode }),
		status: run.status,
		cwd: run.cwd,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		...(run.pid === undefined ? {} : { pid: run.pid }),
		args: truncateValues(run.args),
		stateCount: run.stateCount,
		...(run.finalOutput === undefined ? {} : { finalOutput: truncate(run.finalOutput, 1000) }),
		...(run.totalUsage === undefined ? {} : { totalUsage: run.totalUsage }),
		...(run.issues === undefined || run.issues.length === 0 ? {} : { issues: run.issues.map(summarizeIssue) }),
		states: active,
		...(pending.length === 0 ? {} : { pendingStates: pending }),
	};
}

function summarizeRunState(state: HyperchartStateInfo): RunInspectStateSummary {
	const session = state.session;
	return {
		id: state.id,
		...(state.type === undefined ? {} : { type: state.type }),
		status: state.status,
		...(state.agent === undefined ? {} : { agent: state.agent }),
		...(state.model === undefined ? {} : { model: state.model }),
		...(state.completedEvent === undefined ? {} : { completedEvent: state.completedEvent }),
		...(state.attempts === undefined ? {} : { attempts: state.attempts }),
		...(state.validationAttempts === undefined ? {} : { validationAttempts: state.validationAttempts }),
		...(state.visits === undefined ? {} : { visits: state.visits }),
		...(state.mapKey === undefined ? {} : { mapKey: state.mapKey }),
		...(state.subProgress === undefined ? {} : { subProgress: state.subProgress }),
		...(state.artifacts === undefined ? {} : { artifacts: state.artifacts.flatMap((artifact) => (artifact.path === undefined ? [] : [artifact.path])) }),
		...(session === undefined
			? {}
			: {
					session: {
						status: session.status,
						...(session.model === undefined ? {} : { model: session.model }),
						...(session.turnCount === undefined ? {} : { turnCount: session.turnCount }),
						...(session.toolCount === undefined ? {} : { toolCount: session.toolCount }),
						...(session.tokenCount === undefined ? {} : { tokenCount: session.tokenCount }),
						...(session.lastMessage === undefined ? {} : { lastMessage: truncate(session.lastMessage) }),
						...(session.error === undefined ? {} : { error: truncate(session.error) }),
					},
				}),
		...(state.issues === undefined || state.issues.length === 0 ? {} : { issues: state.issues.map(summarizeIssue) }),
	};
}

function summarizeIssue(issue: { severity: string; kind: string; message: string; stateId?: string }): IssueSummary {
	return {
		severity: issue.severity,
		kind: issue.kind,
		message: issue.message,
		...(issue.stateId === undefined ? {} : { stateId: issue.stateId }),
	};
}

function truncate(value: string, max = PREVIEW_CHARS): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function truncateValues(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(record).map(([key, value]) => [key, typeof value === "string" ? truncate(value, 400) : value]),
	);
}
