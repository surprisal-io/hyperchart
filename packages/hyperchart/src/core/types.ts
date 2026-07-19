import type { ZodType } from "zod";
import type { RuntimeContractMetadata } from "./schema_contract.js";
import type { SchemaRegistry } from "./schema_registry.js";

export type { RuntimeContractMetadata } from "./schema_contract.js";

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

// Shapes are authored as zod values, and only as zod values — one source for the TS type
// (z.infer), the agent-facing description and the runtime validation. Normalize converts the
// value to plain JSON Schema for the AST, so the chart-as-data doctrine holds where it matters
// (AST, log, hashes) while a zod instance never enters serialized data.
export type SchemaCst = ZodType;

export type SchemaAst = Readonly<{
	kind: "jsonSchema";
	schema: Readonly<JsonSchema>;
	/** Stable identity for an exact runtime Zod contract. */
	runtimeContract?: RuntimeContractMetadata;
}>;

// A deliverable file the agent must produce: where to write and — optionally — what shape the
// CONTENT has (a zod value declared next to the chart). The runtime tells the agent
// to write this shape and may verify the written file; consumers reading via fileOf() inherit
// path and shape from here, so they cannot drift. Artifacts are NOT the step's result — the
// result is the completion event's payload (see `reply`).
export type ArtifactCst = {
	kind: "artifact";
	path: Templatable;
	shape?: SchemaCst;
};

// A read of another state's declared artifact, by producer rather than by path. `artifact` names
// which one (may be omitted when the producer declares exactly one). An optional dot-path
// selector narrows the read to a field of the file's content — the machine only carries it (it
// never touches disk); the runtime reads the file, validates it against the declared shape and
// hands the agent just the selected part.
export type ArtifactOfCst = {
	kind: "artifactOf";
	// Absolute path of the producing action state; it must declare artifacts.
	state: StatePath;
	artifact?: string;
	select?: string;
};

// A fan-in read: the artifact of EVERY instance of a map, addressed by the producer's template
// path inside it. In an agent's reads it expands to one file per spawned instance; in a script's
// env it renders to a JSON array of paths. Instance set and order come from the spawned fact.
export type JoinArtifactOfCst = {
	kind: "joinArtifactOf";
	state: StatePath;
	artifact?: string;
};

// The per-invocation surface of a subagent, mirroring pi-subagents' chain step: `name` points at
// the definition (markdown file: identity, description, system prompt — not overridable);
// everything else parameterizes this call. The engine treats model/thinking/tools as opaque
// overrides of the definition's frontmatter.
export type AgentActionCst = {
	kind: "agent";
	name: string;
	// Task text (the user message; the definition's markdown body stays the system prompt).
	task?: Templatable;
	// Named deliverable files this call must produce — the runtime injects them into the task
	// ("[Write to: ...]") and may verify each (existence, and shape when declared). A plain
	// Templatable value is an artifact with just a path.
	artifacts?: Record<string, Templatable | ArtifactCst>;
	// Files the agent should read first: previous steps' artifacts via fileOf(), or raw paths.
	reads?: readonly (Templatable | ArtifactOfCst | JoinArtifactOfCst)[];
	model?: string;
	thinking?: string;
	tools?: readonly string[];
	// The step's RESULT: the shape of the completion event's payload. Small routing data only —
	// deliverables go through artifacts.
	reply?: SchemaCst;
};

export type UserActionCst = {
	kind: "user";
	prompt: Templatable;
	options?: readonly string[];
	reply?: SchemaCst;
};

// A command step: the runtime executes the command and answers with a completion event, exactly
// like an agent — same artifact/reads channels, same reply shape for the parsed stdout. The
// command and args are static; parameters flow through env templates (the taskflow contract).
// The same shape doubles as a script GuardRef when used in a validate position.
export type ScriptActionCst = {
	kind: "script";
	command: string;
	args?: readonly string[];
	// All dynamic values flow through env: templates render from args/results, artifactOf renders
	// to the producer's artifact PATH — the process reads the file itself, no prompt channel.
	env?: Record<string, Templatable | ArtifactOfCst | JoinArtifactOfCst>;
	artifacts?: Record<string, Templatable | ArtifactCst>;
	reply?: SchemaCst;
};

export type StateActionCst = AgentActionCst | UserActionCst | ScriptActionCst;

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
			// A script guard has the complete script-option surface. Its reply is validation-only and
			// its artifacts are declared outputs of the containing action state.
			env?: Record<string, Templatable | ArtifactOfCst | JoinArtifactOfCst>;
			artifacts?: Record<string, Templatable | ArtifactCst>;
			reply?: SchemaCst;
	  };

