# Core API

This page covers the non-authoring exports of `@surprisal/hyperchart`. See [DSL reference](dsl.md) for chart constructors and CST fields. `@surprisal/hyperchart/package.json` exports the package metadata object for tooling that needs the installed version, engines, or export map.

```ts
import {
  normalizeChartConfig,
  parseChartModule,
  inspectChartAst,
  createBranchProjection,
  projectBranch,
  createMachineOutput,
  stepMachine,
  explainReplay,
} from "@surprisal/hyperchart";
```

## Parsing and normalization

### `normalizeChartConfig()`

```ts
function normalizeChartConfig(input: unknown, source?: ChartSource): ParsedChart;
```

Validates a chart CST and produces an immutable normalized AST.

```ts
type ParsedChart =
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

type ChartSource = {
  path?: string;
  exportName?: string;
  line?: number;
  column?: number;
};

type AuthoringDiagnostic = {
  code: string;
  message: string;
  path?: string;
  source?: ChartSource;
};
```

It does not throw for authoring errors. Read `diagnostics` when `ok` is false.

```ts
const parsed = normalizeChartConfig(definition, { path: "example.chart.ts" });
if (!parsed.ok) {
  for (const diagnostic of parsed.diagnostics) {
    console.error(diagnostic.code, diagnostic.path, diagnostic.message);
  }
}
```

### `isReservedSystemEvent()`

```ts
function isReservedSystemEvent(eventType: string): boolean;
```

Returns `true` for `FAILED`.

### `parseChartExport()`

```ts
function parseChartExport(value: unknown, source?: ChartSource): ParsedChart;
```

Normalizes an export value that has already been loaded.

### `parseChartModule()`

```ts
function parseChartModule(
  filePath: string,
  options?: { exportName?: string; cacheBust?: boolean },
): Promise<ParsedChart>;
```

Resolves `filePath`, imports the module, selects `default` or `exportName`, and normalizes it. `cacheBust` defaults to `true`. Load failures become an unsuccessful `ParsedChart` with `TS_MODULE_LOAD_FAILED`.

Chart modules are executable TypeScript. Importing one can execute arbitrary top-level code.

### `parseChartModuleAst()`

```ts
function parseChartModuleAst(
  filePath: string,
  options?: { exportName?: string; cacheBust?: boolean },
): Promise<Extract<ParsedChart, { ok: true }>>;
```

Returns only successful results. It throws `ChartParseError` if loading or normalization fails.

### `ChartParseError`

```ts
class ChartParseError extends Error {
  readonly result: ParsedChart;
}
```

`message` is the newline-joined diagnostic text. `result` retains structured diagnostics.

### `parseChartModuleSync()`

```ts
function parseChartModuleSync(
  filePath: string,
  options?: InspectChartModuleOptions,
): ParsedChart;
```

Synchronously loads TypeScript through Jiti and normalizes it. It returns authoring/load failures as an unsuccessful `ParsedChart`.

## Static inspection

### `inspectChartAst()`

```ts
function inspectChartAst(
  ast: ChartAst,
  options?: {
    chartPath?: string;
    exportName?: string;
    agentDefaults?: (agentName: string) => HyperchartInspectAgentDefaults | undefined;
  },
): HyperchartInspectResult;
```

Produces a serializable, UI-oriented view of normalized chart data. `agentDefaults` can overlay host model, thinking, and tool defaults without changing the chart AST.

### `inspectChartModuleSync()`

```ts
function inspectChartModuleSync(
  filePath: string,
  options?: InspectChartModuleOptions,
): HyperchartInspectResult;
```

Loads, normalizes, and inspects a chart. Unlike `parseChartModuleSync()`, it throws `Error` if parsing fails.

### Inspection types

```ts
type InspectChartModuleOptions = {
  exportName?: string;
  agentDefaults?: (agentName: string) => HyperchartInspectAgentDefaults | undefined;
};

type HyperchartInspectAgentDefaults = {
  model?: string;
  thinking?: string;
  tools?: readonly string[];
  agentDefinitionUnavailable?: boolean;
};

type HyperchartInspectResult = {
  chartId: string;
  chartPath?: string;
  exportName?: string;
  definitionSource?: string;
  mode: "static";
  states: HyperchartInspectState[];
};
```

