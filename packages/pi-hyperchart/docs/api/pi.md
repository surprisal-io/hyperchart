# Pi API

`@surprisal-io/pi-hyperchart` publishes an in-process command bridge, a Pi host adapter, four agent tools, and the extension itself.

## Entry points

| Import | Contents |
|---|---|
| `@surprisal-io/pi-hyperchart` | Same API as `/command`. |
| `@surprisal-io/pi-hyperchart/command` | In-process request bridge to the loaded extension. |
| `@surprisal-io/pi-hyperchart/pi-host` | Chart/run discovery adapter for Pi directories. |
| `@surprisal-io/pi-hyperchart/react` | React API documented separately. |
| `@surprisal-io/pi-hyperchart/react/styles.css` | Complete scoped inspector stylesheet. |
| `@surprisal-io/pi-hyperchart/package.json` | Package metadata and Pi manifest. |

The package also registers `extensions/hyperchart.ts` and `skills/hyperchart/` through its Pi manifest. Those files are discovered by Pi; they are not JavaScript import entry points.

## Command bridge

```ts
import {
  HYPERCHART_COMMAND_EVENT,
  requestHyperchartCommand,
  type HyperchartCommandEventBus,
  type HyperchartCommandRequest,
} from "@surprisal-io/pi-hyperchart/command";
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

This bridge is for other Pi extensions. Agents should use the `hyperchart_*` tools instead of constructing command strings.

## Pi host adapter

```ts
import {
  createPiHyperchartHost,
  piHyperchartHost,
  type PiHyperchartHostOptions,
} from "@surprisal-io/pi-hyperchart/pi-host";
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

Project charts replace same-name user charts. Definitions are sorted by name; runs are sorted newest first and limited by `runLimit`, defaulting to 50.

If run metadata is readable but full chart/runtime inspection fails, the adapter keeps a metadata-only run entry with `status: "blocked"` or a status-derived terminal value and a `run_failed` issue. Corrupt or missing `meta.json` cannot be attributed to a working directory and is omitted.

### `piHyperchartHost`

```ts
const piHyperchartHost: HyperchartHostAdapter;
```

Singleton created with default options.

## Agent tools

The tool schemas are registered by the Pi extension. They are not JavaScript exports.

### `hyperchart_inspect`

Loads and normalizes a chart without dispatching workflow actions.

```ts
{
  chartPath: string;
  exportName?: string;
}
```

| Parameter | Meaning |
|---|---|
| `chartPath` | Chart name under `.pi/hypercharts` or a module path. |
| `exportName` | Named export; default is `default`. |

Result `details` is `HyperchartInspectResult`.

```json
{
  "chartPath": ".pi/hypercharts/review.chart.ts"
}
```

Loading still executes module-level TypeScript. Do not inspect untrusted modules without reviewing their top-level code.

### `hyperchart_run`

Starts a new run, attaches to a live run, or resumes an existing stopped run.

```ts
{
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

Without `wait`, result details contain:

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
}
```

Start example:

```json
{
  "chartPath": "review",
  "args": { "topic": "API design" },
  "wait": false
}
```

Resume example:

```json
{
  "runDir": "review-20260711-180000"
}
```

The extension type-checks the chart, normalizes it, creates or loads run metadata, starts a detached runner, and writes process status. It attaches instead of spawning a second process when the run is already live.

### `hyperchart_run_inspect`

```ts
{
  runDir: string;
}
```

Loads a run id or directory belonging to the current working directory and returns `HyperchartRunInfo` in `details`.

```json
{
  "runDir": "review-20260711-180000"
}
```

Use this tool before resume, replay override, rewind, or recovery after a crash.

### `hyperchart_rewind`

Backs up and truncates a stopped run.

```ts
{
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
| `cleanupSessions` | `true` | Remove downstream session progress and move downstream session directories into the backup. |
| `cleanupArtifacts` | `false` | Best-effort backup and removal of downstream declared artifact files. |
| `start` | `false` | Start the rewound run after truncation. |
| `ignoreReplayWarnings` | `false` | Applied only when `start` is true. |

State target:

```json
{
  "runDir": "review-20260711-180000",
  "state": "pipeline.review",
  "mode": "before"
}
```

Compatibility target:

```json
{
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

These are process lifecycle states. Canonical host models use `running`, `completed`, `failed`, `paused`, and `blocked`; individual state overlays use a separate status union including `pending`, `done`, `skipped`, and `stale`.

## Human command

The extension also registers `/hyperchart` for interactive users. It is documented in [Pi extension](../pi.md#commands). Do not duplicate command syntax in agent skills; agents already receive the four tool schemas.
