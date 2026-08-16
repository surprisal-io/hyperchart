import type {
	ActionUID,
	ActorEndpointDeclarationAst,
	ChartEvent,
	GuardOutcome,
	GuardRefAst,
	SchemaAst,
	SendStateAst,
	SendBatchStateAst,
	CallStateAst,
	CallBatchStateAst,
	StateActionAst,
	StatePath,
} from "./types.js";

/** Durable named branch (the storage lane). Branch ids are public, stable names. */
export type BranchId = string;

/** Explicit, non-durable checkout handle carried by a runner, command, or UI view. */
export type SelectedBranchHandle = Readonly<{ branchId: BranchId }>;

/** Optional durable branch provenance. It never represents an active/selected branch. */
export type BranchMetadata = Readonly<{
	name?: string;
	reason?: string;
	sourceBranchId?: BranchId;
	sourceSeqId?: number;
}>;

/** Materialized durable head for one named branch. */
export type BranchHead = Readonly<{
	branchId: BranchId;
	headSeqId: number | null;
	createdAt: number;
	metadata?: BranchMetadata;
}>;

export type DurableRecordCoordinates = {
	seqId: number;
	parentId: number | null;
	branchId: BranchId;
	timestamp: number;
};

type SessionParams = DurableRecordCoordinates;

type SessionRefLog = {
	type: "session_ref";
	index: number;
	file: string;
	actionUid?: ActionUID;
} & SessionParams;

// The run's input arguments — external data, hence a fact: the first record of a fresh log,
// seeded by start() when the run is created. Everything downstream (template rendering, replay)
// reads args from here and only here.
type ArgsLog = {
	type: "args";
	args: Readonly<Record<string, unknown>>;
} & SessionParams;

// A map's fan-out is a fact: which instance keys exist and what item each carries, pinned when
// the map is entered. The instance's input is frozen at birth — later changes to the `over`
// source do not reach spawned instances, and replay re-creates exactly the same fan-out.
type SpawnedLog = {
	type: "spawned";
	path: StatePath;
	instances: Readonly<Record<string, unknown>>;
} & SessionParams;

export type StateActionInvokeLog = {
	type: "state_action";
	kind: "invoke";
	actionUid: ActionUID;
	// Mandatory provenance for replay over a modified chart. Logs without it are structurally
	// incompatible and must be rewound/restarted instead of silently replayed.
	definition: StateActionAst;
} & SessionParams;

// The emitted event is the fact; transitions are never logged — the projection recomputes the
// route from the chart AST, so a log stays applicable to a modified chart.
type StateActionCompleteLog = {
	type: "state_action";
	kind: "complete";
	actionUid: ActionUID;
	event: ChartEvent;
} & SessionParams;

// Validation verdict for a completion claim. Stored like any other fact: replay reads the
// outcome instead of re-running the validator. The guard ref is provenance — a later "can this
// log replay unchanged?" check compares it (docker-cache style) against the current chart.
type StateActionValidatedLog = {
	type: "state_action";
	kind: "validated";
	actionUid: ActionUID;
	event: ChartEvent;
	guard: GuardRefAst;
	outcome: GuardOutcome;
} & SessionParams;

// The action's deadline expired before a completion landed. Like transitions, the target is not
// logged — the projection recomputes it from the state's `after` in the current chart.
type StateActionTimerFiredLog = {
	type: "state_action";
	kind: "timer_fired";
	actionUid: ActionUID;
} & SessionParams;

type StateAction = StateActionInvokeLog | StateActionCompleteLog | StateActionValidatedLog | StateActionTimerFiredLog;

/** First durable fact of global fail-fast. No successor state may start after this record. */
export type FailureIntentLog = {
	type: "failure_intent";
	origin: StatePath;
	error: unknown;
} & SessionParams;

export type ActorMessageEnvelope = Readonly<{
	messageId: string;
	event: string;
	input: unknown;
	producerState: StatePath;
	producerVisit: number;
	callId?: string;
	batchIndex: number;
}>;

