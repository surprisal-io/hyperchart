export interface HyperchartInfo {
	name: string;
	description: string;
	scope: "user" | "project";
	source?: string;
	definitionSource?: string;
	args?: Record<string, unknown>;
	states?: HyperchartStateInfo[];
	stateCount: number;
	updatedAt?: number;
}

export type HyperchartRunStatus = "running" | "completed" | "failed" | "paused" | "blocked";
export type HyperchartStateStatus = "pending" | "running" | "done" | "failed" | "skipped" | "stale";
export type HyperchartStateType = "agent" | "user" | "script" | "map" | "parallel" | "compound" | "region" | "final";

export interface HyperchartUsageInfo {
	input?: number;
	output?: number;
	total?: number;
	cost?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface HyperchartRetryInfo {
	max?: number;
	backoffMs?: number;
	factor?: number;
}

export interface HyperchartTransitionInfo {
	event: string;
	target: string;
	input?: Record<string, string>;
	taken?: boolean;
}

export type HyperchartIssueSeverity = "error" | "warning" | "info";
export type HyperchartIssueKind =
	| "run_failed"
	| "replay_warning"
	| "action_failed"
	| "validation_rejected"
	| "session_failed";
export type HyperchartIssueSource = "status" | "durable_log" | "session_progress";

export interface HyperchartIssueInfo {
	severity: HyperchartIssueSeverity;
	kind: HyperchartIssueKind;
	message: string;
	source: HyperchartIssueSource;
	stateId?: string;
	seqId?: number;
	timestamp?: number;
	payload?: unknown;
}

export interface HyperchartBranchInfo {
	id?: string;
	taskPreview?: string;
	agent?: string;
	issueCount?: number;
}

export interface HyperchartMapItemInfo {
	key: string;
	label: string;
	summary?: string;
	status?: HyperchartStateStatus;
	state?: string;
	value?: unknown;
	visits?: number[];
	issueCount?: number;
}

export interface HyperchartMapVisitInfo {
	visit: number;
	spawnSeqId: number;
	startedAt: number;
	instances: Record<string, unknown>;
}

export interface HyperchartSchemaInfo {
	schemaName?: string;
	schema?: Record<string, unknown>;
}

export interface HyperchartArtifactInfo {
	name: string;
	path?: string;
	schema?: HyperchartSchemaInfo;
}

export interface HyperchartEnvInfo {
	name: string;
	type: string;
	value?: string;
	schema?: HyperchartSchemaInfo;
}

export type HyperchartGuardInfo =
	| {
			kind: "script";
			command: string;
			args?: string[];
			env?: HyperchartEnvInfo[];
			artifacts?: HyperchartArtifactInfo[];
			reply?: HyperchartSchemaInfo;
	  }
	| { kind: "tsImport"; module: string; export: string };

export interface HyperchartInputInfo {
	name: string;
	schema?: HyperchartSchemaInfo;
	required?: boolean;
	defaulted?: boolean;
	preview?: string;
}

export interface HyperchartRefInfo {
	arg?: string[];
	result?: string[];
	artifact?: string[];
	input?: string[];
	event?: string[];
	visit?: string[];
	key?: string[];
	item?: string[];
}

export interface HyperchartOnReenterInfo {
	mode: "restart" | "resume";
	messagePreview?: string;
	refs?: HyperchartRefInfo;
}

export type HyperchartInspectMode = "static" | "run";

export interface HyperchartValidationInfo {
	latestRejectedReason?: string;
}

export interface HyperchartRenderedArtifactInfo {
	name?: string;
	path: string;
	select?: string;
}

export type HyperchartVisitInvocationInfo =
	| {
			kind: "agent";
			task?: string;
			resumeMessage?: string;
			reads?: HyperchartRenderedArtifactInfo[];
			artifacts?: HyperchartRenderedArtifactInfo[];
	  }
	| {
			kind: "script";
			command: string;
			args: string[];
			env?: Record<string, unknown>;
			artifacts?: HyperchartRenderedArtifactInfo[];
	  }
	| { kind: "user"; prompt: string };

export interface HyperchartVisitInfo {
	visit: number;
	invokeSeqId: number;
	startedAt: number;
	endedAt?: number;
	status: "running" | "done" | "failed" | "cancelled";
	completedEvent?: string;
	endedReason?: "timed_out" | "scope_exit";
	validationAttempts?: number;
	inputs?: Record<string, unknown>;
	mapItem?: { key: string; value?: unknown };
	invocation: HyperchartVisitInvocationInfo;
}

export interface HyperchartStateInfo {
	id: string;
	type?: HyperchartStateType;
	initial?: boolean;
	agent?: string;
	agentDescription?: string;
	definitionSource?: string;
	status: HyperchartStateStatus;
	startedAt?: number;
	endedAt?: number;
	model?: string;
	thinking?: string;
	agentDefinitionUnavailable?: boolean;
	usage?: HyperchartUsageInfo;
	reads?: string[];
	completedEvent?: string;
	transitions?: HyperchartTransitionInfo[];
	inputs?: HyperchartInputInfo[];
	onReenter?: HyperchartOnReenterInfo;
	refs?: HyperchartRefInfo;
	join?: "all" | "any";
	final?: boolean;
	taskPreview?: string;
	taskPrompt?: string;
	commandPreview?: string;
	artifacts?: HyperchartArtifactInfo[];
	replySchema?: HyperchartSchemaInfo;
	env?: HyperchartEnvInfo[];
	guard?: HyperchartGuardInfo;
	onReject?: "resume" | "restart";
	tools?: string[];
	concurrency?: number;
	mapConfig?: {
		over?: string;
		overSchema?: HyperchartSchemaInfo;
		as?: string;
		items?: HyperchartMapItemInfo[];
		visitHistory?: HyperchartMapVisitInfo[];
	};
	mapKey?: string;
	mapItemLabel?: string;
	parallelConfig?: { branches?: HyperchartBranchInfo[]; count?: number };
	subProgress?: { done: number; total: number; running: number; failed: number; stale?: number };
	retry?: HyperchartRetryInfo;
	attempts?: number;
	validationAttempts?: number;
	validation?: HyperchartValidationInfo;
	visits?: number;
	visitHistory?: HyperchartVisitInfo[];
	issues?: HyperchartIssueInfo[];
}

export interface HyperchartRunInfo {
	runId: string;
	chartName: string;
	originSessionId?: string;
	mode?: HyperchartInspectMode;
	definitionSource?: string;
	description?: string;
	status: HyperchartRunStatus;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	pid?: number;
	detached?: boolean;
	args: Record<string, unknown>;
	states: HyperchartStateInfo[];
	stateCount: number;
	finalOutput?: string;
	totalUsage?: HyperchartUsageInfo;
	issues?: HyperchartIssueInfo[];
}
