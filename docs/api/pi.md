# Pi API

`@surprisal/pi-hyperchart` publishes an in-process command bridge, a Pi host adapter, one consolidated agent tool, and the extension itself.

## Entry points

| Import | Contents |
|---|---|
| `@surprisal/pi-hyperchart` | Same API as `/command`. |
| `@surprisal/pi-hyperchart/command` | In-process request bridge to the loaded extension. |
| `@surprisal/pi-hyperchart/pi-host` | Chart/run discovery adapter for Pi directories. |
| `@surprisal/pi-hyperchart/react` | React API documented separately. |
| `@surprisal/pi-hyperchart/react/styles.css` | Complete scoped inspector stylesheet. |
| `@surprisal/pi-hyperchart/package.json` | Package metadata and Pi manifest. |

The package also registers `extensions/hyperchart.ts` and `skills/hyperchart/` through its Pi manifest. Those files are discovered by Pi; they are not JavaScript import entry points.

## Command bridge

```ts
import {
  HYPERCHART_COMMAND_EVENT,
  requestHyperchartCommand,
  type HyperchartCommandEventBus,
  type HyperchartCommandRequest,
} from "@surprisal/pi-hyperchart/command";
```

### `HYPERCHART_COMMAND_EVENT`

```ts
const HYPERCHART_COMMAND_EVENT = "hyperchart:command";
```

### `HyperchartCommandEventBus`

```ts
interface HyperchartCommandEventBus {
  emit(event: string, payload: unknown): void;
}
```

A Pi `events` object satisfies this structural interface.

### `HyperchartCommandRequest`

```ts
interface HyperchartCommandRequest {
  args: string;
  claim(run: () => void | Promise<void>): boolean;
}
```

A listener must call `claim()` synchronously during event emission. The claimed operation itself may be asynchronous. Only the first listener can claim.

### `requestHyperchartCommand()`

```ts
function requestHyperchartCommand(
  events: HyperchartCommandEventBus,
  args: string,
): Promise<boolean>;
```

Emits a command request and waits for the claimed operation. Returns:

- `true` after a listener claims and finishes;
- `false` when no loaded extension claims synchronously.

Errors thrown by the claimed operation reject the promise.

```ts
const handled = await requestHyperchartCommand(pi.events, "view run-id");
if (!handled) {
  // The Hyperchart extension is not loaded in this Pi process.
}
```

This bridge is for other Pi extensions. Integrated React hosts may send `steer <run-id> <action-key> <message>` when handling `onSteerSession`; the extension validates ownership and live-session status before queueing. Agents should use the consolidated `hyperchart` tool instead of constructing command strings.

## Pi host adapter

```ts
import {
  createPiHyperchartHost,
  piHyperchartHost,
  type PiHyperchartHostOptions,
} from "@surprisal/pi-hyperchart/pi-host";
```

### `PiHyperchartHostOptions`

```ts
interface PiHyperchartHostOptions {
  agentDir?: string;
  agentDefaults?: (
    agentName: string,
  ) => HyperchartInspectAgentDefaults | undefined;
}
```

- `agentDir` defaults to `PI_CODING_AGENT_DIR` or `~/.pi/agent`.
- `agentDefaults` overrides normal Pi agent-definition resolution.

### `createPiHyperchartHost()`

```ts
function createPiHyperchartHost(
  options?: PiHyperchartHostOptions,
): HyperchartHostAdapter;
```

The adapter discovers:

- project charts under `<cwd>/.pi/hypercharts`;
- user charts under `<agentDir>/hypercharts`;
- runs under the Pi Hyperchart runs root whose `meta.workDir` equals `cwd`.

New runs record the creating Pi session as `meta.originSessionId`. The adapter exposes it as `HyperchartRunInfo.originSessionId`; older runs leave it undefined.

Project charts replace same-name user charts. Definitions are sorted by name; runs are sorted newest first and limited by `runLimit`, defaulting to 50.

If run metadata is readable but full chart/runtime inspection fails, the adapter keeps a metadata-only run entry with `status: "blocked"` or a status-derived terminal value and a `run_failed` issue. Corrupt or missing `meta.json` cannot be attributed to a working directory and is omitted.

### `piHyperchartHost`

```ts
const piHyperchartHost: HyperchartHostAdapter;
```

Singleton created with default options.

## Agent tool

