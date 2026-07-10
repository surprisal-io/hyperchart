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
export type HyperchartStateStatus = "pending" | "running" | "done" | "failed" | "skipped";
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
	issueCount?: number;
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
	| { kind: "script"; command: string; args?: string[] }
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

export interface HyperchartStateInfo {
	id: string;
	type?: HyperchartStateType;
	agent?: string;
	definitionSource?: string;
	status: HyperchartStateStatus;
	startedAt?: number;
	endedAt?: number;
	model?: string;
	thinking?: string;
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
	mapConfig?: { over?: string; overSchema?: HyperchartSchemaInfo; as?: string; items?: HyperchartMapItemInfo[] };
	mapKey?: string;
	mapItemLabel?: string;
	parallelConfig?: { branches?: HyperchartBranchInfo[]; count?: number };
	subProgress?: { done: number; total: number; running: number; failed: number };
	retry?: HyperchartRetryInfo;
	attempts?: number;
	validationAttempts?: number;
	validation?: HyperchartValidationInfo;
	visits?: number;
	issues?: HyperchartIssueInfo[];
}

export interface HyperchartRunInfo {
	runId: string;
	chartName: string;
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

