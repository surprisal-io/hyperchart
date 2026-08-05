# Host API

`@surprisal/hyperchart/host` is the harness-neutral boundary for chart discovery, run snapshots, runtime overlays, and UI models.

```ts
import {
  hyperchartRunFromInfo,
  hyperchartRunFromInspectResult,
  hyperchartRunFromRuntime,
  hyperchartRunFromToolDetails,
  type HyperchartHostAdapter,
  type HyperchartRunInfo,
} from "@surprisal/hyperchart/host";
```

## Host adapter

```ts
interface HyperchartHostAdapter {
  readSessionSnapshot(
    cwd: string,
    options?: HyperchartSnapshotOptions,
  ): Promise<HyperchartSessionSnapshot>;
  readChartSnapshot(
    cwd: string,
    chartName: string,
  ): Promise<HyperchartInfo | undefined>;
  readRunSnapshot(
    cwd: string,
    runId: string,
  ): Promise<HyperchartRunInfo | undefined>;
}

interface HyperchartSnapshotOptions {
  runLimit?: number;
}

interface HyperchartSessionSnapshot {
  hypercharts: HyperchartSummaryInfo[];
  runs: HyperchartRunSummaryInfo[];
}
```

A host implementation discovers chart definitions and runs belonging to `cwd`. `readSessionSnapshot` is a lightweight list API: it returns only source/definition metadata and scalar run/status metadata. It never returns chart graphs, runtime state arrays, visit histories, prompts, schemas, or transcripts, so a host may retain it in a dashboard session. The Pi adapter does not evaluate chart modules or replay runs for this periodic read; it extracts literal chart ids and state counts from source when possible and omits graph-derived fields otherwise.

`readChartSnapshot` is the on-demand full-definition API. Call it when a user opens a definition or launch dialog; unlike the summary, it includes static states, generated definition source, and declared launch argument metadata. The Pi adapter resolves only the selected discovery entry, with host-specific project charts taking precedence over shared project charts and user charts, then evaluates that one module. `readRunSnapshot` is the separate full-run inspector API. Call it only after the user opens an inspector, keep the returned `HyperchartRunInfo` in inspector-local state, and discard it when the inspector closes.

```ts
const snapshot = await host.readSessionSnapshot(process.cwd(), { runLimit: 20 });
const definition = await host.readChartSnapshot(process.cwd(), selectedChartName);
const inspectorRun = await host.readRunSnapshot(process.cwd(), selectedRunId);
```

## Session summary models

```ts
interface HyperchartSummaryInfo {
  name: string;
  description: string;
  scope: "user" | "project";
  source?: string;
  stateCount?: number;
  updatedAt?: number;
}

interface HyperchartRunSummaryInfo {
  runId: string;
  chartName: string;
  originSessionId?: string;
  status: HyperchartRunStatus;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  pid?: number;
  detached?: boolean;
  stateCount?: number;
  progressDone?: number;
  progressTotal?: number;
  progressPercent?: number;
  activeState?: string;
  activeStateCount?: number;
  totalUsage?: HyperchartUsageInfo;
}
```

The definition summary is an explicit metadata whitelist rather than a projection of `HyperchartInfo`, so future fields do not enter dashboard snapshots automatically. These summaries contain no `args` or `states` property. A literal default-export chart can provide `name` from its `id` and `stateCount` from its literal state tree without evaluation; otherwise discovery uses the relative module name and omits `stateCount`. Run summaries likewise exclude chart/runtime expansions. Their graph-derived count, progress, active-state, and usage fields are optional and are omitted by the Pi periodic snapshot because computing them would require module evaluation and replay. A host may include them only when it already has authoritative lightweight data. Progress UI is authoritative only when `progressDone`, `progressTotal`, and `progressPercent` are all present; consumers must not interpret omitted or partial fields as zero progress. A dashboard must not reconstruct or cache a full run model in its durable/session snapshot. When supplied, `activeState` and `activeStateCount` describe only states whose status is `running`; concurrency-gated `waiting` map states do not appear as running.

## Definition model

```ts
type HyperchartLaunchArgumentInfo = {
  description?: string;
  default?: JsonValue;
};

interface HyperchartInfo {
  name: string;
  description: string;
  scope: "user" | "project";
  source?: string;
  definitionSource?: string;
  args?: Readonly<Record<string, HyperchartLaunchArgumentInfo>>;
  states?: HyperchartStateInfo[];
  stateCount: number;
  updatedAt?: number;
}
```

