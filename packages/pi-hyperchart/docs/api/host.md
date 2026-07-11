# Host API

`@surprisal-io/hyperchart/host` is the harness-neutral boundary for chart discovery, run snapshots, runtime overlays, and UI models.

```ts
import {
  hyperchartRunFromInfo,
  hyperchartRunFromInspectResult,
  hyperchartRunFromRuntime,
  hyperchartRunFromToolDetails,
  type HyperchartHostAdapter,
  type HyperchartRunInfo,
} from "@surprisal-io/hyperchart/host";
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

`mode: "static"` represents a definition with no durable run overlay. `mode: "run"` represents a concrete run.

## State model

```ts
type HyperchartStateStatus =
  | "pending"
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
  agent?: string;
  definitionSource?: string;
  status: HyperchartStateStatus;
  startedAt?: number;
  endedAt?: number;
  model?: string;
  thinking?: string;
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
    stale?: number;
  };
  retry?: HyperchartRetryInfo;
  attempts?: number;
  validationAttempts?: number;
  validation?: HyperchartValidationInfo;
  visits?: number;
  visitHistory?: HyperchartVisitInfo[];
  issues?: HyperchartIssueInfo[];
}
```

`stale` is historical completion outside the current traversal or map generation. It is not pending work.

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

Visit histories are append-only views derived from durable records. Updating a run snapshot must not rewrite previously returned snapshot objects.

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
  | { kind: "script"; command: string; args?: string[] }
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