export type ActorCreatedLog = {
	type: "actor_created";
	declaration: StatePath;
	/** Concrete occurrence path; generation 1 uses the logical path, later generations use ~N. */
	occurrence: StatePath;
	generation: number;
	owner?: StatePath;
	input: unknown;
	definition: ActorEndpointDeclarationAst;
} & SessionParams;

export type ActorMessageSource = Readonly<{
	producerState: StatePath;
	kind: "send" | "sendBatch" | "call" | "callBatch";
	definition: SendStateAst | SendBatchStateAst | CallStateAst | CallBatchStateAst;
	targetDeclaration: StatePath;
	event: string;
	inputSchema: SchemaAst;
}>;

/** One record is the atomic mailbox transaction for both a singleton and authored-order batch. */
export type ActorMessagesEnqueuedLog = {
	type: "actor_messages_enqueued";
	occurrence: StatePath;
	generation: number;
	source: ActorMessageSource;
	messages: readonly ActorMessageEnvelope[];
} & SessionParams;

export type ActorMessageAcceptedLog = {
	type: "actor_message";
	kind: "accepted";
	/** Endpoint occurrence. Pool worker identity is carried separately. */
	occurrence: StatePath;
	messageId: string;
	receiveState: StatePath;
	workerIndex?: number;
} & SessionParams;

export type ActorMessageRepliedLog = {
	type: "actor_message";
	kind: "replied";
	occurrence: StatePath;
	messageId: string;
	message: string;
	replyEvent?: string;
	output?: unknown;
	/** Exact selected schema (or absence for void) is replay provenance. */
	schema?: SchemaAst;
	workerIndex?: number;
} & SessionParams;

export type ActorMessageSettledLog = {
	type: "actor_message";
	kind: "settled";
	occurrence: StatePath;
	messageId: string;
	workerIndex?: number;
} & SessionParams;

export type ActorCallResolvedLog = {
	type: "actor_call_resolved";
	callId: string;
	callerState: StatePath;
	messageId: string;
	replyEvent?: string;
	output?: unknown;
} & SessionParams;

export type ActorBatchCallResolvedLog = {
	type: "actor_batch_call_resolved";
	callId: string;
	callerState: StatePath;
	/** Authored input order; item payloads remain in actor_message/replied facts. */
	messageIds: readonly string[];
} & SessionParams;

export type ActorScopeLog = ({
	type: "actor_scope";
	kind: "closing" | "stopped";
	occurrence: StatePath;
} & SessionParams);

export type ActorLogRecord =
	| ActorCreatedLog
	| ActorMessagesEnqueuedLog
	| ActorMessageAcceptedLog
	| ActorMessageRepliedLog
	| ActorMessageSettledLog
	| ActorCallResolvedLog
	| ActorBatchCallResolvedLog
	| ActorScopeLog;

export type DurableLogRecord =
	| SessionRefLog
	| ArgsLog
	| SpawnedLog
	| StateAction
	| FailureIntentLog
	| ActorLogRecord;

/** Machine payload before the storage writer assigns durable coordinates. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type DurableRecordDraft = DistributiveOmit<DurableLogRecord, keyof DurableRecordCoordinates>;

/**
 * One atomic append commit. A batch is one JSONL mutation so a process crash can
 * never expose records without the matching branch-head advance.
 */
export type RecordBatchMutation = Readonly<{
	kind: "record_batch";
	branchId: BranchId;
	records: readonly DurableLogRecord[];
	headSeqId: number;
	committedAt: number;
}>;

export type BranchCreateMutation = Readonly<{
	kind: "branch";
	op: "create";
	branchId: BranchId;
	headSeqId: number | null;
	metadata?: BranchMetadata;
	committedAt: number;
}>;

export type BranchMoveMutation = Readonly<{
	kind: "branch";
	op: "move";
	branchId: BranchId;
	headSeqId: number | null;
	committedAt: number;
}>;

/** Values accepted as lines in the current log.jsonl journal. */
export type StorageMutation = RecordBatchMutation | BranchCreateMutation | BranchMoveMutation;
