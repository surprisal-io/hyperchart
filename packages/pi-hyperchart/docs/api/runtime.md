# Runtime API

Import the generic runtime from `@surprisal/hyperchart/runtime`:

```ts
import {
  ChartRuntime,
  JsonlLogStore,
  MemoryLogStore,
  ScriptRunner,
  checkArtifactFile,
  checkSchema,
  checkSchemaAsync,
  createAgentDefaultsResolver,
  createRunDir,
  finalMachineFailureMessage,
  isFailureStatePath,
  loadRunMeta,
  resolveAgentDefaults,
  resolveArtifactValue,
  runGuard,
  saveRunMeta,
  serializeEnvValue,
  terminalStateForFinalMachine,
  type AgentDefinitionResolution,
  type AgentExecutor,
  type GuardContext,
  type RenderedGuardInvocation,
  type RenderedArtifact,
  type Runtime,
  type SchemaCheck,
  SchemaRegistry,
  type SchemaRegistryLike,
} from "@surprisal/hyperchart/runtime";
```

## `Runtime`

```ts
interface Runtime {
  runEffects(effects: Effect[]): void;
  eventsQueue(): AsyncIterable<MachineEvent>;
  loadAst(): Promise<ChartAst>;
  loadLogs(): Promise<readonly DurableLogRecord[]>;
}
```

The core execution loop owns machine semantics. A runtime interprets effects, returns machine events, and supplies chart and log data.

`runEffects()` must arrange for every non-terminal effect to eventually produce the corresponding machine event or cancellation outcome. Durable records must be appended before emitting `durable_records_added`.

## `ChartRuntime`

```ts
class ChartRuntime implements Runtime {
  constructor(options: ChartRuntimeOptions);
  runEffects(effects: Effect[]): void;
  eventsQueue(): AsyncIterable<MachineEvent>;
  loadAst(): Promise<ChartAst>;
  loadLogs(): Promise<readonly DurableLogRecord[]>;
  dispose(): Promise<void>;
}

type ChartRuntimeOptions = {
  ast: ChartAst;
  logStore: LogStore;
  agentExecutor: AgentExecutor;
  workDir: string;
  chartDir: string;
  schemaRegistry?: SchemaRegistryLike;
  now?: () => number;
  onWarn?: (message: string) => void;
};
```

`ChartRuntime` provides:

- JSONL or custom durable logging;
- generic script execution;
- TypeScript and script guards;
- timers and cancellation;
- validation rejection dispatch;
- a pluggable agent executor.

It does not implement user actions. A `user` effect calls `onWarn` and remains unresolved.

```ts
import { loop } from "@surprisal/hyperchart";
import { ChartRuntime, JsonlLogStore } from "@surprisal/hyperchart/runtime";

const runtime = new ChartRuntime({
  ast,
  logStore: new JsonlLogStore(".hyperchart/runs/demo/log.jsonl"),
  agentExecutor,
  workDir: process.cwd(),
  chartDir: new URL(".", import.meta.url).pathname,
});

try {
  await loop(runtime);
} finally {
  await runtime.dispose();
}
```

## `AgentExecutor`

```ts
type EmitCompletion = (event: ChartEvent) => void;

interface AgentExecutor {
  start(effect: AgentEffect, emit: EmitCompletion): void;
  reject(effect: RejectedEffect, emit: EmitCompletion): void;
  cancel(actionUid: ActionUID): void;
  dispose(): Promise<void>;
}
```

| Method | Contract |
|---|---|
| `start` | Start the rendered invocation. Call `emit()` with exactly one current completion claim. |
| `reject` | Apply `effect.onReject` using the rendered original invocation and rejection context, then call `emit()` with the next claim. |
| `cancel` | Stop live work identified by the concrete action UID. |
| `dispose` | Release sessions, processes, and other resources owned by the executor. |

The executor must not append Hyperchart durable facts directly. It reports chart events; the machine decides what becomes durable.

## Agent definition inspection

```ts
type AgentDefinitionResolution = {
  defaultModel?: string;
  modelRoles?: Readonly<Record<string, string>>;
  toolsets?: Readonly<Record<string, readonly string[]>>;
};

function createAgentDefaultsResolver(
  dirs: string[],
  parse?: FrontmatterParser,
  resolution?: AgentDefinitionResolution,
): (agentName: string) => HyperchartInspectAgentDefaults;

function resolveAgentDefaults(
  defaults: HyperchartInspectAgentDefaults,
  resolution: AgentDefinitionResolution,
): HyperchartInspectAgentDefaults;
```

`createAgentDefaultsResolver()` loads markdown definitions, preserves declared `role`/`toolset` plus model/tool fallbacks, and computes `resolvedModel`/`resolvedTools` from the supplied host mappings. Explicit resolved tool lists include the injected `finish` protocol tool. `resolveAgentDefaults()` reapplies another immutable mapping snapshot, which run-directory inspection uses for `runner.config.json` settings.

These helpers describe inspection configuration. Runtime launch strictness and chart-level override precedence remain owned by `buildSessionPlan()`.

## Log stores

### `LogStore`