`HyperchartInspectState` fields:

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Absolute state path. |
| `kind` | `"agent" \| "user" \| "script" \| "map" \| "parallel" \| "compound" \| "region" \| "final"` | Normalized display kind. |
| `initial` | `boolean?` | State selected by the chart root or an enclosing compound, region, or map `initial` declaration. |
| `definitionSource` | `string?` | Generated DSL for this state. |
| `agent` | `string?` | Agent definition name. |
| `task` | `string?` | Static template preview. |
| `command` | `string?` | Script command preview. |
| `env` | `HyperchartInspectEnv[]?` | Script environment declarations. |
| `reads` | `string[]?` | Referenced state paths. |
| `refs` | `HyperchartInspectRef[]?` | Structured refs used by the state. |
| `inputs` | `HyperchartInspectInput[]?` | Declared transition inputs. |
| `onReenter` | `HyperchartInspectOnReenter?` | Re-entry policy. |
| `artifacts` | `HyperchartInspectArtifact[]?` | Declared deliverables. |
| `reply` | `JsonSchema?` | Normalized completion-output schema. |
| `guard` | `HyperchartInspectGuard?` | Validation guard. |
| `onReject` | `"resume" \| "restart"` | Validation rejection policy. |
| `model` / `thinking` / `tools` | optional | Effective agent settings. |
| `agentDefinitionUnavailable` | `boolean?` | Host could not resolve the named agent. |
| `over` / `overSchema` | optional | Map source preview and schema. |
| `concurrency` | `number?` | Map invocation limit. |
| `regions` / `branches` | optional | Parallel structure. |
| `retries` | `number?` | Validation rejection budget. |
| `transitions` | `HyperchartInspectTransition[]?` | Static outgoing routes. |

Supporting inspection exports:

```ts
type HyperchartInspectArtifact = { name: string; path?: string; shape?: JsonSchema };
type HyperchartInspectInput = { name: string; schema: JsonSchema; required: boolean; defaultValue?: unknown };
type HyperchartInspectTransition = { event: string; target: string; input?: Record<string, string> };
type HyperchartInspectEnv = { name: string; type: string; value?: string; schema?: JsonSchema };
type HyperchartInspectBranch = { id: string; agent?: string; task?: string };

type HyperchartInspectGuard =
  | { kind: "script"; command: string; args?: string[] }
  | { kind: "tsImport"; module: string; export: string };

type HyperchartInspectOnReenter =
  | { mode: "restart" }
  | { mode: "resume"; message?: string; refs?: HyperchartInspectRef[] };

type HyperchartInspectRef = {
  kind: InputRef["kind"] | "artifactOf" | "joinArtifactOf";
  preview: string;
  state?: string;
  name?: string;
  path?: string;
  json?: boolean;
};
```

## Source generation

### `hyperchartSource()`

```ts
function hyperchartSource(ast: ChartAst, selectedStateId?: StatePath | null): string;
```

With `null` or no second argument, renders the full normalized chart as DSL source. With a state path, renders that state entry. An unknown state returns `"undefined"`.

Generated source describes the normalized definition; it is not the author's original formatting or comments.

### `hyperchartStateSources()`

```ts
function hyperchartStateSources(ast: ChartAst): Record<StatePath, string>;
```

Renders every state into a map keyed by absolute state path.

## Normalized AST

```ts
type ChartAst = Readonly<{
  kind: "chart";
  id: string;
  initial: string;
  states: Readonly<Record<StatePath, StateAst>>;
}>;
```

The AST is flat. `states` is keyed by absolute template path; nested nodes carry `parent` links.

Public AST exports:

| Type | Important fields |
|---|---|
| `ActionStateAst` | `id`, `parent?`, `action`, `input?`, `transitions`, `after?`, `validate?`, `onReject?`, `onReenter?`, `retries?` |
| `FinalStateAst` | `id`, `parent?`, `kind: "final"` |
| `CompoundStateAst` | `id`, `parent?`, `initial`, `transitions`, `onDone` |
| `RegionStateAst` | `id`, `parent?`, `initial`, `transitions` |
| `ParallelStateAst` | `id`, `parent?`, `regions`, `transitions`, `onDone` |
| `MapStateAst` | `id`, `parent?`, `input?`, `over`, `concurrency?`, `onReenter?`, `initial`, `transitions`, `onDone` |
| `AgentActionAst` | `uid`, `name`, `task?`, `artifacts?`, `reads?`, model options, `reply?` |
| `ScriptActionAst` | `uid`, `command`, `args`, `env?`, `artifacts?`, `reply?` |
| `UserActionAst` | `uid`, `prompt`, `options`, `reply?` |
| `ArtifactAst` | normalized `path` template and optional schema |
| `ArtifactOfAst` | producer state, optional artifact and selector |
| `JoinArtifactOfAst` | map-contained producer and optional artifact |
| `SchemaAst` | `{ kind: "jsonSchema", schema: JsonSchema, runtimeContract?: { id: string; version: string } }` |
| `TemplateAst` | immutable `strings` and refs |
| `TransitionAst` | target and optional event-output bindings |
| `EventBindingAst` | event-output selector |

