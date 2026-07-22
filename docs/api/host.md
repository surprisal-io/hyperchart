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
}

interface HyperchartSnapshotOptions {
  runLimit?: number;
}

interface HyperchartSessionSnapshot {
  hypercharts: HyperchartInfo[];
  runs: HyperchartRunInfo[];
}
```

A host implementation discovers chart definitions and runs belonging to `cwd`. It should return immutable snapshots: consumers may retain older values while a later read is in progress.

```ts
const snapshot = await host.readSessionSnapshot(process.cwd(), { runLimit: 20 });
```

## Definition model

```ts
interface HyperchartInfo {
  name: string;
  description: string;
  scope: "user" | "project";
  source?: string;
  definitionSource?: string;
  args?: Record<string, unknown>;
  states?: HyperchartStateInfo[];
  stateCount: number;
  updatedAt?: number;
}
```

`states` may be omitted when discovery found metadata without a usable definition. `source` is normally an absolute chart-module path.

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
  args: Record<string, unknown>;
  states: HyperchartStateInfo[];
  stateCount: number;
  finalOutput?: string;
  totalUsage?: HyperchartUsageInfo;
  issues?: HyperchartIssueInfo[];
}
```

`originSessionId` identifies the harness session that created a run when the host can provide it. Consumers may use exact matching for per-session views; absence means ownership is unknown.

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
  | "map"
  | "parallel"
  | "compound"
  | "region"
  | "final";
```

```ts
interface HyperchartStateInfo {
  id: string;
  type?: HyperchartStateType;
  initial?: boolean;
  agent?: string;
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
  completedEvent?: string;
  transitions?: HyperchartTransitionInfo[];
  inputs?: HyperchartInputInfo[];
  onReenter?: HyperchartOnReenterInfo;
  refs?: HyperchartRefInfo;
  join?: "all" | "any";
  final?: boolean;
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
}
```

For agent states, `role` and `toolset` preserve the symbolic names from the definition. `model` and `tools` retain concrete chart overrides or definition fallbacks; `resolvedModel` and `resolvedTools` carry the effective host mapping. Run-directory inspection resolves against the mappings persisted in that run's `runner.config.json`, not mutable current settings. If that snapshot exists but is invalid, inspection omits resolved fields rather than reinterpreting history through current settings. An absent `resolvedTools` means the host default tool configuration applies or the historical mapping is unavailable; it does not mean every installed tool is enabled.

`initial` marks a state selected by the chart root or an enclosing compound, region, or map `initial` declaration. `waiting` means the state is active but its map instance is held behind a `concurrency` gate; no invoke, visit, or agent session exists until a slot is admitted. `stale` is historical completion outside the current traversal or map generation. It is not pending work. Static inspection reports final states as `pending`; a runtime snapshot reports a final state as `done` only after the active configuration reaches it. Compound and region containers become `done` when their direct final child is reached, including after control has continued into a following container. Untaken descendants inside a completed compound, map instance, or parallel region also render `done`: scope completion makes those alternative branches unreachable without re-entry. Historical `stale` descendants convert to `done` after their enclosing scope completes and closes; `stale` remains visible only while re-entry can still make the historical/current distinction actionable.

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

`session` is an optional, immutable latest-session snapshot supplied by a host adapter; each `HyperchartVisitInfo` may additionally carry the session associated with that durable visit. `actionKey` identifies the running action for steering. `role`, `toolset`, `model`, and `tools` record the concrete session plan used at launch when the host persists those fields. Messages are display-oriented transcript entries; `reasoning` carries completed Pi thinking blocks, while `currentReasoning` and `currentText` carry throttled streaming deltas for a live view. Tool calls and matching tool results share one `tool` entry keyed by `toolCallId`; `toolStatus` moves from `running` to `completed` or `error` instead of producing two cards. Hosts may bound or omit historical messages while preserving current activity fields.

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
  path: string;
  select?: string;
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

## Artifacts and environment

```ts
interface HyperchartArtifactInfo {
  name: string;
  path?: string;
  schema?: HyperchartSchemaInfo;
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
- args: empty object.

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
  actionKey?: string;
  actionName?: string;
  status?: string;
  startedAt?: number;
  lastActivityAt?: number;
  completedAt?: number;
  sessionFile?: string;
  model?: string;
  turnCount?: number;
  toolCount?: number;
  tokenCount?: number;
  error?: string;
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

## Complete export inventory

```text
HyperchartHostAdapter, HyperchartSessionSnapshot, HyperchartSnapshotOptions
HyperchartInfo, HyperchartRunInfo, HyperchartRunStatus,
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
HyperchartRuntimeSessionProgressFile, HyperchartRuntimeSessionProgressInfo
```