`states` may be omitted when discovery found metadata without a usable definition. `source` is normally an absolute chart-module path. `args` is definition-owned launch metadata, not concrete run values. It is safe for browser JSON and contains no schemas or executable validators.

## Run model

```ts
type HyperchartRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "paused"
  | "blocked";

type HyperchartInspectMode = "static" | "run";

interface HyperchartRunInfo {
  runId: string;
  chartName: string;
  originSessionId?: string;
  mode?: HyperchartInspectMode;
  definitionSource?: string;
  description?: string;
  status: HyperchartRunStatus;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  pid?: number;
  detached?: boolean;
  launchArgs?: Readonly<Record<string, HyperchartLaunchArgumentInfo>>;
  args: Record<string, unknown>;
  states: HyperchartStateInfo[];
  stateCount: number;
  finalOutput?: string;
  totalUsage?: HyperchartUsageInfo;
  issues?: HyperchartIssueInfo[];
  actorDeclarations?: HyperchartActorDeclarationInfo[];
  actorOccurrences?: HyperchartActorOccurrenceInfo[];
}
```

`originSessionId` identifies the harness session that created a run when the host can provide it. Consumers may use exact matching for per-session views; absence means ownership is unknown. `launchArgs` carries the chart's display metadata through static and runtime full models; `args` remains the concrete argument values supplied to that run. Static inspection has empty concrete `args` unless the adapter caller explicitly supplies values.

`mode: "static"` represents a definition with no durable run overlay. `mode: "run"` represents a concrete run.

## State model

```ts
type HyperchartStateStatus =
  | "pending"
  | "waiting"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "stale";

type HyperchartStateType =
  | "agent"
  | "user"
  | "script"
  | "send"
  | "call"
  | "actor-declaration"
  | "actor-occurrence"
  | "receive"
  | "reply"
  | "map"
  | "parallel"
  | "compound"
  | "region"
  | "final";
```

```ts
interface HyperchartStateInfo {
  id: string;
  scopeParentId?: string;
  runtimeStatePath?: string;
  actorInternal?: { declarationPath: string; localState: string; occurrencePath?: string };
  type?: HyperchartStateType;
  initial?: boolean;
  agent?: string;
  agentDescription?: string;
  definitionSource?: string;
  status: HyperchartStateStatus;
  startedAt?: number;
  endedAt?: number;
  role?: string;
  model?: string;
  resolvedModel?: string;
  thinking?: string;
  toolset?: string;
  resolvedTools?: string[];
  agentDefinitionUnavailable?: boolean;
  usage?: HyperchartUsageInfo;
  reads?: string[];
  readArtifacts?: HyperchartArtifactInfo[];
  completedEvent?: string;
  transitions?: HyperchartTransitionInfo[];
  inputs?: HyperchartInputInfo[];
  onReenter?: HyperchartOnReenterInfo;
  refs?: HyperchartRefInfo;
  join?: "all" | "any";
  final?: boolean;
  finalConfig?: {
    outcome: "complete" | "failed";
    notify?: {
      prompt?: string;
      artifacts?: HyperchartArtifactInfo[];
      scope?: string;
    };
  };
  taskPreview?: string;
  taskPrompt?: string;
  commandPreview?: string;
  artifacts?: HyperchartArtifactInfo[];
  replySchema?: HyperchartSchemaInfo;
  env?: HyperchartEnvInfo[];
  guard?: HyperchartGuardInfo;
  onReject?: "resume" | "restart";
  tools?: string[];
  concurrency?: number;
  mapConfig?: {
    over?: string;
    overSchema?: HyperchartSchemaInfo;
    as?: string;
    items?: HyperchartMapItemInfo[];
    visitHistory?: HyperchartMapVisitInfo[];
  };
  mapKey?: string;
  mapItemLabel?: string;
  parallelConfig?: {
    branches?: HyperchartBranchInfo[];
    count?: number;
  };
  subProgress?: {
    done: number;
    total: number;
    running: number;
    failed: number;
    waiting?: number;
    stale?: number;
  };
  retry?: HyperchartRetryInfo;
  attempts?: number;
  validationAttempts?: number;
  validation?: HyperchartValidationInfo;
  visits?: number;
  visitHistory?: HyperchartVisitInfo[];
  issues?: HyperchartIssueInfo[];
  session?: HyperchartAgentSessionInfo;
  actorMessageLink?: { kind: "send" | "call"; to: string; event: string };
  actorDeclaration?: HyperchartActorDeclarationInfo;
  actorOccurrence?: HyperchartActorOccurrenceInfo;
}
```

