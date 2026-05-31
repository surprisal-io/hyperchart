export type StateId = string;
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

export type InputMapper<TInput = unknown> = (args: {
	input: TInput;
	results: Record<StateId, StateResult>;
}) => unknown;

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

export type AgentActionCst<TInput = unknown> = {
	kind: "agent";
	name: string;
	input?: InputMapper<TInput>;
	output?: OutputSpecCst;
};

export type ScriptActionCst<TInput = unknown> = {
	kind: "script";
	command: string | InputMapper<TInput>;
	output?: OutputSpecCst;
};

export type UserActionCst<TInput = unknown> = {
	kind: "user";
	prompt: string | InputMapper<TInput>;
	options?: readonly string[];
	output?: OutputSpecCst;
};

export type StateActionCst<TInput = unknown> =
	| AgentActionCst<TInput>
	| ScriptActionCst<TInput>
	| UserActionCst<TInput>;

export type TransitionMapCst = Record<EventType, StateId>;

export type ActionStateCst<TInput = unknown> = {
	kind: "state";
	action: StateActionCst<TInput>;
	transitions?: TransitionMapCst;
};

export type FinalStateCst = {
	kind: "final";
};

export type StateCst<TInput = unknown> = ActionStateCst<TInput> | FinalStateCst;

export type ChartCst<TInput = unknown> = {
	kind: "chart";
	id: string;
	initial: StateId;
	states: Record<StateId, StateCst<TInput>>;
};

export type ActionStateInput<TInput = unknown> = Omit<ActionStateCst<TInput>, "kind"> & {
	kind?: "state";
};
export type FinalStateInput = FinalStateCst | { final: true };
export type StateInput<TInput = unknown> = StateCst<TInput> | ActionStateInput<TInput> | FinalStateInput;
export type ChartInput<TInput = unknown> = Omit<ChartCst<TInput>, "kind" | "states"> & {
	kind?: "chart";
	states: Record<StateId, StateInput<TInput>>;
};

export type AgentActionAst<TInput = unknown> = Readonly<AgentActionCst<TInput> & { output?: OutputSpecAst }>;
export type ScriptActionAst<TInput = unknown> = Readonly<ScriptActionCst<TInput> & { output?: OutputSpecAst }>;
export type UserActionAst<TInput = unknown> = Readonly<
	Omit<UserActionCst<TInput>, "options" | "output"> & { options: readonly string[]; output?: OutputSpecAst }
>;
export type StateActionAst<TInput = unknown> =
	| AgentActionAst<TInput>
	| ScriptActionAst<TInput>
	| UserActionAst<TInput>;

export type ActionStateAst<TInput = unknown> = Readonly<{
	kind: "state";
	id: StateId;
	action: StateActionAst<TInput>;
	transitions: Readonly<Record<EventType, StateId>>;
}>;

export type FinalStateAst = Readonly<{
	kind: "final";
	id: StateId;
}>;

export type StateAst<TInput = unknown> = ActionStateAst<TInput> | FinalStateAst;

export type ChartAst<TInput = unknown> = Readonly<{
	kind: "chart";
	id: string;
	initial: StateId;
	states: Readonly<Record<StateId, StateAst<TInput>>>;
}>;

export type ActionEvent<TPayload = unknown> = {
	type: string;
	payload?: TPayload;
};

export type SystemEvent = {
	type: ReservedSystemEventType;
	error: unknown;
};

export type ChartEvent = ActionEvent | SystemEvent;

export type StateResult<TOutput = unknown> = {
	status: "ok" | "error" | "cancelled";
	output?: TOutput;
	event?: ActionEvent;
	error?: unknown;
};

export type ParsedChart<TInput = unknown> =
	| {
			ok: true;
			source: ChartSource;
			cst: ChartCst<TInput>;
			ast: ChartAst<TInput>;
			diagnostics: readonly [];
	  }
	| {
			ok: false;
			source: ChartSource;
			cst?: ChartCst<TInput>;
			diagnostics: readonly AuthoringDiagnostic[];
	  };