```ts
interface LogStore {
  append(records: readonly DurableLogRecord[]): void;
  readAll(): Promise<readonly DurableLogRecord[]>;
}
```

`append()` is synchronous because `ChartRuntime` acknowledges records immediately after calling it. A custom implementation must not acknowledge data before it is durably written.

### `JsonlLogStore`

```ts
class JsonlLogStore implements LogStore {
  constructor(filePath: string, onWarn?: (message: string) => void);
  readonly filePath: string;
  append(records: readonly DurableLogRecord[]): void;
  readAll(): Promise<readonly DurableLogRecord[]>;
}
```

- creates the parent directory on append;
- writes one JSON object per line;
- ignores an incomplete final line and calls `onWarn`;
- throws for malformed JSON before the final line.

```ts
const store = new JsonlLogStore("/absolute/run/log.jsonl", console.warn);
const records = await store.readAll();
```

### `MemoryLogStore`

```ts
class MemoryLogStore implements LogStore {
  constructor(records?: readonly DurableLogRecord[]);
  append(records: readonly DurableLogRecord[]): void;
  readAll(): Promise<readonly DurableLogRecord[]>;
}
```

The constructor and `readAll()` copy their arrays. Use this store for tests and ephemeral execution.

## Script execution

### `ScriptRunner`

```ts
class ScriptRunner {
  constructor(options: { workDir: string; schemaRegistry?: SchemaRegistryLike; killGraceMs?: number });
  run(
    effect: ScriptEffect,
    validationAttempt?: { n: number; reason?: string },
  ): Promise<ChartEvent>;
  runGuard(
    guard: Extract<GuardRefAst, { kind: "script" }>,
    event: ChartEvent,
    renderedEnv?: Readonly<Record<string, string | RenderedArtifact>>,
    artifacts?: readonly RenderedArtifact[],
    reply?: SchemaAst,
    actionUid?: ActionUID,
  ): Promise<GuardOutcome>;
  cancel(actionUid: ActionUID): void;
  dispose(): Promise<void>;
}
```

`run()`:

1. resolves declared environment values;
2. spawns `command` with static `args` in `workDir`;
3. captures stdout and stderr;
4. maps a non-zero exit to `FAILED`;
5. reads the last non-empty stdout line as a JSON completion envelope when present;
6. validates the event type, reply schema, and declared artifacts.

Completion envelope:

```json
{"type":"DONE","output":{"count":3}}
```

If there is exactly one reachable non-`FAILED` event, exit 0 without an envelope emits that event. Otherwise the result is `FAILED` with an ambiguity error.

On a validation retry, the runner adds:

```text
HYPERCHART_VALIDATION_ATTEMPT=<1-based rejection count>
HYPERCHART_REJECT_REASON=<reason, when present>
```

`cancel()` sends `SIGTERM`, then schedules `SIGKILL` after `killGraceMs` (default five seconds) if needed.

## Guards

### `runGuard()`

```ts
type GuardContext = Readonly<{
  chartDir: string;
  workDir: string;
}>;

type RenderedGuardInvocation = Readonly<{
  scripts?: ScriptRunner;
  env?: Readonly<Record<string, string | RenderedArtifact>>;
  artifacts?: readonly RenderedArtifact[];
  reply?: SchemaAst;
  actionUid?: ActionUID;
}>;

function runGuard(
  guard: GuardRefAst,
  event: ChartEvent,
  context: GuardContext,
  invocation?: RenderedGuardInvocation,
): Promise<GuardOutcome>;
```

For `tsImport` guards:

- relative modules resolve from `chartDir`;
- package specifiers are imported directly;
- the named export must be a function;
- the function receives `(event, context)`; existing one-argument guards remain valid;
- the context contains only `chartDir` and `workDir`; dynamic values belong in a script guard's `env`;
- the result must be `boolean` or `{ ok: false, reason: string }`.

For script guards:

- simple static guards can be called directly; guards carrying `env`, `artifacts`, or `reply` must receive a `RenderedGuardInvocation` from ChartRuntime or fail with an actionable error;
- the process runs in `workDir`;
- stdin is the unchanged plain ChartEvent root object (`type`, `output`, or `error`); no guard-only artifacts field is added;
- dynamic env values use the same rendered script-action contract, including the validating action's own `artifactOf` and joined path refs;
- selected artifact reads resolve through the shared env resolver, including chart-scoped runtime-contract validation, failing closed when an exact contract is unavailable;
- when no `reply` is declared, stdout is ignored; when `reply` is declared, the last completion envelope is validated with the shared script reply checker;
- declared guard artifacts are checked with the shared artifact checker after exit;
- exit 0 accepts only after reply/artifact checks pass;
- non-zero rejects using trimmed stderr or the exit status as reason.

Guard env and artifacts are resolved only while a completion is pending validation. Reply output is validation-only, guard artifact declarations remain part of AST/provenance and the containing state's Files surface, and accepted durable verdicts are replayed without re-running the guard.

The function throws for import failures, missing exports, process-spawn failures, and invalid TypeScript-guard return values.

## Schema validation

### `checkSchema()`