The root entry point also exports the corresponding public CST types listed in [DSL reference](dsl.md).

### Exact runtime Zod contracts

`contract(id, version, schema)` returns the original Zod schema value, preserving normal `z.infer<typeof Schema>` usage. Explicitly contracted schemas carry serializable `{ id, version }` metadata in `SchemaAst.runtimeContract`; their original Zod values live only in the parsed chart's in-memory `schemaRegistry` sidecar. Runtime validation uses `safeParseAsync`, including refine/superRefine and asynchronous refinements. If the sidecar is unavailable, validation fails closed rather than falling back to JSON Schema. Ordinary Zod schemas continue to use the normalized JSON Schema compatibility path.

```ts
const Reply = contract("review-reply", "2025-01", z.object({
  approved: z.boolean(),
}).superRefine(async (value, ctx) => {
  if (!value.approved) ctx.addIssue({ code: "custom", message: "approval required" });
}));

const parsed = normalizeChartConfig(chart({ /* ... reply: Reply ... */ }));
if (parsed.ok) {
  // Pass both values to ChartRuntime; the registry is intentionally chart-instance scoped.
  new ChartRuntime({ ast: parsed.ast, schemaRegistry: parsed.schemaRegistry, /* ... */ });
}
```

Changing a contract version changes normalized AST action provenance, so replay reports stale definitions instead of silently reinterpreting existing runs. Inspectors and source projections expose only serializable JSON Schema and metadata; closures and Zod instances are never serialized.

## Projection

A projection derives current control and data state from ordered durable facts.

### `createBranchProjection()`

```ts
function createBranchProjection(ast: ChartAst): BranchProjection;
```

Enters the chart's initial configuration, applies input defaults, and returns an empty fact projection.

### `projectBranch()`

```ts
function projectBranch(
  projection: BranchProjection,
  ast: ChartAst,
  log: readonly DurableLogRecord[],
  abandoned?: PendingAction[],
  skipped?: ProjectionSkippedRecord[],
): BranchProjection;
```

Mutates and returns `projection` by applying records in order.

- `abandoned` receives pending actions dropped by a scope exit.
- `skipped` receives legal no-op records whose state is no longer active.

```ts
const projection = projectBranch(
  createBranchProjection(ast),
  ast,
  records,
);
```

### `isFinalState()`

```ts
function isFinalState(projection: BranchProjection, ast: ChartAst): boolean;
```

Returns `true` when every active leaf is final.

### `BranchProjection`

```ts
type BranchProjection = {
  activeLeaves: StatePath[];
  seqId: number;
  pendingActions: PendingAction[];
  args?: Readonly<Record<string, unknown>>;
  spawns: Record<StatePath, Readonly<Record<string, unknown>>>;
  inputs: Record<StatePath, Record<string, unknown>>;
  results: Record<StatePath, unknown>;
  stateVisits: Record<string, number>;
  sessions: Record<string, string>;
};
```

`PendingAction` is a discriminated union with `phase: "running" | "validating" | "rejected"`. Every member carries the action UID, visit id, invoke seqId, and current phase seqId. Validation phases also carry the claimed event and attempt count.

```ts
type ProjectionSkippedRecord = {
  record: DurableLogRecord;
  state: StatePath;
  reason: "inactive";
  activeLeaves: readonly StatePath[];
};
```

## Pure machine

### `stepMachine()`

```ts
function stepMachine(state: MachineState, event: MachineEvent): MachineOutput;
```

Advances the pure machine. It does not perform I/O. Returned effects must be interpreted by a runtime.

### `createMachineOutput()`

```ts
function createMachineOutput(
  state: MachineState,
  responses: readonly (Effect | RecordAppend)[],
): MachineOutput;
```

Derives due invokes, map spawns, timers, validations, and retries; deduplicates effects already dispatched in this machine lifetime; stamps record appends; and returns final output when appropriate.

### `MachineState`

```ts
type MachineState = {
  ast: ChartAst;
  projection: BranchProjection;
  dispatched: Set<EffectId>;
};
```

### `MachineOutput`

```ts
type MachineOutput = MachineOutputEffect | MachineOutputFinal | /* error variant */;

type MachineOutputEffect = {
  kind: "effect";
  state: MachineState;
  effects: Effect[];
};

type MachineOutputFinal = {
  kind: "final";
  state: MachineState;
  effects: Effect[];
  result: unknown;
};
```

Handle the third variant with `output.kind === "error"`; it contains `state` and `error: string`.