/** Normalized, replayable guard definition (the runtime normalizer converts templates to AST values). */
export type GuardRefAst =
	| GuardRef
	| {
			kind: "script";
			command: string;
			args?: readonly string[];
			env?: Readonly<Record<string, TemplateAst | ArtifactOfAst | JoinArtifactOfAst>>;
			artifacts?: Readonly<Record<string, ArtifactAst>>;
			reply?: SchemaAst;
	  };

export type GuardOutcome = boolean | { ok: false; reason: string };

// What to do when validation rejects a completion claim: feed the reason back into the still
// running action ("resume") or discard that validation attempt and start the action fresh ("restart").
// Either way the action stays pending and nothing is logged — the choice lives in the chart,
// the runtime just executes it.
export type OnReject = "resume" | "restart";

export type EventBindingCst = {
	kind: "event";
	path?: string;
};

export type TransitionCst = {
	target: StateId;
	input?: Record<string, EventBindingCst>;
};

export type TransitionMapCst = Record<EventType, StateId | TransitionCst>;

export type EventBindingAst = Readonly<EventBindingCst>;

export type TransitionAst = Readonly<{
	target: StateId;
	input?: Readonly<Record<string, EventBindingAst>>;
}>;

// Deadline for an action state: if the action is still running delayMs after its invoke fact,
// the chart transitions to target and the runtime is told to cancel the action. The timer covers
// only the running phase — validation of a completion is not raced against the clock.
export type AfterCst = {
	delayMs: number;
	target: StateId;
};

// Serializable reference to a value from the run's args or a previous state's result (optionally
// narrowed by a dot-path selector). Only ever appears interpolated inside a template. Never
// logged: the same args/results facts always resolve to the same values, so a restarted machine
// renders identical text.
//
// V is a phantom: the TS type of the value the ref resolves to, carried by the typed layer
// (refs<Args, Results>()) so templates can insist on primitives. Never present at runtime.
// Declared as an optional method for bivariance: untyped refs (V = unknown) pass everywhere,
// refs with unrelated value types do not.
export type InputRef<V = unknown> = (
	| {
			kind: "arg";
			name: string;
	  }
	| {
			kind: "result";
			// Absolute state path: this is a data lookup, not control flow — no sibling scoping.
			state: StatePath;
			path?: string;
	  }
	// The instance args of an enclosing map: its key, and its spawn-pinned item (optionally
	// narrowed by a dot-path). `map` names the map by template path — required for nesting and
	// set by the typed layer; without it the nearest enclosing map is used. Only meaningful
	// inside that map's body.
	| {
			kind: "key";
			map?: StatePath;
	  }
	| {
			kind: "item";
			map?: StatePath;
			path?: string;
	  }
	| {
			kind: "input";
			name: string;
			path?: string;
	  }
	| {
			kind: "visit";
			state?: StatePath;
	  }
) & {
	// Set by json(): the value is embedded as JSON text. Without it the renderer admits only
	// primitives — the runtime twin of the static rule enforced by t().
	json?: true;
	__value?(value: V): void;
};

// A string with interpolated refs, authored as a tagged template:
//   t`Report on ${arg("topic")} using ${result("plan", "steps")}`
// Plain data (strings.length === refs.length + 1), no placeholder grammar to parse; the machine
// renders it right before dispatch (string values verbatim, everything else as JSON).
export type TemplateCst = {
	kind: "template";
	strings: readonly string[];
	refs: readonly InputRef[];
};

// Anywhere a template is accepted, a plain string is too (a template with no refs).
export type Templatable = string | TemplateCst;

export type TemplateAst = Readonly<{
	kind: "template";
	strings: readonly string[];
	refs: readonly InputRef[];
}>;

export type OnReenterCst = "restart" | { kind: "resume"; message: Templatable };
export type OnReenterAst = "restart" | { kind: "resume"; message: TemplateAst };

