# Runtime API

Import the generic runtime from `@surprisal-io/hyperchart/runtime`:

```ts
import {
  ChartRuntime,
  JsonlLogStore,
  MemoryLogStore,
  ScriptRunner,
  checkArtifactFile,
  checkSchema,
  createRunDir,
  finalMachineFailureMessage,
  isFailureStatePath,
  loadRunMeta,
  resolveArtifactValue,
  runGuard,
  saveRunMeta,
  serializeEnvValue,
  terminalStateForFinalMachine,
  type AgentExecutor,
  type GuardContext,
  type RenderedArtifact,
  type Runtime,
  type SchemaCheck,
} from "@surprisal-io/hyperchart/runtime";
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
import { loop } from "@surprisal-io/hyperchart";
import { ChartRuntime, JsonlLogStore } from "@surprisal-io/hyperchart/runtime";

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
  constructor(options: { workDir: string });
  run(
    effect: ScriptEffect,
    validationAttempt?: { n: number; reason?: string },
  ): Promise<ChartEvent>;
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

`cancel()` sends `SIGTERM`, then schedules `SIGKILL` after five seconds if needed.

## Guards

### `runGuard()`

```ts
type GuardContext = { chartDir: string; workDir: string };

function runGuard(
  guard: GuardRef,
  event: ChartEvent,
  context: GuardContext,
): Promise<GuardOutcome>;
```

For `tsImport` guards:

- relative modules resolve from `chartDir`;
- package specifiers are imported directly;
- the named export must be a function;
- the function receives the full chart event;
- the result must be `boolean` or `{ ok: false, reason: string }`.

For script guards:

- the process runs in `workDir`;
- the chart event is JSON on stdin;
- stdout is ignored;
- exit 0 accepts;
- non-zero rejects using trimmed stderr or the exit status as reason.

The function throws for import failures, missing exports, process-spawn failures, and invalid TypeScript-guard return values.

## Schema validation

### `checkSchema()`

```ts
type SchemaCheck = { ok: true } | { ok: false; errors: string[] };

function checkSchema(
  schema: SchemaAst,
  value: unknown,
): SchemaCheck;
```

Validates against the normalized JSON Schema using TypeBox. It returns at most ten validation errors and converts validator exceptions into an unsuccessful result.

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
): Promise<unknown>;
```

- resolves `artifact.path` inside `workDir`;
- rejects paths escaping `workDir`;
- returns raw UTF-8 text when neither `shape` nor `select` is present;
- otherwise parses JSON;
- validates the full parsed value when `shape` exists;
- returns the selected dot-path when `select` exists.

It throws for unreadable files, invalid JSON, schema mismatch, and unresolved selectors.

### `checkArtifactFile()`

```ts
function checkArtifactFile(
  artifact: RenderedArtifact,
  workDir: string,
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
RenderedArtifact, GuardContext, SchemaCheck
ChartRuntime, ChartRuntimeOptions
LogStore, JsonlLogStore, MemoryLogStore
ScriptRunner
checkArtifactFile, resolveArtifactValue, serializeEnvValue
runGuard, checkSchema
createRunDir, loadRunMeta, saveRunMeta, RunMeta
terminalStateForFinalMachine, finalMachineFailureMessage,
isFailureStatePath, RunTerminalState
```
