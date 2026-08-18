# Runtime API

Import the generic runtime from `@surprisal/hyperchart/runtime`:

```ts
import {
  ChartRuntime,
  FileUserExecutor,
  JsonlLogStore,
  MemoryLogStore,
  ScriptRunner,
  checkArtifactFile,
  checkSchema,
  checkSchemaAsync,
  createAgentDefaultsResolver,
  createRunDir,
  finalMachineFailureMessage,
  loadRunMeta,
  resolveAgentDefaults,
  resolveArtifactValue,
  runGuard,
  saveRunMeta,
  serializeEnvValue,
  terminalStateForFinalMachine,
  type AgentDefinitionResolution,
  type AgentExecutor,
  type UserExecutor,
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

`runEffects()` must arrange for every non-terminal effect except best-effort `cancel` to eventually produce the corresponding machine event. Effects are consumed in the supplied list order. Durable records must be appended before emitting `durable_records_added`; when one batch contains multiple `durable_records` effects, both appends and acknowledgements must preserve that order.

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
  userExecutor?: UserExecutor;
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
- a pluggable agent executor;
- a pluggable user executor for durable host-mediated input.

Detached runners provide `FileUserExecutor`. A custom in-process runtime that can reach `user()` must also provide a `UserExecutor`; without one, `ChartRuntime` throws when the user effect is dispatched rather than inventing an answer.

`dispose()` is idempotent and begins by refusing new effects and callbacks. It clears timers, concurrently disposes script, agent, and user executors, drains effect preparation and completion-admission work already in flight, then closes the event queue. Cleanup failures are reported only after every component and tracked continuation has had a chance to quiesce. `FileUserExecutor` preserves unanswered mailbox requests while waiting for any active response validation to finish.

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

## In-process runner controller

`createHyperchartRunnerController()` prepares one parsed chart and shared journal, reserves the configured `branchId` or `branchIds` as initial seeds, and returns before launching them. `start()` launches those seeds only after their all-initial replay barrier and resolves when the aggregate runner terminates. `runHyperchartRunner()` is the compatibility wrapper that creates the controller and awaits `start()`. Signal shutdown waits for every branch disposal; cleanup failures are recorded in stopped status while the process still uses the signal-derived exit code.

```ts
const controller = await createHyperchartRunnerController(config, buildExecutor);
const completion = controller.start();

const fork = controller.forkBranch({
  branchId: "experiment",
  sourceBranchId: "main",
  fromSeqId: 42,
}); // durable head only; no runtime starts

const outcome = await controller.startBranch(fork.branchId); // explicit admission
await completion;
```

`startBranch()` synchronously reserves a durable branch before its replay gate or executor construction, then returns a promise for that branch's `complete` or `failed` outcome. Each admitted branch owns a branch-scoped executor, user executor, and runtime. Dynamic branches replay-gate independently; a gate/setup failure builds no runtime, contributes a failed aggregate outcome, and does not stop siblings. Duplicate attempt admission is rejected.

`liveBranchIds` and status-v2 `branchIds` are current live reservations, not durable branch selection. Forking does not add a reservation. The final reservation is removed only after disposal, terminal notification persistence publishes `branchIds: []`, and the controller rejects fork/admission after it begins closing. Keep an existing reservation live while admitting more work; there is intentionally no filesystem, Pi-command, or MCP control plane for dynamic admission.

## `UserExecutor` and `FileUserExecutor`

```ts
interface UserExecutor {
  start(effect: UserEffect, emit: EmitCompletion): void;
  reject(effect: RejectedEffect, emit: EmitCompletion): void;
  cancel(actionUid: ActionUID): void;
  dispose(): Promise<void>;
}

new FileUserExecutor({
  runId,
  runDir,
  pollMs?: number,
  schemaRegistry?: SchemaRegistryLike,
  onWarn?: (message: string) => void,
});
```

`FileUserExecutor` is the durable rendezvous used by detached runners. `start()` persists or reuses `user-interactions/<seqId>/request.json`, polls for a response resolution, validates it, and emits the resulting chart event exactly once to the normal action-completion path. `reject()` creates the next durable phase with its own `seqId` and rejection metadata. Its referenced poll interval keeps the runner alive even when every active branch is waiting for human input; other parallel/map work remains runnable.

`cancel()` writes a close resolution for a phase abandoned by the machine, so a timeout or competing completion cannot be answered later. `dispose()` stops local polling but deliberately preserves open requests: an operator stop and later resume reuses the mailbox. Restart also consumes a response that was persisted before its completion reached `log.jsonl`.

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
  constructor(filePath: string, onWarn?: (message: string) => void, branchId?: string);
  readonly filePath: string;
  readonly branchId: string;
  appendDrafts(records: readonly DurableRecordDraft[]): readonly DurableLogRecord[];
  forBranch(branchId: string): JsonlLogStore;
  snapshot(): NormalizedRunLog;
  readAll(): Promise<readonly DurableLogRecord[]>;
  fullReadCount(): number;
}
```

