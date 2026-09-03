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
  deleteRunStorage,
  loadRunMeta,
  resolveAgentDefaults,
  resolveArtifactValue,
  runGuard,
  saveRunMeta,
  serializeEnvValue,
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
  readonly branchId: BranchId;
  runEffects(effects: Effect[]): Promise<void>;
  eventsQueue(): AsyncIterable<MachineEvent>;
  beginDrain?(): void;
  dispose?(): Promise<void>;
}
```

The internal execution layer owns machine semantics, projection restoration, replay diagnostics, retention, and checkpoint cadence. A runtime only interprets effects, returns machine events, and performs durable I/O. Runtime and storage never receive `BranchProjection` or interpret a checkpoint blob.

`runEffects()` must arrange for every non-terminal effect except best-effort `cancel` to eventually produce the corresponding machine event. Effects are consumed in the supplied list order. Each `durable_records` effect is one indivisible storage commit: append every record in that effect together or append none, and never split it into multiple commits. Durable records must be committed before emitting `durable_records_added`; when one machine output contains multiple `durable_records` effects, each effect remains a separate atomic unit and both commits and acknowledgements preserve their supplied order.

## `ChartRuntime`

```ts
class ChartRuntime implements Runtime {
  constructor(options: ChartRuntimeOptions);
  runEffects(effects: Effect[]): void;
  eventsQueue(): AsyncIterable<MachineEvent>;
  beginDrain(): void;
  dispose(): Promise<void>;
}

