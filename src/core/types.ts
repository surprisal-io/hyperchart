export type StateId = string;
export type ActionUID = Readonly<{
	chart: string;
	state: StateId;
	action: string;
}>;
export type EventType = string;
export type ReservedSystemEventType = "FAILED";
export type JsonSchema = Record<string, unknown>;

export type ChartSource = {
	path?: string;
	exportName?: string;
	line?: number;
	column?: number;
};

export type AuthoringDiagnostic = {
	code: string;
	message: string;
	path?: string;
	source?: ChartSource;
};

export type SchemaRefCst = {
	kind: "schemaRef";
	name: string;
};

export type TsImportSchemaRefCst = {
	kind: "tsImport";
	module: string;
	export: string;
};

export type JsonSchemaOutputCst = {
	kind: "jsonSchema";
	schema: JsonSchema;
};

export type OutputSpecCst = JsonSchemaOutputCst | SchemaRefCst | TsImportSchemaRefCst;

export type SchemaRefAst = Readonly<SchemaRefCst>;
export type TsImportSchemaRefAst = Readonly<TsImportSchemaRefCst>;
export type JsonSchemaOutputAst = Readonly<{
	kind: "jsonSchema";
	schema: Readonly<JsonSchema>;
}>;
export type OutputSpecAst = JsonSchemaOutputAst | SchemaRefAst | TsImportSchemaRefAst;

export type AgentActionCst = {
	kind: "agent";
	name: string;
	output?: OutputSpecCst;
};

export type UserActionCst = {
	kind: "user";
	prompt: string;
	options?: readonly string[];
	output?: OutputSpecCst;
};

export type StateActionCst = AgentActionCst | UserActionCst;

// Serializable reference to validation code. Inline closures are not allowed: the chart stays
// plain data. A validator is an acceptance check on the action's completion claim — it runs live
// exactly once, when the claim arrives; accepted facts are never re-validated on replay.
export type GuardRef =
	| {
			kind: "tsImport";
			module: string;
			export: string;
	  }
	| {
			kind: "script";
			command: string;
			args?: readonly string[];
	  };

export type GuardOutcome = boolean | { ok: false; reason: string };

// What to do when validation rejects a completion claim: feed the reason back into the still
// running action ("resume") or discard that attempt and start the action fresh ("restart").
// Either way the action stays pending and nothing is logged — the choice lives in the chart,
// the runtime just executes it.
export type OnReject = "resume" | "restart";

export type TransitionMapCst = Record<EventType, StateId>;

// Deadline for an action state: if the action is still running delayMs after its invoke fact,
// the chart transitions to target and the runtime is told to cancel the action. The timer covers
// only the running phase — validation of a completion is not raced against the clock.
export type AfterCst = {
	delayMs: number;
	target: StateId;
};

export type ActionStateCst = {
	kind: "state";
	action: StateActionCst;
	transitions?: TransitionMapCst;
	after?: AfterCst;
	validate?: GuardRef;
	onReject?: OnReject;
};

export type FinalStateCst = {
	kind: "final";
};

// A container of nested states. Entering it drills down the initial chain to a leaf. Its
// transitions catch events its descendants leave unhandled (innermost-first); onDone is where the
// chart goes when a direct final child is reached — required if it has one. All targets, here and
// in children, resolve among the siblings of the level where they are declared.
export type CompoundStateCst = {
	kind: "compound";
	initial: StateId;
	states: Record<StateId, StateCst>;
	transitions?: TransitionMapCst;
	onDone?: StateId;
};

// All children (regions) run concurrently; entering the parallel enters every region. A final
// inside a region marks that region complete (regions must not declare onDone); when every
// region is complete the parallel exits through its own onDone. An event bubbling past a region
// to the parallel (or above) exits all regions at once, abandoning their running actions.
export type ParallelStateCst = {
	kind: "parallel";
	states: Record<StateId, StateCst>;
	transitions?: TransitionMapCst;
	onDone?: StateId;
};

export type StateCst = ActionStateCst | FinalStateCst | CompoundStateCst | ParallelStateCst;

export type ChartCst = {
	kind: "chart";
	id: string;
	initial: StateId;
	states: Record<StateId, StateCst>;
};

export type AgentActionAst = Readonly<{
	kind: "agent";
	uid: ActionUID;
	name: string;
	output?: OutputSpecAst;
}>;
export type UserActionAst = Readonly<{
	kind: "user";
	uid: ActionUID;
	prompt: string;
	options: readonly string[];
	output?: OutputSpecAst;
}>;
export type StateActionAst = AgentActionAst | UserActionAst;

// Absolute path of a state in the chart: local ids joined with "." (e.g. "review.analyze").
// Top-level states' paths equal their ids, so flat charts keep their addresses.
export type StatePath = string;

export type ActionStateAst = Readonly<{
	kind: "state";
	id: StateId;
	// Path of the containing compound; absent at top level.
	parent?: StatePath;
	action: StateActionAst;
	transitions: Readonly<Record<EventType, StateId>>;
	after?: Readonly<AfterCst>;
	validate?: GuardRef;
	// Present only when validate is set; defaults to "resume".
	onReject?: OnReject;
}>;

export type FinalStateAst = Readonly<{
	kind: "final";
	id: StateId;
	parent?: StatePath;
}>;

// Every compound completes: it must contain a direct final child and exit through onDone. There
// is no "loop container" without a final — a repeat-until process expresses its exit condition
// as a final child instead.
export type CompoundStateAst = Readonly<{
	kind: "compound";
	id: StateId;
	parent?: StatePath;
	initial: StateId;
	transitions: Readonly<Record<EventType, StateId>>;
	onDone: StateId;
}>;

// A compound written inside a parallel. Its final child marks the region complete for the join
// instead of exiting anywhere, hence no onDone; its own transitions may only restart itself.
export type RegionStateAst = Readonly<{
	kind: "region";
	id: StateId;
	parent?: StatePath;
	initial: StateId;
	transitions: Readonly<Record<EventType, StateId>>;
}>;

export type ParallelStateAst = Readonly<{
	kind: "parallel";
	id: StateId;
	parent?: StatePath;
	// Local ids of the regions, all entered on entry. Regions are always completable, so the
	// join always has somewhere to go: onDone is mandatory.
	regions: readonly StateId[];
	transitions: Readonly<Record<EventType, StateId>>;
	onDone: StateId;
}>;

export type StateAst = ActionStateAst | FinalStateAst | CompoundStateAst | RegionStateAst | ParallelStateAst;

export type ChartAst = Readonly<{
	kind: "chart";
	id: string;
	initial: StateId;
	// Flat map keyed by absolute StatePath — nesting lives in `parent` links, lookups stay O(1).
	states: Readonly<Record<StatePath, StateAst>>;
}>;

export type ActionEvent = {
	type: string;
};

export type SystemEvent = {
	type: ReservedSystemEventType;
	error: unknown;
};

export type ChartEvent = ActionEvent | SystemEvent;

export type ParsedChart =
	| {
			ok: true;
			source: ChartSource;
			cst: ChartCst;
			ast: ChartAst;
			diagnostics: readonly [];
	  }
	| {
			ok: false;
			source: ChartSource;
			cst?: ChartCst;
			diagnostics: readonly AuthoringDiagnostic[];
	  };