The Pi extension registers one `hyperchart` tool. Set `action` to `list`, `inspect`, `run`, `run_inspect`, `view`, `rewind`, or `stop`. The schema is not a JavaScript export.

### `action: "list"`

Lists project and user chart definitions without loading chart modules. Result `details.charts[]` contains `name`, `scope`, and absolute `path`. Project definitions replace same-name user definitions.

Charts may use a flat file or self-contained bundle:

```text
.pi/hypercharts/review.chart.ts
.pi/hypercharts/review/
├── chart.ts
├── agents/
├── extensions/
│   └── custom-tools/index.ts
└── scripts/
```

Bundle `agents/` overrides project and user agent definitions for that chart. Bundle extension entrypoints load when Pi loads Hyperchart. Each entrypoint exports a default Pi extension registration function. Guards and scripts resolve relative to `chart.ts`.

```json
{ "action": "list" }
```

### `action: "inspect"`

Loads and normalizes a chart without dispatching workflow actions.

```ts
{
  action: "inspect";
  chartPath: string;
  exportName?: string;
  verbose?: boolean;
}
```

| Parameter | Meaning |
|---|---|
| `chartPath` | Chart name under `.pi/hypercharts` or a module path. |
| `exportName` | Named export; default is `default`. |
| `verbose` | Return the full inspection object instead of the compact digest (large — includes chart source and schemas). |

Result `details` is `HyperchartInspectResult`.

```json
{
  "action": "inspect",
  "chartPath": ".pi/hypercharts/review.chart.ts"
}
```

By default, the response uses a compact digest; set `verbose: true` for the full inspection object.

Loading still executes module-level TypeScript. Do not inspect untrusted modules without reviewing their top-level code.

### `action: "run"`

Starts a new run, attaches to a live run, or resumes an existing stopped run.

```ts
{
  action: "run";
  chartPath?: string;
  args?: Record<string, unknown>;
  runDir?: string;
  exportName?: string;
  wait?: boolean;
  ignoreReplayWarnings?: boolean;
}
```

Rules:

- A new run requires `chartPath`.
- A resume can provide only `runDir`; `meta.json` supplies chart path, export name, and working directory.
- `runDir` may be a run id or path resolved by the extension.
- A run must belong to the current Pi working directory.
- `wait` defaults to `false`.
- `ignoreReplayWarnings` defaults to `false` and only bypasses stale/skipped replay warnings; it is not a structural repair.

Without `wait`, result details contain the startup result below. The owned terminal request is later injected as a model-facing follow-up only into the originating session/workDir and is receipted by request id.

```ts
{
  runId: string;
  runDir: string;
  chartId: string;
  final: false;
  inspector: HyperchartRunInfo;
}
```

With `wait: true`, details contain the terminal persisted status plus the final inspector model:

```ts
{
  runId: string;
  runDir: string;
  chartId: string;
  status: {
    version: 1;
    runId: string;
    runDir: string;
    chartId: string;
    state: "starting" | "running" | "complete" | "failed" | "stopping" | "stopped";
    pid?: number;
    startedAt: number;
    updatedAt: number;
    heartbeatAt?: number;
    exitCode?: number;
    error?: string;
    replayWarnings?: string[];
  };
  inspector: HyperchartRunInfo;
  notification?: TerminalNotificationRequest;
}
```

The result text is the terminal prompt when this call claims delivery. If a matching receipt already exists, the call returns terminal status without duplicating the prompt. Pi recovery also checks persisted `hyperchart-terminal` custom messages by request id before re-sending.

Start example:

```json
{
  "action": "run",
  "chartPath": "review",
  "args": { "topic": "API design" },
  "wait": false
}
```

Resume example:

```json
{
  "action": "run",
  "runDir": "review-20260711-180000"
}
```

The extension type-checks the chart, normalizes it, creates or loads run metadata, records the creating Pi session for new runs, starts a detached runner, and writes process status. It attaches instead of spawning a second process when the run is already live.

### `action: "run_inspect"`

```ts
{
  action: "run_inspect";
  runDir: string;
  verbose?: boolean;
}
```

Set `verbose: true` to return the full inspection object instead of the compact digest (large — includes chart source, schemas, and transcripts).

Loads a run id or directory belonging to the current working directory and returns `HyperchartRunInfo` in `details`. Agent states preserve declared `role`/`toolset` and expose `resolvedModel`/`resolvedTools` from the run's persisted `runner.config.json`; session snapshots may also include the actual role, model, toolset, and tool allowlist used at launch.

