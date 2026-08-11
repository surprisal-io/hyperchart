import type { ChartArgumentAst } from "../core/types.js";

/** Canonical serializable metadata consumed by host launch forms. */
export type HyperchartLaunchArgumentInfo = ChartArgumentAst;

export interface HyperchartInfo {
	name: string;
	description: string;
	scope: "user" | "project";
	source?: string;
	definitionSource?: string;
	/** Launch-form metadata. Runtime argument values live on HyperchartRunInfo.args. */
	args?: Readonly<Record<string, HyperchartLaunchArgumentInfo>>;
	states?: HyperchartStateInfo[];
	stateCount: number;
	updatedAt?: number;
}

export type HyperchartRunStatus = "running" | "completed" | "failed" | "paused" | "blocked";
export type HyperchartStateStatus = "pending" | "waiting" | "running" | "done" | "failed" | "skipped" | "stale";
export type HyperchartStateType =
	| "agent"
	| "user"
	| "script"
	| "send"
	| "sendBatch"
	| "call"
	| "callBatch"
	| "actor-declaration"
	| "actor-occurrence"
	| "receive"
	| "reply"
	| "map"
	| "parallel"
	| "compound"
	| "region"
	| "final";

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

export interface HyperchartActorReplyContractInfo {
	kind: "void" | "single" | "named";
	schema?: HyperchartSchemaInfo;
	schemas?: Record<string, HyperchartSchemaInfo>;
}

export interface HyperchartActorMessageContractInfo {
	event: string;
	input: HyperchartSchemaInfo;
	reply: HyperchartActorReplyContractInfo;
}

export interface HyperchartActorMessageDefinitionInfo {
	kind: "send" | "sendBatch" | "call" | "callBatch" | "receive" | "reply";
	to?: string;
	resolvedTo?: string;
	targetKind?: "actor" | "self";
	event?: string;
	target?: string;
	payload?: {
		label: "input" | "inputs" | "output";
		source: string;
		schema?: HyperchartSchemaInfo;
	};
	contracts?: HyperchartActorMessageContractInfo[];
}

export interface HyperchartActorDeclarationInfo {
	kind: "actor" | "actorPool";
	declarationPath: string;
	ownerPath?: string;
	definitionSource?: string;
	inputSchema: HyperchartSchemaInfo;
	/** Concrete configured placement value/expression; runtime occurrences expose their resolved input separately. */
	inputValue: unknown;
	protocol: HyperchartActorMessageContractInfo[];
	initialReceive: string;
	concurrency?: number;
}

export type HyperchartActorMessageStatus = "queued" | "accepted" | "replied" | "settled" | "failed" | "cancelled";

export interface HyperchartActorMessageInfo {
	messageId: string;
	actorOccurrencePath?: string;
	actorLogicalPath?: string;
	actorGeneration?: number;
	event: string;
	input?: unknown;
	producerVisit: string;
	callId?: string;
	batchIndex?: number;
	status: HyperchartActorMessageStatus;
	receiveState?: string;
	replyState?: string;
	acceptedAt?: number;
	repliedAt?: number;
	replyEvent?: string;
	replyOutput?: unknown;
	workerIndex?: number;
	workerOccurrencePath?: string;
	replySchema?: HyperchartSchemaInfo;
	validation?: "pending" | "valid" | "invalid";
}

export interface HyperchartActorSentMessageInfo {
	messageId: string;
	producerVisit: number;
	batchIndex: number;
	input?: unknown;
	status: HyperchartActorMessageStatus;
	/** Concrete durable actor instance that received this message. */
	targetOccurrencePath: string;
	targetLogicalPath: string;
	targetGeneration: number;
}

export interface HyperchartActorMailboxInfo {
	totalCount: number;
	head?: HyperchartActorMessageInfo;
	entries: HyperchartActorMessageInfo[];
}

export interface HyperchartActorMailboxInstanceInfo {
	occurrencePath: string;
	generation: number;
	status: "idle" | "busy" | "closing" | "draining" | "stopped" | "failed" | "cancelled";
	mailbox: HyperchartActorMailboxInfo;
	messageHistory: HyperchartActorMessageInfo[];
	currentMessage?: HyperchartActorMessageInfo;
}

export interface HyperchartActorInternalGenerationInfo {
	occurrencePath: string;
	logicalPath: string;
	generation: number;
	actorStatus: "idle" | "busy" | "closing" | "draining" | "stopped" | "failed" | "cancelled";
	stateStatus: HyperchartStateStatus;
	visitHistory?: HyperchartVisitInfo[];
	actorMessageHistory?: HyperchartActorMessageInfo[];
	actorMessages?: HyperchartActorSentMessageInfo[];
}

export interface HyperchartActorPoolWorkerInfo {
	index: number;
	occurrencePath: string;
	currentState: string;
	/** Canonical worker-template state used by Inspector navigation. */
	currentStateId: string;
	status: "idle" | "busy" | "draining" | "stopped" | "failed" | "cancelled";
	currentMessage?: HyperchartActorMessageInfo;
	messageHistory?: HyperchartActorMessageInfo[];
	visits?: number;
	visitHistory?: HyperchartVisitInfo[];
	session?: HyperchartAgentSessionInfo;
	results?: ReadonlyArray<{ state: string; value: unknown }>;
}

export interface HyperchartActorBatchCallInfo {
	callId: string;
	callerState: string;
	status: "enqueued" | "accepted" | "partial";
	messageIds: readonly string[];
	items: ReadonlyArray<Pick<HyperchartActorMessageInfo, "messageId" | "batchIndex" | "status" | "workerIndex" | "workerOccurrencePath">>;
	settled: number;
	total: number;
}