- `forBranch()` creates explicit branch handles over one opened journal; independent readers reopen independently;
- repairs an incomplete final mutation and fully validates the v2 journal once at open;
- allocates global ids and appends only each new mutation under the writer lock;
- incrementally publishes snapshots sharing the record index and ancestry pointers, without rereading on append/snapshot;
- returns only the selected branch ancestry from `readAll()`; public singleton use defaults to `main`.

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
  sourceState?: string; // producer for artifact-backed reads
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
  originSessionId?: string;
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

Returns `failed` when durable global failure intent exists or any active terminal leaf has `outcome: "failed"`; otherwise returns `complete`. This includes failed leaves in completed parallel regions. Terminal names do not infer run outcome.

### `finalMachineFailureMessage()`

```ts
function finalMachineFailureMessage(
  state: MachineState,
  log: readonly DurableLogRecord[],
): string | undefined;
```

For global failure, returns the error stored on durable `failure_intent` (structured payloads are JSON-stringified). For an authored failed terminal without global failure, it describes the reached terminal. It returns `undefined` for complete terminals.

## User-interaction mailbox

Each user phase is stored under its run directory:

```text
user-interactions/<seqId>/
├── request.json
├── resolution.json
└── receipts/
```

`request.json` is versioned and persist-once. It contains the public `(runId, branchId, seqId)` coordinate, rendered prompt, allowed events/options, optional reply contract, machine action identity, and rejection metadata. Runtime `effectId` values never cross this boundary, and there is no second request/gate identifier. Hosts accept `{ runId, branchId, seqId, event: "APPROVED", output? }`; `resolution.json` stores that as an atomically published immutable union with a normalized chart event `{ type, output? }`, or stores a close marker. Response and close therefore race for one winner. Malformed, mismatched, or foreign files are isolated and do not become active requests.

Host scans require an exact `originSessionId` and canonical `workDir`. All open requests are persisted immediately, but one presentation boundary is selected across the runs root for each `host + session + workDir`. A confirmed or claimed live request stays pinned; otherwise selection is lexical `runId`, then branch id and numeric `seqId`. This serializes simultaneous gates from parallel/map branches and separate runs without blocking their execution.

`validateAndPersistUserInteractionResponse()` requires the exact active `(runId, branchId, seqId)`, an allowed non-`FAILED` event, and schema-valid output when a reply contract exists. Identical retries return idempotently; divergent responses conflict. Receipt claims and confirmations provide recoverable, at-least-once presentation without making presentation itself a semantic log fact; internal `.published` sidecars make immutable receipt publication order stable for cross-process arbitration. Key helpers include `persistUserInteractionRequest()`, `scanOpenUserInteractions()`, `scanOwnedOpenUserInteractions()`, `acquireActiveUserInteraction()`, `claimUserInteractionReceipt()`, `markUserInteractionReceipt()`, `validateAndPersistUserInteractionResponse()`, and `closeUserInteraction()`.

Rewind never moves this directory. Global ids are never reused, and only the exact live runner branch accepts a response; sibling gates remain inspectable.

## Terminal notification outbox

The runner persists `terminal-notification/request.json` before changing `status.json` to `complete` or `failed`. A request is deliverable only when its payload outcome exactly matches terminal status. Every newly created outbox request has a fresh UUID and records the host-generated runner-attempt identity from `status.json`. When a stopped or terminal run is started again, status opens a fresh attempt identity before the runner moves the previous outbox (including receipts) under `terminal-notification-history/`; the new attempt can then publish and deliver its own outcome without conflicting with an earlier failure. If the runner dies before that archival step, stale recovery detects the attempt mismatch, archives the predecessor, and publishes failure for the current attempt instead of inheriting the old outcome. Rewind does not move or delete an outbox; branch identity in payload and status prevents sibling delivery.

Delivery uses a recoverable per-host/session claim and a separate confirmed receipt under a request-hashed generation directory. Claims and confirmations require the caller's observed `requestId`; a host holding an archived generation can neither claim, overwrite a replacement's receipt, nor accidentally confirm it. Pi sends first, then confirms; if confirmation is interrupted, the persisted Pi custom message `requestId` supplies the acknowledgement during recovery. Claude's monitor writes one JSON notification per physical stdout line, then confirms. Claude exposes no host acknowledgement after stdout, so delivery is **at least once**: a crash after the line is written but before confirmation can cause a duplicate after the stale claim lease expires. A crash before stdout never permanently suppresses delivery.

Key helpers are:

- `archiveTerminalNotificationGeneration()` — retire a previous attempt's outbox after status becomes non-terminal;
- `persistTerminalNotificationRequest()` — persist once and fail on a divergent payload within one runner attempt;
- `readDeliverableTerminalNotificationRequest()` — require matching terminal status;
- `claimTerminalNotificationReceipt()` / `markTerminalNotificationReceipt()` / `hasTerminalNotificationReceipt()` — request-id-fenced, leased per-session delivery arbitration and confirmation;
- `recoverStaleRunTerminalNotification()` — fail a stale dead runner, preserving an already-written outbox and its error;
- `removeTerminalNotificationOutbox()` — cleanup used by rewind.

Notification artifact entries are authoritative absolute paths under `workDir`; file contents are never copied into the prompt.

## Complete export inventory

```text
Runtime
AgentExecutor, EmitCompletion
UserExecutor, FileUserExecutor, FileUserExecutorOptions
AgentDefinition, AgentDefinitionResolution, ThinkingLevel,
createAgentDefaultsResolver, resolveAgentDefaults, loadAgentDefinition, parseAgentFile
RenderedArtifact, GuardContext, RenderedGuardInvocation, SchemaCheck, SchemaRegistry, SchemaRegistryLike
ChartRuntime, ChartRuntimeOptions
USER_INTERACTIONS_DIR, USER_INTERACTION_ARBITER_DIR,
USER_INTERACTION_CLAIM_LEASE_MS, USER_INTERACTION_WAIT_LEASE_MS,
USER_INTERACTION_REQUEST,
USER_INTERACTION_RESOLUTION, USER_INTERACTION_RESPONSE, USER_INTERACTION_CLOSE,
UserInteractionCoordinate, UserInteractionOwner, UserInteractionRequest,
UserInteractionResponse, UserInteractionClose, UserInteractionResolution,
UserInteractionReceipt, UserInteractionArbiterRecord, OwnedUserInteraction,
PersistUserInteractionRequestInput, PersistUserInteractionResponseOptions,
userInteractionDir, userInteractionRequestPath, userInteractionResolutionPath,
userInteractionResponsePath, userInteractionClosePath, userInteractionReceiptPath,
userInteractionArbiterPath, persistUserInteractionRequest,
readUserInteractionRequest, readOpenUserInteractionRequest,
readUserInteractionResponse, readUserInteractionClose, readUserInteractionResolution,
scanOpenUserInteractions, scanOwnedOpenUserInteractions, acquireActiveUserInteraction,
readActiveUserInteraction, releaseActiveUserInteraction,
claimUserInteractionReceipt, markUserInteractionReceipt, hasUserInteractionReceipt,
readUserInteractionReceipt, removeUserInteractionReceipt, validateUserInteractionEvent,
validateAndPersistUserInteractionResponse, closeUserInteraction
LogStore, JsonlLogStore, MemoryLogStore
ScriptRunner
checkArtifactFile, resolveArtifactValue, serializeEnvValue
runGuard, checkSchema, checkSchemaAsync
createRunDir, loadRunMeta, saveRunMeta, RunMeta
terminalStateForFinalMachine, finalMachineFailureMessage, RunTerminalState
archiveTerminalNotificationGeneration, persistTerminalNotificationRequest,
readTerminalNotificationRequest,
readDeliverableTerminalNotificationRequest, recoverStaleRunTerminalNotification,
claimTerminalNotificationReceipt, markTerminalNotificationReceipt,
hasTerminalNotificationReceipt, removeTerminalNotificationReceipt,
removeTerminalNotificationOutbox, TerminalNotificationPayload,
TerminalNotificationRequest, TerminalNotificationReceipt
```

## Actor pool runtime behavior

Runtime adapters execute the same `actor_create`, `actor_enqueue`, and `actor_reply` effect kinds for ordinary actors and pools. The core scheduler may choose any idle, receive-compatible pool worker and emits that choice as an accepted fact before worker workflow invocation. Hosts must append each `durable_records` effect atomically and acknowledge multiple effects in their supplied order. Until an accepted append is projected, the machine keeps an ordered reservation for that pool so the message is virtually dequeued and the chosen worker virtually occupied; ordinary actors and unrelated pools continue independently. On restart, load the complete log and let projection restore endpoint generations, worker ownership, partial batches, and drain state—never reconstruct or reassign from external worker sessions. Global failure best-effort cancels pending concrete worker actions.

## Named branch storage API

`JsonlLogStore.read()` returns one normalized full tree and durable branch registry; `readAll()` returns only the store's explicit selected branch ancestry. `appendDrafts()` numbers from the full journal and appends from that durable head. `listHyperchartBranches()`, `getHyperchartBranch()`, `forkHyperchartRun()`, and `rewindHyperchartRun()` expose named heads. Fork does not select/start. Rewind is a stopped-only append-only move and has no cleanup/backup options.