The Inspector presents one actor node per concrete placement, keyed by its logical path (for example `@editor` or `projects#a.@editor`). A runtime node combines its static definition with projected runtime values; a placement without an occurrence remains a definition-only actor node. Opening it shows materialized internal states when runtime data exists and template internal states otherwise. The host model and durable projection still keep declarations and occurrences distinct; occurrence-internal state nodes carry their concrete durable `runtimeStatePath`.

For agent states, `role` and `toolset` preserve the symbolic names from the definition. `model` and `tools` retain concrete chart overrides or definition fallbacks; `resolvedModel` and `resolvedTools` carry the effective host mapping. Run-directory inspection resolves against the mappings persisted in that run's `runner.config.json`, not mutable current settings. If that snapshot exists but is invalid, inspection omits resolved fields rather than reinterpreting history through current settings. An absent `resolvedTools` means the host default tool configuration applies or the historical mapping is unavailable; it does not mean every installed tool is enabled.

`initial` marks a state selected by the chart root or an enclosing compound, region, or map `initial` declaration. `waiting` means the state is active but its map instance is held behind a `concurrency` gate; no invoke, visit, or agent session exists until a slot is admitted. `stale` is historical completion outside the current traversal or map generation. It is not pending work. `finalConfig` preserves the normalized terminal outcome and optional notification prompt, artifact references, and render scope. Static inspection reports final states as `pending`; a runtime snapshot reports a final state as `done` only after the active configuration reaches it. Compound and region containers become `done` when their direct final child is reached, including after control has continued into a following container. Untaken descendants inside a completed compound, map instance, or parallel region also render `done`: scope completion makes those alternative branches unreachable without re-entry. Historical `stale` descendants convert to `done` after their enclosing scope completes and closes; `stale` remains visible only while re-entry can still make the historical/current distinction actionable.

## Live agent sessions

```ts
interface HyperchartAgentSessionInfo {
  actionKey: string;
  status: string;
  startedAt?: number;
  lastActivityAt?: number;
  role?: string;
  model?: string;
  thinking?: string;
  toolset?: string;
  tools?: string[];
  turnCount?: number;
  toolCount?: number;
  tokenCount?: number;
  currentTool?: string;
  currentToolArgs?: string;
  currentText?: string;
  currentReasoning?: string;
  lastMessage?: string;
  error?: string;
  messages?: HyperchartSessionMessageInfo[];
}

interface HyperchartSessionMessageInfo {
  id: string;
  role: "user" | "assistant" | "reasoning" | "tool" | "system";
  text?: string;
  toolName?: string;
  toolCallId?: string;
  toolInput?: string;
  toolOutput?: string;
  toolStatus?: "running" | "completed" | "error";
  isError?: boolean;
  timestamp?: number;
}
```

`session` is an optional, immutable latest-session snapshot supplied by a host adapter; each `HyperchartVisitInfo` may additionally carry the session associated with that durable visit. `actionKey` identifies the running action for steering. `role`, `toolset`, `model`, and `tools` record the concrete session plan used at launch when the host persists those fields. Messages are display-oriented transcript entries; `reasoning` carries completed Pi thinking blocks, while `currentReasoning` and `currentText` carry throttled streaming deltas for a live view. Tool calls and matching tool results share one `tool` entry keyed by `toolCallId`; `toolStatus` moves from `running` to `completed` or `error` instead of producing two cards. `HyperchartAgentSessionInfo` exists only in full run models returned by the inspector path. Lightweight `readSessionSnapshot` results contain no session objects or messages. Hosts may additionally bound historical messages in full inspector models.

## Visits

```ts
interface HyperchartVisitInfo {
  visit: number;
  invokeSeqId: number;
  startedAt: number;
  endedAt?: number;
  status: "running" | "done" | "failed" | "cancelled";
  completedEvent?: string;
  endedReason?: "timed_out" | "scope_exit";
  validationAttempts?: number;
  inputs?: Record<string, unknown>;
  mapItem?: { key: string; value?: unknown };
  invocation: HyperchartVisitInvocationInfo;
  session?: HyperchartAgentSessionInfo;
}

type HyperchartVisitInvocationInfo =
  | {
      kind: "agent";
      task?: string;
      resumeMessage?: string;
      reads?: HyperchartRenderedArtifactInfo[];
      artifacts?: HyperchartRenderedArtifactInfo[];
    }
  | {
      kind: "script";
      command: string;
      args: string[];
      env?: Record<string, unknown>;
      artifacts?: HyperchartRenderedArtifactInfo[];
    }
  | { kind: "user"; prompt: string };

interface HyperchartRenderedArtifactInfo {
  name?: string;
  sourceState?: string; // producer for artifact-backed reads
  path: string;
  select?: string;
  schema?: HyperchartSchemaInfo;
}
```