type ChartRuntimeOptions = {
  ast: ChartAst; // authored effect schemas/rendering only
  logStore: LogStore & CheckpointRepository;
  prepareStampedCommit?: PrepareStampedCommit; // opaque execution callback
  validateArtifactSnapshot?: ValidateArtifactSnapshot; // execution semantic callback
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
- a pluggable agent executor;
- journal-native durable user gates.

User actions do not dispatch an executor. The machine appends a rendered `user_interaction/opened` fact and waits. For a live run, the typed runner-control API sends the answer to the detached runtime that already owns the journal; that sole writer appends `user_interaction/resolved` and acknowledges the committed record directly to its machine. A stopped run temporarily opens the same writer API and consumes the fact on later replay. Storage is not an event bus and `LogStore` has no subscription/watch contract.

`dispose()` is idempotent and begins by refusing new effects and callbacks. It clears timers, disposes script and agent executors, drains effect preparation and completion-admission work already in flight, then closes the event queue.

`ChartRuntime` is composed by the runner with an internal execution-owned branch session. Direct callers do not load or pass projections. The only execution hook visible to runtime is a synchronous `PrepareStampedCommit` callback that receives storage-stamped facts and returns opaque checkpoint envelopes plus a post-commit confirmation.

## In-process runner controller

`createHyperchartRunnerController()` prepares one parsed chart and shared journal, reserves the configured `branchId` or `branchIds` as initial seeds, and returns before launching them. `start()` launches those seeds only after their all-initial replay barrier and resolves when the aggregate runner terminates. `runHyperchartRunner()` is the compatibility wrapper that creates the controller and awaits `start()`. Signal shutdown waits for every branch disposal; cleanup failures are recorded in stopped status while the process still uses the signal-derived exit code.

```ts
const controller = await createHyperchartRunnerController(config, buildExecutor);
const completion = controller.start();

const fork = await controller.forkBranch({
  branchId: "experiment",
  sourceBranchId: "main",
  fromSeqId: 42,
}); // durable head only; no runtime starts

const outcome = await controller.startBranch(fork.branchId); // explicit admission
await completion;
```

`startBranch()` verifies the controller's compact durable-branch set, reserves the branch before its replay gate or executor construction, then resolves with that branch's `complete`, `failed`, or externally `drained` outcome. Each admitted branch owns a branch-scoped agent executor and runtime. Dynamic branches replay-gate independently; a gate/setup failure builds no runtime, contributes a failed aggregate outcome, and does not stop siblings. Duplicate attempt admission is rejected.

`stopAndDrain(branchId)` operates only on a branch currently live in the same started controller attempt. It synchronously makes that reservation non-runnable, starts runtime disposal so late callbacks are rejected, and resolves only after branch setup, runtime execution, completion admission, durable appends already in flight, and executor/script disposal have settled. The durable branch head is unchanged and sibling reservations keep running. Concurrent calls while the same drain is pending return the same promise. The corresponding `startBranch()` promise resolves with `outcome: "drained"`; cleanup failure produces a failed branch outcome. A drained branch remains admitted for this runner attempt and cannot yet be restarted without creating a new controller attempt.

`await durableBranchIds()` returns the controller's compact durable-branch set, including branches that are not admitted in this attempt. `liveBranchIds` and status-v2 `branchIds` are current live reservations, not durable branch selection; a branch remains listed while `stopAndDrain()` is still disposing it and disappears only at the drain boundary. `await activeBranchIds()` queries only each live branch head and excludes draining reservations and branches suspended at a journal-native open user gate, so an external scheduler can bound actual execution without counting idle decision points. Forking adds the durable branch to the compact set but does not add a live reservation. A naturally terminal reservation is removed only after disposal, terminal notification persistence publishes `branchIds: []`, and the controller rejects fork/admission after it begins closing. Keep an existing reservation live while admitting more work; there is intentionally no filesystem, Pi-command, or MCP control plane for dynamic admission.

## Journal-native user input

Execution restores the selected branch state and validates the response, then calls generic `appendDraftsAtHead()` with an expected branch head and an opaque prepare/confirm callback. Storage knows neither gates nor projection semantics. Expected-head mismatches use the typed `BranchHeadMovedError`; execution retries only that error, never participant/application failures. The public host helper routes a live response through the owning runner's typed control queue; it opens a temporary writer directly only when status proves the runner is stopped. The opened fact's `seqId` is the public gate identity. Identical selected-ancestry retries are idempotent; divergent retries conflict; a timed-out, exited, failed, missing, or off-ancestry gate is stale.

JSONL serializes writes only inside one Node process, allocates against its private opened index, trusts stored entries, and rejects a stale byte boundary when detected. It provides no consistency guarantee for concurrent writers in different processes. PostgreSQL holds one session advisory writer claim for the lifetime of the runtime/store; a second live writer is rejected.

For trusted in-process hosts that must commit application ownership together with a response, the controller exposes PostgreSQL-only composite operations:

```ts
await controller.commitUserInteraction(
  { branchId: "main", gateSeqId: 42, event: { type: "SELECTED" } },
  (tx) => tx.query("insert into app.selection_claims (...) values (...)", values),
);

const committed = await controller.forkAndCommitUserInteraction(
  {
    branchId: "experiment",
    sourceBranchId: "main",
    fromSeqId: 42,
    responseBranchId: "experiment",
    gateSeqId: 42,
    event: { type: "SELECTED" },
  },
  (tx) => tx.query("insert into app.selection_claims (...) values (...)", values),
);
await controller.startBranch(committed.branch.branchId);
```

The callback receives only `query()`, not journal mutation methods. Branch creation, `user_interaction/resolved`, and participating SQL share the run writer's existing `BEGIN/COMMIT`. A failure rolls all of them back and leaves the in-memory journal snapshot unchanged. The fork point may be a historical record in the selected source branch ancestry; the source branch does not have to remain parked there after its first response. An identical branch/response retry is accepted only when branch ancestry, metadata, event, and application ownership agree exactly. JSONL and memory stores retain journal-native responses but reject cross-database composite commits because they cannot join a PostgreSQL transaction.

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

`RunLogStore` owns the journal, branch heads, immutable run metadata, and opaque disposable checkpoint rows. Writes use async `appendDrafts()`; the writer assigns durable coordinates and returns the committed facts. JSONL owns `meta.json` plus `log.jsonl`; PostgreSQL owns `hyperchart_run_meta`, `hyperchart_journal`, and `hyperchart_checkpoint`. `run_dir.ts` performs lifecycle orchestration and never selects a backend.

### Snapshot-pinned history

History reads are stateless serializable request/response operations. There is no public `readAncestry()`, materialized log, full-history array, stateful reader, offset, `seek`, or `readAll()` API. Concrete stores expose only the bounded `RunHistoryStore` contract below; projection replay is not a store method or package entrypoint export.

```ts
type HistorySnapshot = { branchId: string; headSeqId: number | null };
type HistoryCursor = string; // opaque, versioned, snapshot + subject bound

type HistoryChunk<T> = {
  snapshot: HistorySnapshot;
  items: readonly T[];       // always newest-first, maximum 100
  older?: HistoryCursor;
  newer?: HistoryCursor;
};

interface RunHistoryStore {
  captureSnapshot(branchId: string): Promise<HistorySnapshot>;
  listBranches(cursor?: BranchListCursor): Promise<BranchListChunk>;
  getBranch(branchId: string): Promise<BranchHead>;
  getRecord(seqId: number): Promise<DurableLogRecord | undefined>;
  containsInHistory(input: { headSeqId: number | null; seqId: number }): Promise<boolean>;
  readRecords(input: { snapshot: HistorySnapshot; cursor?: HistoryCursor }): Promise<HistoryChunk<DurableLogRecord>>;
  readStateVisits(input: { snapshot: HistorySnapshot; state: StatePath; cursor?: HistoryCursor }): Promise<HistoryChunk<StateVisitHistoryItem>>;
  readMapVisits(input: { snapshot: HistorySnapshot; mapPath: StatePath; cursor?: HistoryCursor }): Promise<HistoryChunk<MapVisitHistoryItem>>;
  readActorGenerations(input: { snapshot: HistorySnapshot; logicalOccurrence: StatePath; cursor?: HistoryCursor }): Promise<HistoryChunk<ActorGenerationHistoryItem>>;
  readActorMessages(input: { snapshot: HistorySnapshot; occurrence: StatePath; cursor?: HistoryCursor }): Promise<HistoryChunk<ActorMessageHistoryItem>>;
  cursorAt(input: { snapshot: HistorySnapshot; subject: HistorySubject; seqId: number }): Promise<HistoryCursor | undefined>;
}
```

A cursor is valid only for the exact snapshot and typed subject that minted it; misuse throws `HistoryCursorError`. `cursorAt()` returns `undefined` when the durable coordinate is outside that snapshot/subject. Cursor absence is the only edge marker. Branch enumeration is separately read-committed and keyset-paginated in creation-coordinate order; each page contains at most 100 heads.

Storage returns AST-free durable record groups for state visits, map visits, actor generations, and actor message batches. State/map groups include their one-based ancestry ordinal for presentation. It never imports the chart AST, projector, or host presentation models. The host adapter performs AST-aware mapping in the inspector layer. Actor message history intentionally stays grouped by the durable enqueue transaction: one `HyperchartActorMessageBatchInfo` may contain several authored-order messages, and chunk/window caps count batch rows.

### Lazy inspector history

`hyperchartRunOverviewFromRunDir()` asks the internal execution service for current graph/control state and returns a captured `HistorySnapshot`, the first keyset branch page, and an overview run with no elapsed `visitHistory`, map history, actor generation/message history, record tree, transcript arrays, queued mailbox `entries`, per-generation processed messages, or pool-worker message/visit histories. It retains only counts, mailbox head/current message, and current worker/session summaries. `createRunInspectorDataSource()` exposes serializable `readStateVisits`, `readMapVisits`, `readActorGenerations`, `readActorMessages`, `readRecords`, `cursorAt`, and `readVisitSession` requests bound to one run.

React Runtime histories share `VirtualizedHistoryList` and `useHistoryWindow`. A browser `?seqId=<durable coordinate>` deep link mints a subject-bound starting cursor through `cursorAt()` after the user selects the corresponding state. The DOM is virtualized by `@tanstack/react-virtual` with 20-row overscan; decoded state is capped at 1,000 rows. Older/newer errors are independent and remain stable until explicit retry, overlapping chunks deduplicate by durable identity, opposite-edge eviction retains a reload cursor, and snapshot/subject changes abort or ignore stale work. Inspector polling preserves the opened snapshot until **Refresh history** is chosen. Transcript messages load only through `readVisitSession` when a visit session is opened. Pi and Claude browser inspectors use the same stateless HTTP bridge; steering requests carry and validate the currently selected branch. Pi's compact TUI polls a projection-free execution overview plus one recent-record page and never requests complete ancestry.

Projection replay is a package-internal oldest-first `AsyncIterable`; each yielded batch contains at most 500 facts. It is absent from exported store interfaces and concrete class declarations and is not a host/UI history API.

The current PostgreSQL implementation deliberately computes these bounded results by traversing and filtering the captured journal history. This correctness scaffolding may consume work/memory proportional to history. The public contracts, snapshots, cursors, result caps, and replay-batch caps are final; the deferred version-order predecessor catalog will replace only backend internals. JSONL continues to use its complete private in-memory index and writes no index sidecar.

`JsonlLogStore` trusts parsed entries, fails malformed/incomplete JSON without changing the file, shares one private index across `forBranch()` handles, and rejects stale byte boundaries. `MemoryLogStore` provides the same history contract for tests and ephemeral execution.

### Opaque execution checkpoints

Runtime/storage exposes only this generic envelope:

```ts
type OpaqueCheckpointEnvelope = {
  checkpointId: string;
  headSeqId: number | null;
  selectorKey: string;
  blob: unknown;
  createdAt: number;
};
```

The internal execution layer computes the deterministic selector, AST identity, codec version, projection payload, replay diagnostics, compaction, and 512-record cadence. None of those concepts appear in runtime or backend declarations. Storage compares only `selectorKey` and ancestry coordinates and persists `blob` without opening it.

PostgreSQL stores envelopes in `hyperchart_checkpoint(selector_key, blob)` and commits due envelopes atomically with their journal facts. JSONL and memory keep envelopes in process memory only. The store stamps records under its branch writer boundary, calls the execution-owned synchronous prepare callback before durability, commits facts plus opaque envelopes, then calls its confirmation only after commit and before admitting another branch write. Preparation failure writes nothing; uncertain PostgreSQL commit or failed post-commit confirmation poisons the writer. Malformed, stale, incompatible, skipped, or warning-bearing projection payloads are handled exclusively by execution and never reinterpreted by storage.

## Script execution

### `ScriptRunner`

```ts
class ScriptRunner {
  constructor(options: { workDir: string; projectDir?: string; schemaRegistry?: SchemaRegistryLike; killGraceMs?: number });
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

`workDir` is the action cwd. Detached runners supply the isolated branch workspace there and pass the owning repository separately as `projectDir`. Every process receives authoritative `HYPERCHART_PROJECT_DIR` and `HYPERCHART_BRANCH_WORKSPACE` variables after authored env rendering. Direct/custom runtimes that omit `projectDir` expose `workDir` as both values.

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
): Promise<string>;
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
function saveRunMeta(runDir: string, meta: RunMeta): Promise<void>;
```

Ensures `sessions/` exists and writes metadata to the selected run-storage backend. With `HYPERCHART_PG_DSN`, metadata is stored in `hyperchart_run_meta` and no `meta.json` is required. Without PostgreSQL, it writes formatted `meta.json`.

### `loadRunMeta()`

```ts
function loadRunMeta(runDir: string): Promise<RunMeta>;
```

The selected `RunLogStore` implementation reads its own metadata: PostgreSQL reads `hyperchart_run_meta` by run id, while JSONL reads `meta.json`. `chartPath` and `workDir` are returned as absolute paths.

### `deleteRunStorage()`

```ts
function deleteRunStorage(runDir: string): Promise<void>;
```

Deletes the PostgreSQL metadata and journal rows atomically when PostgreSQL is configured. The host remains responsible for removing the local run directory. It is a no-op for the JSONL backend.

## Terminal outcome helpers

### `RunTerminalState`

```ts
type RunTerminalState = "complete" | "failed";
```

### `terminalStateForFinalMachine()`

```ts
function terminalStateForFinalMachine(state: MachineState): RunTerminalState;
```

Returns `failed` when durable global failure intent exists or any active terminal leaf has `outcome: "failed"`; otherwise returns `complete`. This includes failed leaves in completed parallel regions. Terminal names do not infer run outcome.

## Journal-native user interactions

Each user phase appends `user_interaction/opened` with its fully rendered prompt, options, allowed events, reply schema, action identity, and rejection metadata. The opened record's global `seqId` is the public `(runId, branchId, seqId)` gate coordinate. An accepted external answer appends one `user_interaction/resolved` referencing that `gateSeqId`; projection applies it directly as the completion.

Host scans restore each selected branch projection and read only `openUserInteractions`; response lookup uses the targeted storage operation. Admission validates the restored open gate/pending action and commits an AST-free prepared response against the captured head, retrying rather than silently admitting across branch movement. When a stamped response reaches a 512-record boundary, execution synchronously prepares the opaque cache row and PostgreSQL commits it in the same managed transaction as the response and optional host participant. Ownership still requires exact `originSessionId` and canonical `workDir`. Presentation arbitration remains lexical by run, branch, and opened seqId, with claimed/confirmed gates pinned. The only files under `user-interactions/<branchId>/<seqId>/` are non-semantic delivery receipts and publication markers.

`validateAndPersistUserInteractionResponse()` performs ownership checks and selects one of two modes. A live status with an exact runner-attempt identity queues a typed non-semantic control command; the owning runtime commits and acknowledges it. Only a stopped run opens a temporary writer directly. Allowed non-`FAILED` events and reply payloads are validated before append. Identical selected-ancestry retries are idempotent, divergent retries conflict, and closed or off-ancestry gates are stale. A crash between commit and acknowledgement is safe because retry observes the same resolved fact.

Rewind changes selected ancestry only. A resolved fact outside that ancestry neither answers nor conflicts with the selected gate.

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

`@surprisal/hyperchart/runtime`:

```text
Runtime, AgentExecutor, EmitCompletion
ChartRuntime, ChartRuntimeOptions
JsonlLogStore, MemoryLogStore, PostgresLogStore, openRunLogStore, BranchHeadMovedError
LogStore, RunHistoryStore, RunLogStore
OpaqueCheckpointEnvelope, CheckpointQuery, PrepareStampedCommit, PreparedStampedCommit
HistorySnapshot, HistoryCursor, HistorySubject, HistoryChunk
BranchListCursor, BranchListChunk
StateVisitHistoryItem, MapVisitHistoryItem, ActorGenerationHistoryItem, ActorMessageHistoryItem
JOURNAL_CHANNEL, JOURNAL_TABLE, CHECKPOINT_TABLE, supportsSqlTransactions
PostgresRunTransaction, PostgresForkAndAppendInput, SqlCommitParticipant
ScriptRunner, runGuard, checkSchema, checkSchemaAsync
artifact, schema, executor, run-directory, settings, status, and notification I/O helpers
```

`@surprisal/hyperchart/runner`:

```text
createHyperchartRunnerController, runHyperchartRunner, readRunnerConfig
listHyperchartBranchPage, getHyperchartBranch, forkHyperchartRun, rewindHyperchartRun
user-interaction scanning, receipt, response, and arbitration controls
runner/branch/rewind/user-interaction option and result types
```

Projection restoration, checkpoint selectors/codecs, retention plans, cadence constants, and `BranchExecution` are internal execution modules and are deliberately absent from both public entrypoints.

## Live projection retention

`BranchProjection` contains current synchronous machine state rather than elapsed history. `openUserInteractions` contains open gates only. Actor message lifecycle state has one authoritative entry in `liveActorMessages`, keyed by durable message ID; endpoint mailboxes, current worker slots, and `pendingActorCalls` retain IDs rather than duplicate mutable message objects. Settled non-call messages are removed immediately, while settled call messages remain only until the matching call-resolution fact. `artifactPins` contains the latest accepted revision for each rendered authored path and is attached to rendered artifact reads before the runtime performs asynchronous restoration.

The internal execution retention policy deletes session references proven non-resumable and canonical actor-message entries that have no mailbox, current-worker, or pending-call reference. Inputs, results, spawns, actor generations, and counters remain when future liveness is ambiguous. Compaction runs after projected batches and before execution encodes a checkpoint blob; runtime/storage cannot invoke or import it.

## Actor pool runtime behavior

Runtime adapters execute the same `actor_create`, `actor_enqueue`, and `actor_reply` effect kinds for ordinary actors and pools. The core scheduler may choose any idle, receive-compatible pool worker and emits that choice as an accepted fact before worker workflow invocation. Hosts must append each `durable_records` effect atomically and acknowledge multiple effects in their supplied order. Until an accepted append is projected, the machine keeps an ordered reservation for that pool so the message is virtually dequeued and the chosen worker virtually occupied; ordinary actors and unrelated pools continue independently. On restart, the internal execution service restores bounded replay batches to recover endpoint generations, worker ownership, partial batches, and drain state—never reconstruct or reassign from external worker sessions. Global failure best-effort cancels pending concrete worker actions.

## Named branch storage API

`RunHistoryStore.listBranches()` returns read-committed keyset pages of at most 100 durable branch heads. `listHyperchartBranchPage(runDir, cursor?)` exposes the same bounded page contract for run-directory callers; its opaque `next` cursor continues from the following creation coordinate. No branch collector is exported. Runner/control helpers are imported from `@surprisal/hyperchart/runner`, separately from the projection-free runtime/storage package. Package-internal control paths may consume bounded pages when orchestration requires it. `appendDrafts()` numbers from the full journal and appends from the selected durable head. `listHyperchartBranchPage()`, `getHyperchartBranch()`, `forkHyperchartRun()`, and `rewindHyperchartRun()` expose named heads. Fork does not select/start. Rewind is a stopped-only append-only move and has no cleanup/backup options.