export interface HyperchartActorOccurrenceInfo {
	kind: "actor" | "actorPool";
	declarationPath: string;
	ownerPath?: string;
	/** Durable concrete occurrence path for the latest generation. */
	occurrencePath: string;
	/** Stable logical placement path used by Inspector navigation. */
	logicalPath?: string;
	generation: number;
	/** Durable actor generations projected through the standard visit-history model. */
	generationHistory?: HyperchartVisitInfo[];
	input: unknown;
	status: "idle" | "busy" | "closing" | "draining" | "stopped" | "failed" | "cancelled";
	currentState: string;
	concurrency?: number;
	activeCount?: number;
	idleCount?: number;
	workers?: HyperchartActorPoolWorkerInfo[];
	batchCalls?: HyperchartActorBatchCallInfo[];
	mailbox: HyperchartActorMailboxInfo;
	/** Per-generation mailbox and processed-message histories, oldest generation first. */
	mailboxInstances: HyperchartActorMailboxInstanceInfo[];
	/** Settled messages from this logical actor placement across all generations. */
	messageHistory?: HyperchartActorMessageInfo[];
	currentMessage?: HyperchartActorMessageInfo;
	pendingCaller?: { callId: string; state: string; waitReason: "enqueue" | "accept" | "reply" };
	drain?: { queued: number; current: number; settled: number };
}

export interface HyperchartArtifactInfo {
	name: string;
	path?: string;
	schema?: HyperchartSchemaInfo;
	/** Producer state when presented as a referenced read contract. */
	sourceState?: string;
	readKind?: "artifact" | "join";
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
	actorInput?: string[];
	messageInput?: string[];
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
	sourceState?: string;
	readKind?: "artifact" | "join";
	path: string;
	select?: string;
	schema?: HyperchartSchemaInfo;
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
	| { kind: "user"; prompt: string }
	| { kind: "actor" };

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
	/** Agent session associated with this durable visit, when the action is an agent. */
	session?: HyperchartAgentSessionInfo;
}

export interface HyperchartSessionMessageInfo {
	id: string;
	role: "user" | "assistant" | "reasoning" | "tool" | "system";
	text?: string;
	toolName?: string;
	toolCallId?: string;
	toolInput?: string;
	toolOutput?: string;
	toolStatus?: "running" | "completed" | "error";
	isError?: boolean;
	timestamp?: number;
}

export interface HyperchartAgentSessionInfo {
	actionKey: string;
	status: string;
	startedAt?: number;
	lastActivityAt?: number;
	role?: string;
	model?: string;
	thinking?: string;
	toolset?: string;
	tools?: string[];
	turnCount?: number;
	toolCount?: number;
	tokenCount?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentText?: string;
	currentReasoning?: string;
	lastMessage?: string;
	error?: string;
	messages?: HyperchartSessionMessageInfo[];
}

export interface HyperchartStateInfo {
	id: string;
	/** Inspector-only lexical hierarchy. Unlike id parsing, this also supports synthetic occurrence nodes. */
	scopeParentId?: string;
	/** Durable machine state represented by a synthetic inspector node. */
	runtimeStatePath?: string;
	actorInternal?: {
		declarationPath: string;
		localState: string;
		occurrencePath?: string;
		logicalOccurrencePath?: string;
		generation?: number;
		generations?: HyperchartActorInternalGenerationInfo[];
	};
	type?: HyperchartStateType;
	initial?: boolean;
	agent?: string;
	agentDescription?: string;
	definitionSource?: string;
	status: HyperchartStateStatus;
	startedAt?: number;
	endedAt?: number;
	role?: string;
	model?: string;
	resolvedModel?: string;
	thinking?: string;
	toolset?: string;
	resolvedTools?: string[];
	agentDefinitionUnavailable?: boolean;
	usage?: HyperchartUsageInfo;
	reads?: string[];
	readArtifacts?: HyperchartArtifactInfo[];
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
	subProgress?: { done: number; total: number; running: number; failed: number; waiting?: number; stale?: number };
	retry?: HyperchartRetryInfo;
	attempts?: number;
	validationAttempts?: number;
	validation?: HyperchartValidationInfo;
	visits?: number;
	visitHistory?: HyperchartVisitInfo[];
	issues?: HyperchartIssueInfo[];
	session?: HyperchartAgentSessionInfo;
	actorDeclaration?: HyperchartActorDeclarationInfo;
	actorOccurrence?: HyperchartActorOccurrenceInfo;
	/** Durable messages accepted or replied through this exact actor-internal state. */
	actorMessageHistory?: HyperchartActorMessageInfo[];
	finalConfig?: {
		outcome: "complete" | "failed";
		notify?: { prompt?: string; artifacts?: HyperchartArtifactInfo[]; scope?: string };
	};
	actorMessageDefinition?: HyperchartActorMessageDefinitionInfo;
	actorMessageLink?: {
		kind: "send" | "sendBatch" | "call" | "callBatch" | "reply";
		to: string;
		event?: string;
		self?: true;
		pending?: boolean;
		messages?: HyperchartActorSentMessageInfo[];
	};
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
	/** Definition-owned launch metadata, when declared by the chart. */
	launchArgs?: Readonly<Record<string, HyperchartLaunchArgumentInfo>>;
	/** Concrete values used by this run (empty for static inspection). */
	args: Record<string, unknown>;
	states: HyperchartStateInfo[];
	stateCount: number;
	actorDeclarations?: HyperchartActorDeclarationInfo[];
	actorOccurrences?: HyperchartActorOccurrenceInfo[];
	finalOutput?: string;
	totalUsage?: HyperchartUsageInfo;
	issues?: HyperchartIssueInfo[];
}