### Effects

`Effect` is the union of:

| Export | `kind` | Runtime responsibility |
|---|---|---|
| `AgentEffect` | `agent` | Start or resume an agent invocation and emit a chart event. |
| `ScriptEffect` | `script` | Run a process and emit a chart event. |
| `UserEffect` | `user` | Ask a host user and emit a chart event. |
| `DurableRecordsEffect` | `durable_records` | Append records atomically, then acknowledge them. |
| `ValidateEffect` | `validate` | Run the guard and return `ValidatedMachineEvent`. |
| `RejectedEffect` | `rejected` | Deliver rejection feedback or restart the invocation. |
| `TimerEffect` | `timer` | Emit a timer event at `firesAt`. |
| `CancelEffect` | `cancel` | Stop abandoned work. |

`ValidateEffect` carries guard env rendered by the same helper as `ScriptEffect.env`:

```ts
type ValidateEffect = {
  kind: "validate";
  id: EffectId;
  actionUid: ActionUID;
  guard: GuardRef;
  event: ChartEvent;
  env?: Readonly<Record<string, string | RenderedArtifact>>;
  artifacts?: readonly RenderedArtifact[];
  reply?: SchemaAst;
};
```

Env, guard artifacts, and guard reply are resolved/validated only for the pending guard. Reply output is validation-only; guard artifacts remain part of the containing state's declared Files surface. Artifact values are never durable facts or stdin/context fields. `ActionEffect` is `AgentEffect | ScriptEffect | UserEffect`. `ResumeRequest` contains a rendered message and optional session file. `RecordAppend` is an unstamped append request used before durable seqIds and timestamps are assigned.

### Machine events

`MachineEvent` includes:

- `AgentMachineEvent`;
- `ScriptMachineEvent`;
- `UserMachineEvent`;
- `DurableRecordsAddedMachineEvent`;
- `ValidatedMachineEvent`;
- `TimerMachineEvent`;
- the internal start event accepted by `stepMachine()`.

Completion events use:

```ts
type ActionEvent = { type: string; output?: unknown };
type SystemEvent = { type: "FAILED"; error: unknown };
type ChartEvent = ActionEvent | SystemEvent;
```

## Execution loop

### `start()`

```ts
function start(
  runtime: import("@surprisal/hyperchart/runtime").Runtime,
  args?: Readonly<Record<string, unknown>>,
): Promise<MachineState>;
```

If the runtime log is empty and `args` is provided, writes the run arguments as the first fact, then calls `loop()`. Calling `start(runtime)` without `args` writes no argument fact. For an existing log, durable arguments win over the passed value.

### `loop()`

```ts
function loop(
  runtime: import("@surprisal/hyperchart/runtime").Runtime,
): Promise<MachineState>;
```

Loads AST and records, projects them, consumes the runtime event queue, and dispatches effects until final. It throws on machine errors or if the event queue closes before final.

## Durable records

```ts
type DurableLogRecord =
  | ArgsLog
  | SessionRefLog
  | SpawnedLog
  | StateActionInvokeLog
  | StateActionCompleteLog
  | StateActionValidatedLog
  | StateActionTimerFiredLog;
```

Every record carries:

```ts
{
  seqId: number;
  parentId: number | null;
  timestamp: number;
}
```

| Record | Durable fact |
|---|---|
| `args` | Run arguments. |
| `session_ref` | Persisted host session reference. |
| `spawned` | Pinned map keys and items. |
| `state_action/invoke` | Invocation plus action-definition provenance. |
| `state_action/complete` | Claimed completion event. |
| `state_action/validated` | Guard, event, and accepted/rejected verdict. |
| `state_action/timer_fired` | Deadline won the race. |

`StateActionInvokeLog` is exported separately because replay and integrations commonly need its `definition` provenance.

Transitions are not records. Projection recomputes routing from the current chart.

## Replay compatibility

### `explainReplay()`

```ts
function explainReplay(
  ast: ChartAst,
  log: readonly DurableLogRecord[],
): ReplayExplanation;
```

```ts
type ReplayExplanation = {
  prefixEnd: number;
  seqId?: number;
  broken?: ReplayBrokenRecord;
  skipped: readonly ReplaySkippedRecord[];
  stale: readonly ReplayStaleRecord[];
};
```

- `broken` means projection cannot structurally apply a record. Do not continue past it.
- `stale` means logged action or guard provenance differs from the current chart.
- `skipped` means a record applied as an inactive-state no-op. It can be a legitimate race loser or evidence that a chart edit changed traversal.
- `prefixEnd` is an array index boundary, not a durable seqId.