```ts
type SchemaCheck = { ok: true } | { ok: false; errors: string[] };

function checkSchema(
  schema: SchemaAst,
  value: unknown,
  registry?: SchemaRegistryLike,
): SchemaCheck;

function checkSchemaAsync(
  schema: SchemaAst,
  value: unknown,
  registry?: SchemaRegistryLike,
): Promise<SchemaCheck>;
```

For ordinary schemas, validates against the normalized JSON Schema using TypeBox. For a `runtimeContract`, synchronous callers may validate only synchronous refinements; use `checkSchemaAsync` for exact validation. Contract metadata without its chart-scoped registry fails closed and never falls back to JSON Schema. Results retain original input values; Zod transform outputs are not substituted into the workflow.

```ts
const checked = checkSchema(schema, value);
if (!checked.ok) console.error(checked.errors);
```

## Artifact utilities

`RenderedArtifact` is exported by both the root and runtime entry points:

```ts
type RenderedArtifact = {
  name?: string;
  path: string;
  shape?: SchemaAst;
  select?: string;
};
```

### `resolveArtifactValue()`

```ts
function resolveArtifactValue(
  artifact: RenderedArtifact,
  workDir: string,
  registry?: SchemaRegistryLike,
): Promise<unknown>;
```

- resolves `artifact.path` inside `workDir`;
- rejects paths escaping `workDir`;
- returns raw UTF-8 text when neither `shape` nor `select` is present;
- otherwise parses JSON;
- validates the full parsed value when `shape` exists, including the original runtime Zod contract when one is declared;
- returns the selected dot-path when `select` exists.

Guard env resolution uses this resolver for selected `artifactOf()` reads; declared guard output artifacts are checked with `checkArtifactFile()` after exit. Duplicate or missing artifact names fail closed.

It throws for unreadable files, invalid JSON, schema mismatch, and unresolved selectors.

### `checkArtifactFile()`

```ts
function checkArtifactFile(
  artifact: RenderedArtifact,
  workDir: string,
  registry?: SchemaRegistryLike,
): Promise<{ ok: true } | { ok: false; errors: string[] }>;
```

Checks containment and readability. If a shape is declared, it also parses and validates JSON. It returns errors instead of throwing.

### `serializeEnvValue()`

```ts
function serializeEnvValue(value: unknown): string;
```

Returns strings unchanged and serializes every other value with `JSON.stringify()`. It throws `Environment value is not JSON-serializable` when serialization produces no string, including `undefined`, functions, and symbols.

## Run directories

### `createRunDir()`

```ts
function createRunDir(
  workDir: string,
  chartId: string,
  options?: { rootDir?: string },
): string;
```

Creates a unique directory and its `sessions/` child. The default root is `<workDir>/.hyperchart/runs`; hosts can supply another root.

Directory names use the sanitized chart id, local timestamp, and a numeric collision suffix when needed.

### `RunMeta`

```ts
type RunMeta = {
  chartPath: string;
  exportName?: string;
  workDir: string;
  chartId: string;
  createdAt: string;
};
```

### `saveRunMeta()`

```ts
function saveRunMeta(runDir: string, meta: RunMeta): void;
```

Writes formatted `meta.json` and ensures `sessions/` exists.

### `loadRunMeta()`

```ts
function loadRunMeta(runDir: string): RunMeta;
```

Reads `meta.json` and resolves `chartPath` and `workDir` to absolute paths. It throws for missing or malformed metadata.

## Terminal outcome helpers

### `RunTerminalState`

```ts
type RunTerminalState = "complete" | "failed";
```

### `terminalStateForFinalMachine()`

```ts
function terminalStateForFinalMachine(
  state: MachineState,
  log: readonly DurableLogRecord[],
): RunTerminalState;
```

Returns `failed` if an active final leaf is named as a failure state or the latest completion event is `FAILED`; otherwise returns `complete`.

### `finalMachineFailureMessage()`

```ts
function finalMachineFailureMessage(
  state: MachineState,
  log: readonly DurableLogRecord[],
): string | undefined;
```

Returns the latest `FAILED` error payload when present, otherwise describes the reached failure final state.

### `isFailureStatePath()`

```ts
function isFailureStatePath(path: string): boolean;
```

Checks whether the final template segment, ignoring a map key, is `failed`, `failure`, or `error` case-insensitively.

## Complete export inventory

```text
Runtime
AgentExecutor, EmitCompletion
AgentDefinition, AgentDefinitionResolution, ThinkingLevel,
createAgentDefaultsResolver, resolveAgentDefaults, loadAgentDefinition, parseAgentFile
RenderedArtifact, GuardContext, RenderedGuardInvocation, SchemaCheck, SchemaRegistry, SchemaRegistryLike
ChartRuntime, ChartRuntimeOptions
LogStore, JsonlLogStore, MemoryLogStore
ScriptRunner
checkArtifactFile, resolveArtifactValue, serializeEnvValue
runGuard, checkSchema, checkSchemaAsync
createRunDir, loadRunMeta, saveRunMeta, RunMeta
terminalStateForFinalMachine, finalMachineFailureMessage,
isFailureStatePath, RunTerminalState
```