```json
{
  "action": "run_inspect",
  "runDir": "review-20260711-180000"
}
```

Use this tool before resume, replay override, rewind, or recovery after a crash.

### `action: "view"`

```ts
{
  action: "view";
  runDir?: string;
  chartPath?: string;
  open?: boolean;
}
```

Use exactly one of `runDir` or `chartPath`; they are mutually exclusive. Starts or reuses the Pi process's localhost inspector server, registers the selected run when viewing a run, or loads a static chart view when `chartPath` is provided.

When viewing a run, returns:

```ts
{
  runId: string;
  runDir: string;
  url: string;
}
```

For a static chart view, result details contain:

```ts
{
  chartId: string;
  chartPath: string;
  url: string;
}
```

`runDir` must identify a run belonging to the current working directory. `open` defaults to `true`; set it to `false` to return the URL without opening the system browser. The inspector polls current run/session data and its composer writes to the same run-scoped steering queue as the human command.

```json
{
  "action": "view",
  "runDir": "review-20260711-180000",
  "open": false
}
```

### `action: "stop"`

```ts
{
  action: "stop";
  runDir: string;
  all?: boolean;
}
```

Stop one run or every active run owned by current working directory. Exactly one of `runDir` or `all: true` required.

```json
{ "action": "stop", "runDir": "review-20260711-180000" }
```

```json
{ "action": "stop", "all": true }
```

Live runners receive `SIGTERM`. Stale active statuses become `stopped` without signaling unrelated processes.

### `action: "rewind"`

Backs up and truncates a stopped run.

```ts
{
  action: "rewind";
  runDir: string;
  state?: string;
  seqId?: number;
  to?: "compatible";
  mode?: "before" | "after";
  cleanupSessions?: boolean;
  cleanupArtifacts?: boolean;
  start?: boolean;
  ignoreReplayWarnings?: boolean;
}
```

Exactly one of `state`, `seqId`, or `to` is required.

| Parameter | Default | Meaning |
|---|---:|---|
| `mode` | `before` | Keep records before or through the matched record. `to: "compatible"` always cuts before the first incompatible record. |
| `cleanupSessions` | `true` | Remove session progress/directories only for durable visits removed by the cut; retained earlier visits of the same action stay active, and a legacy transcript shared with a removed resumed visit is backed up and truncated at that visit's invocation. |
| `cleanupArtifacts` | `false` | Best-effort backup and removal of downstream declared artifact files. |
| `start` | `false` | Start the rewound run after truncation. |
| `ignoreReplayWarnings` | `false` | Applied only when `start` is true. |

State target:

```json
{
  "action": "rewind",
  "runDir": "review-20260711-180000",
  "state": "pipeline.review",
  "mode": "before"
}
```

Compatibility target:

```json
{
  "action": "rewind",
  "runDir": "review-20260711-180000",
  "to": "compatible"
}
```

Result details:

```ts
{
  runId: string;
  runDir: string;
  chartId: string;
  targetLabel: string;
  backupDir: string;
  keptRecords: number;
  removedRecords: number;
  removedByState: Array<{ state: string; records: number }>;
  cutSeqId?: number;
  cleanup: {
    sessionsRemoved: number;
    artifactFilesRemoved: number;
    artifactWarnings: string[];
  };
  started?: { runId: string; runDir: string; chartId: string };
}
```

The tool rejects live runs, foreign-working-directory runs, targets matching no record, and cuts that would remove zero records.

Rewind does not undo arbitrary external effects. Its backups are inside the run directory; copy important evidence elsewhere before deleting the run.

## Process status values

Pi writes these process states to `status.json`:

```ts
type HyperchartRunState =
  | "starting"
  | "running"
  | "complete"
  | "failed"
  | "stopping"
  | "stopped";
```

These are process lifecycle states. Canonical host models use `running`, `completed`, `failed`, `paused`, and `blocked`; individual state overlays use a separate status union including `pending`, concurrency-gated `waiting`, `running`, `done`, `skipped`, and `stale`.

## Human command

The extension also registers `/hyperchart` for interactive users. It is documented in [Pi extension](../pi.md#hyperchart). Do not duplicate command syntax in agent skills; agents already receive the consolidated tool schema.