```ts
const replay = explainReplay(ast, records);
if (replay.broken) {
  console.error(replay.broken.seqId, replay.broken.error);
}
```

Supporting exports:

```ts
type ReplayBrokenRecord = {
  index: number;
  seqId: number;
  record: DurableLogRecord;
  error: string;
  state?: StatePath;
  invokeSeqId?: number;
};

type ReplayStaleRecord = {
  index: number;
  seqId: number;
  record: DurableLogRecord;
  state: StatePath;
  reason: "action_definition_changed" | "guard_changed";
  message: string;
  invokeSeqId?: number;
};
```

`ReplaySkippedRecord` extends `ProjectionSkippedRecord` with the record index and seqId.

## Async utilities

### `toAsyncIterable()`

```ts
function toAsyncIterable<T>(iterable: Iterable<T> | AsyncIterable<T>): AsyncIterable<T>;
```

### `concatAsyncIterables()`

```ts
function concatAsyncIterables<T>(
  ...iterables: Array<Iterable<T> | AsyncIterable<T>>
): AsyncIterable<T>;
```

Consumes each input sequentially.

### `createAsyncQueue()`

```ts
function createAsyncQueue<T>(): AsyncQueue<T>;

type AsyncQueue<T> = AsyncIterable<T> & {
  send(value: T): void;
  close(): void;
  readonly size: number;
};
```

The queue supports one consumer. Sending after close or issuing concurrent pending reads throws.

`MaybeAsyncIterable<T>` is `Iterable<T> | AsyncIterable<T>`.

## Complete non-DSL value export inventory

```text
start, loop
normalizeChartConfig, isReservedSystemEvent
ChartParseError, parseChartExport, parseChartModule, parseChartModuleAst
inspectChartAst, inspectChartModuleSync, parseChartModuleSync
hyperchartSource, hyperchartStateSources
createBranchProjection, projectBranch, isFinalState
createMachineOutput, stepMachine
explainReplay
concatAsyncIterables, createAsyncQueue, toAsyncIterable
```

The DSL values, `refs`, and `z` are listed in [DSL reference](dsl.md).

## Complete root type export inventory

The root entry point exports these type names:

```text
ActionEvent, ActionUID, ActionStateAst, ActionStateCst, AfterCst,
AgentActionAst, AgentActionCst, ArtifactAst, ArtifactCst,
ArtifactOfAst, ArtifactOfCst, AuthoringDiagnostic, ChartAst,
ChartCst, ChartEvent, ChartSource,
CompoundStateAst, CompoundStateCst, EventBindingAst, EventBindingCst,
EventType, FinalStateAst, FinalStateCst, InputRef, JoinArtifactOfAst,
JoinArtifactOfCst, JsonSchema, MapStateAst, MapStateCst,
SchemaAst, SchemaCst, ParallelStateAst, ParallelStateCst,
ParsedChart, RegionStateAst, ReservedSystemEventType, ScriptActionAst,
ScriptActionCst, StateActionAst, StateActionCst, StateAst, StateCst,
StateId, StatePath, SystemEvent, TemplateAst, TemplateCst, Templatable,
GuardOutcome, GuardRef, OnReject, OnReenterAst, OnReenterCst,
TransitionAst, TransitionCst, TransitionMapCst, UserActionAst,
UserActionCst, InputsOf, Paths, ValueAt,
HyperchartInspectAgentDefaults, HyperchartInspectArtifact,
HyperchartInspectBranch, HyperchartInspectEnv, HyperchartInspectGuard,
HyperchartInspectInput, HyperchartInspectOnReenter, HyperchartInspectRef,
HyperchartInspectResult, HyperchartInspectState,
HyperchartInspectTransition, InspectChartModuleOptions,
ParseChartModuleOptions, ActionEffect, AgentEffect, AgentMachineEvent,
CancelEffect,
DurableRecordsAddedMachineEvent, DurableRecordsEffect, Effect,
RecordAppend, RejectedEffect, ResumeRequest, ScriptEffect,
ScriptMachineEvent, TimerEffect, TimerMachineEvent, ValidateEffect,
ValidatedMachineEvent, EffectId, MachineEvent, MachineStartEvent, MachineOutput,
MachineOutputEffect, MachineOutputError, MachineOutputFinal,
MachineState, RenderedArtifact, UserEffect,
UserMachineEvent, DurableLogRecord, StateActionInvokeLog,
ReplayBrokenRecord, ReplayExplanation, ReplaySkippedRecord,
ReplayStaleRecord, BranchProjection, PendingAction,
ProjectionSkippedRecord, AsyncQueue, MaybeAsyncIterable
```