Visit histories are append-only views derived from durable records. Session progress records that include a durable `visit` number are joined to the matching entry. Run-directory inspection also reconstructs older per-action progress files from the persisted per-visit invocation directories; when several visits resumed one transcript, timestamped messages are segmented by each visit's durable start/end range. Updating a run snapshot must not rewrite previously returned snapshot objects.

## Transitions, inputs, refs, and schemas

```ts
interface HyperchartTransitionInfo {
  event: string;
  target: string;
  input?: Record<string, string>;
  taken?: boolean;
}

interface HyperchartInputInfo {
  name: string;
  schema?: HyperchartSchemaInfo;
  required?: boolean;
  defaulted?: boolean;
  preview?: string;
}

interface HyperchartSchemaInfo {
  schemaName?: string;
  schema?: Record<string, unknown>;
}

interface HyperchartRefInfo {
  arg?: string[];
  result?: string[];
  artifact?: string[];
  input?: string[];
  event?: string[];
  visit?: string[];
  key?: string[];
  item?: string[];
}

interface HyperchartOnReenterInfo {
  mode: "restart" | "resume";
  messagePreview?: string;
  refs?: HyperchartRefInfo;
}
```

## Explicit actor inspection

```ts
interface HyperchartActorDeclarationInfo {
  declarationPath: string;
  ownerPath?: string;
  inputSchema: HyperchartSchemaInfo;
  inputValue: unknown; // configured placement value/expression
  protocol: HyperchartActorMessageContractInfo[];
  initialReceive: string;
}

interface HyperchartActorOccurrenceInfo {
  declarationPath: string;
  ownerPath?: string;
  occurrencePath: string; // latest durable generation path
  logicalPath?: string; // stable Inspector placement path
  generation: number;
  generationHistory?: HyperchartVisitInfo[];
  // Each entry uses visit === actor generation and invocation.kind === "actor".
  input: unknown;
  status: "idle" | "busy" | "closing" | "draining" | "stopped" | "failed" | "cancelled";
  currentState: string;
  mailbox: HyperchartActorMailboxInfo; // latest generation
  mailboxInstances: Array<{
    occurrencePath: string;
    generation: number;
    status: "idle" | "busy" | "closing" | "draining" | "stopped" | "failed" | "cancelled";
    mailbox: HyperchartActorMailboxInfo;
    messageHistory: HyperchartActorMessageInfo[];
    currentMessage?: HyperchartActorMessageInfo;
  }>;
  currentMessage?: HyperchartActorMessageInfo;
  pendingCaller?: { callId: string; state: string; waitReason: "enqueue" | "accept" | "reply" };
  drain?: { queued: number; current: number; settled: number };
}
```

`inputSchema` is the immutable actor input type, while `inputValue` is the declaration's configured placement value/expression. An occurrence's `input` is the actual resolved runtime value. `mailbox` is the latest generation's live FIFO view; `mailboxInstances` preserves every durable generation separately, including its current/queued messages and processed-message history. Mailbox entries preserve durable order and expose message id, producer visit, optional call id, receive/reply status, reply schema provenance, and validation status. Runtime messages projected onto `send` and `call` states also retain `targetOccurrencePath`, `targetLogicalPath`, and `targetGeneration`, so a message id is never mistaken for the concrete actor instance that received it. Materialized actor-internal states expose `actorInternal.generations`; each entry identifies its parent actor occurrence/generation and keeps that generation's action visits, receive/reply history, and internal send/call messages separate. Static declarations, concrete map-local occurrences, and each occurrence's ordinary internal state graph have distinct inspector ids.

## Artifacts and environment