export type ActionStateCst = {
	kind: "state";
	action: StateActionCst;
	input?: Record<string, SchemaCst>;
	transitions?: TransitionMapCst;
	after?: AfterCst;
	validate?: GuardRef;
	onReject?: OnReject;
	onReenter?: OnReenterCst;
	// Rejection budget: how many rejected rounds may be retried. The (retries+1)-th rejection is
	// terminal — the claim turns into a FAILED transition (a FAILED route must exist, possibly on
	// an ancestor) and the abandoned session is cancelled. Requires validate; omitted = unbounded.
	retries?: number;
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

// A dynamic fan-out: a compound-shaped container whose instances are spawned per key of the
// `over` value (a Record resolved from run data). The keys AND items are pinned by a `spawned`
// fact — the instance's input is frozen at birth (its future actor args). An instance completes
// by reaching a final child; when all instances complete the map exits through onDone. The map's
// own transitions catch what instances leave unhandled — exiting ALL instances (abort).
export type MapStateCst = {
	kind: "map";
	input?: Record<string, SchemaCst>;
	over: InputRef;
	// At most this many instances run at once (invokes are gated, spawn is not); omitted = all.
	concurrency?: number;
	onReenter?: OnReenterCst;
	initial: StateId;
	states: Record<StateId, StateCst>;
	transitions?: TransitionMapCst;
	onDone?: StateId;
};

export type StateCst = ActionStateCst | FinalStateCst | CompoundStateCst | ParallelStateCst | MapStateCst;

export type ChartCst = {
	kind: "chart";
	id: string;
	initial: StateId;
	states: Record<StateId, StateCst>;
};

export type ArtifactAst = Readonly<{
	path: TemplateAst;
	shape?: SchemaAst;
}>;

export type ArtifactOfAst = Readonly<ArtifactOfCst>;

export type JoinArtifactOfAst = Readonly<JoinArtifactOfCst>;

export type AgentActionAst = Readonly<{
	kind: "agent";
	uid: ActionUID;
	name: string;
	task?: TemplateAst;
	artifacts?: Readonly<Record<string, ArtifactAst>>;
	reads?: readonly (TemplateAst | ArtifactOfAst | JoinArtifactOfAst)[];
	model?: string;
	thinking?: string;
	tools?: readonly string[];
	reply?: SchemaAst;
}>;
export type UserActionAst = Readonly<{
	kind: "user";
	uid: ActionUID;
	prompt: TemplateAst;
	options: readonly string[];
	reply?: SchemaAst;
}>;
export type ScriptActionAst = Readonly<{
	kind: "script";
	uid: ActionUID;
	command: string;
	args: readonly string[];
	env?: Readonly<Record<string, TemplateAst | ArtifactOfAst | JoinArtifactOfAst>>;
	artifacts?: Readonly<Record<string, ArtifactAst>>;
	reply?: SchemaAst;
}>;
export type StateActionAst = AgentActionAst | UserActionAst | ScriptActionAst;

// Absolute path of a state in the chart: local ids joined with "." (e.g. "review.analyze").
// Top-level states' paths equal their ids, so flat charts keep their addresses.
export type StatePath = string;

export type ActionStateAst = Readonly<{
	kind: "state";
	id: StateId;
	// Path of the containing compound; absent at top level.
	parent?: StatePath;
	action: StateActionAst;
	input?: Readonly<Record<string, SchemaAst>>;
	transitions: Readonly<Record<EventType, TransitionAst>>;
	after?: Readonly<AfterCst>;
	validate?: GuardRefAst;
	// Present only when validate is set; defaults to "resume".
	onReject?: OnReject;
	onReenter?: OnReenterAst;
	retries?: number;
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
	transitions: Readonly<Record<EventType, TransitionAst>>;
	onDone: StateId;
}>;

// A compound written inside a parallel. Its final child marks the region complete for the join
// instead of exiting anywhere, hence no onDone; its own transitions may only restart itself.
export type RegionStateAst = Readonly<{
	kind: "region";
	id: StateId;
	parent?: StatePath;
	initial: StateId;
	transitions: Readonly<Record<EventType, TransitionAst>>;
}>;

export type ParallelStateAst = Readonly<{
	kind: "parallel";
	id: StateId;
	parent?: StatePath;
	// Local ids of the regions, all entered on entry. Regions are always completable, so the
	// join always has somewhere to go: onDone is mandatory.
	regions: readonly StateId[];
	transitions: Readonly<Record<EventType, TransitionAst>>;
	onDone: StateId;
}>;

export type MapStateAst = Readonly<{
	kind: "map";
	id: StateId;
	parent?: StatePath;
	input?: Readonly<Record<string, SchemaAst>>;
	over: InputRef;
	concurrency?: number;
	onReenter?: OnReenterAst;
	initial: StateId;
	transitions: Readonly<Record<EventType, TransitionAst>>;
	onDone: StateId;
}>;

export type StateAst =
	| ActionStateAst
	| FinalStateAst
	| CompoundStateAst
	| RegionStateAst
	| ParallelStateAst
	| MapStateAst;

export type ChartAst = Readonly<{
	kind: "chart";
	id: string;
	initial: StateId;
	// Flat map keyed by absolute StatePath — nesting lives in `parent` links, lookups stay O(1).
	states: Readonly<Record<StatePath, StateAst>>;
}>;

export type ActionEvent = {
	type: string;
	// The action's result payload. Travels inside the complete fact, so it is durable for free;
	// the projection exposes it as results[statePath] once the completion is accepted.
	output?: unknown;
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
			/** Original runtime Zod schemas for this parsed chart; never serialized. */
			schemaRegistry: SchemaRegistry;
			diagnostics: readonly [];
	  }
	| {
			ok: false;
			source: ChartSource;
			cst?: ChartCst;
			diagnostics: readonly AuthoringDiagnostic[];
	  };
