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

export type TransitionMapCst = Record<EventType, StateId>;

export type ActionStateCst = {
	kind: "state";
	action: StateActionCst;
	transitions?: TransitionMapCst;
};

export type FinalStateCst = {
	kind: "final";
};

export type StateCst = ActionStateCst | FinalStateCst;

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

export type ActionStateAst = Readonly<{
	kind: "state";
	id: StateId;
	action: StateActionAst;
	transitions: Readonly<Record<EventType, StateId>>;
}>;

export type FinalStateAst = Readonly<{
	kind: "final";
	id: StateId;
}>;

export type StateAst = ActionStateAst | FinalStateAst;

export type ChartAst = Readonly<{
	kind: "chart";
	id: string;
	initial: StateId;
	states: Readonly<Record<StateId, StateAst>>;
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