```ts
interface HyperchartArtifactInfo {
  name: string;
  path?: string;
  schema?: HyperchartSchemaInfo;
  sourceState?: string; // present for referenced read contracts
}

interface HyperchartEnvInfo {
  name: string;
  type: string;
  value?: string;
  schema?: HyperchartSchemaInfo;
}

type HyperchartGuardInfo =
  | {
      kind: "script";
      command: string;
      args?: string[];
      env?: HyperchartEnvInfo[];
      artifacts?: HyperchartArtifactInfo[];
      reply?: HyperchartSchemaInfo;
    }
  | { kind: "tsImport"; module: string; export: string };
```

## Map and parallel summaries

```ts
interface HyperchartMapItemInfo {
  key: string;
  label: string;
  summary?: string;
  status?: HyperchartStateStatus;
  state?: string;
  value?: unknown;
  visits?: number[];
  issueCount?: number;
}

interface HyperchartMapVisitInfo {
  visit: number;
  spawnSeqId: number;
  startedAt: number;
  instances: Record<string, unknown>;
}

interface HyperchartBranchInfo {
  id?: string;
  taskPreview?: string;
  agent?: string;
  issueCount?: number;
}
```

## Usage, validation, and issues

```ts
interface HyperchartUsageInfo {
  input?: number;
  output?: number;
  total?: number;
  cost?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface HyperchartRetryInfo {
  max?: number;
  backoffMs?: number;
  factor?: number;
}

interface HyperchartValidationInfo {
  latestRejectedReason?: string;
}
```

```ts
type HyperchartIssueSeverity = "error" | "warning" | "info";

type HyperchartIssueKind =
  | "run_failed"
  | "replay_warning"
  | "action_failed"
  | "validation_rejected"
  | "session_failed";

type HyperchartIssueSource =
  | "status"
  | "durable_log"
  | "session_progress";

interface HyperchartIssueInfo {
  severity: HyperchartIssueSeverity;
  kind: HyperchartIssueKind;
  message: string;
  source: HyperchartIssueSource;
  stateId?: string;
  seqId?: number;
  timestamp?: number;
  payload?: unknown;
}
```

## Adapter functions

### `hyperchartRunFromInfo()`

```ts
function hyperchartRunFromInfo(
  info: HyperchartInfo,
  options?: { cwd?: string },
): HyperchartRunInfo | undefined;
```

Converts a discovered definition to a static run-shaped model. Returns `undefined` when `info.states` is absent.

### `hyperchartRunFromInspectResult()`

```ts
type HyperchartRunFromInspectOptions = {
  runId?: string;
  status?: HyperchartRunStatus;
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
  args?: Record<string, unknown>;
  description?: string;
};

function hyperchartRunFromInspectResult(
  result: HyperchartInspectResult,
  options?: HyperchartRunFromInspectOptions,
): HyperchartRunInfo;
```

Converts normalized static inspection into canonical host models. Defaults:

- `runId`: `inspect:<chartId>`;
- `status`: `paused`;
- `cwd`: empty string;
- timestamps: current time;
- args: empty object;
- launchArgs: `result.args` when chart metadata was declared.

### `hyperchartRunFromToolDetails()`

```ts
function hyperchartRunFromToolDetails(
  details: unknown,
  options?: HyperchartRunFromInspectOptions,
): HyperchartRunInfo | undefined;
```

Accepts:

1. an existing `HyperchartRunInfo`;
2. an object whose `inspector` field is a run model;
3. a static `HyperchartInspectResult`.

Returns `undefined` for unrecognized input.

### `hyperchartRunFromRuntime()`

```ts
type HyperchartRuntimeSessionProgressInfo = {
  actionUid: ActionUID;
  visit?: number;
  actionKey?: string;
  actionName?: string;
  role?: string;
  status?: string;
  startedAt?: number;
  lastActivityAt?: number;
  completedAt?: number;
  sessionFile?: string;
  model?: string;
  thinking?: string;
  toolset?: string;
  tools?: string[];
  turnCount?: number;
  toolCount?: number;
  tokenCount?: number;
  currentTool?: string;
  currentToolArgs?: string;
  currentText?: string;
  currentReasoning?: string;
  lastMessage?: string;
  error?: string;
  messages?: HyperchartSessionMessageInfo[];
};

type HyperchartRuntimeSessionProgressFile = {
  updatedAt?: number;
  sessions: Record<string, HyperchartRuntimeSessionProgressInfo>;
};

type HyperchartRunFromRuntimeOptions = {
  runId?: string;
  status?: {
    runId?: string;
    runDir?: string;
    chartId?: string;
    state?: string;
    pid?: number;
    startedAt?: number;
    updatedAt?: number;
    heartbeatAt?: number;
    exitCode?: number;
    error?: string;
    replayWarnings?: readonly string[];
  };
  sessionProgress?: HyperchartRuntimeSessionProgressFile;
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
  description?: string;
  now?: number;
};

function hyperchartRunFromRuntime(
  inspect: HyperchartInspectResult,
  ast: ChartAst,
  records: readonly DurableLogRecord[],
  options?: HyperchartRunFromRuntimeOptions,
): HyperchartRunInfo;
```

This is the canonical static-plus-runtime adapter. It:

- projects durable facts;
- overlays current statuses and timestamps;
- reconstructs immutable visit histories and rendered invocations;
- materializes map instances and generations;
- marks historical traversal completions as stale;
- attaches validation, replay, session, and process issues.

It does not read files itself. The host supplies already-loaded status and session-progress data.

The model-boundary helpers use a shared positive wire-field allowlist rather than attempting to enumerate unsafe names. `boundedModelEnvelope()` validates the complete constructed envelope and substitutes a caller-shaped deterministic digest error only when its final UTF-8 JSON exceeds 64 KiB; unknown fields and non-JSON values fail closed. `summarizeUserGate()` exposes only a bounded prompt preview, authored options, exact allowed events, and a non-executable recursive reply summary. Response coordinates and identities (`runId`, `seqId`, allowed event names, and option values) are never truncated: they round-trip exactly within dedicated per-field/collection and 48 KiB gate-summary budgets, otherwise delivery fails closed and directs the operator to the browser inspector. Options separate a possibly truncated human `label` from the exact `value`; every retained display string is `{ text, originalChars, omittedChars }`, including untruncated strings with `omittedChars: 0`. The summary carries JSON types and nullability, JSON-encoded enum/literal/default values, recursive required/optional object fields and additional-property policy, array/tuple/contains schemas, union alternatives, and supported string/numeric/array/object constraints. It never returns the normalized or executable schema. Reply summaries have independent depth, node, collection, string/default, and byte caps. A collection-cap error identifies the collection and exact omitted count; because omitting a response identity, validation branch, or field would make the contract unusable, gate delivery fails closed instead of returning a partial summary. The finite JSON type set is not sliced, and the former capped `itemTypes` projection no longer exists. Browser inspector payloads deliberately bypass this model-only boundary.

## Complete export inventory

```text
HyperchartHostAdapter, HyperchartSessionSnapshot, HyperchartSnapshotOptions,
HyperchartSummaryInfo, HyperchartRunSummaryInfo,
HyperchartInfo, HyperchartLaunchArgumentInfo, HyperchartRunInfo, HyperchartRunStatus,
HyperchartStateInfo, HyperchartStateStatus, HyperchartStateType,
HyperchartAgentSessionInfo, HyperchartSessionMessageInfo,
HyperchartUsageInfo, HyperchartRetryInfo, HyperchartTransitionInfo,
HyperchartIssueInfo, HyperchartIssueSeverity, HyperchartIssueKind,
HyperchartIssueSource, HyperchartBranchInfo, HyperchartMapItemInfo,
HyperchartMapVisitInfo, HyperchartSchemaInfo, HyperchartArtifactInfo,
HyperchartEnvInfo, HyperchartGuardInfo, HyperchartInputInfo,
HyperchartRefInfo, HyperchartOnReenterInfo, HyperchartInspectMode,
HyperchartValidationInfo, HyperchartRenderedArtifactInfo,
HyperchartVisitInvocationInfo, HyperchartVisitInfo,
hyperchartRunFromInfo, hyperchartRunFromInspectResult,
hyperchartRunFromRuntime, hyperchartRunFromToolDetails,
HyperchartRunFromInspectOptions, HyperchartRunFromRuntimeOptions,
HyperchartRuntimeSessionProgressFile, HyperchartRuntimeSessionProgressInfo,
summarizeHyperchartProgress, summarizeChartInspect, summarizeRunInspect,
summarizeReplyContract, summarizeUserGate, assertToolPayloadSafe,
boundedModelEnvelope, serializeModelEnvelope, serializeToolPayload,
MAX_TOOL_PAYLOAD_BYTES, SafeToolPayload, ReplyContractSummary,
ReplySchemaSummary, ReplySchemaConstraints, ReplyContractSummaryError,
DisplayStringSummary, UserGateOptionSummary, UserGateSummary,
ChartInspectStateSummary, ChartInspectSummary, RunInspectStateSummary,
RunInspectSummary
```
