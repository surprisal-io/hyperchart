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

Pi host libraries remain optional peers supplied through Pi's in-process extension aliases. Before spawning a detached runner, the extension resolves the active Pi package root and records allowlisted absolute entries for `@earendil-works/pi-coding-agent` and `typebox` in `runner.config.json`. The child bootstrap installs those entries as Jiti aliases before loading runner TypeScript, ensuring the child executes the same Pi host code rather than a separately installed peer.

This requires a filesystem-backed Node.js Pi installation. Compiled Bun Pi binaries expose host modules virtually rather than as importable files and are not currently supported for detached runners.

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

The Pi extension registers one `hyperchart` tool. Set `action` to `list`, `inspect`, `run`, `run_inspect`, `view`, `rewind`, `stop`, or `respond`. The schema is not a JavaScript export.

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
  /** Deprecated: true is rejected; use action: "view". */
  verbose?: boolean;
}
```

| Parameter | Meaning |
|---|---|
| `chartPath` | Chart name under `.pi/hypercharts` or a module path. |
| `exportName` | Named export; default is `default`. |
| `verbose` | Deprecated. `true` is rejected; use `action: "view"` for full browser inspection. |

Result `details` is a bounded `ChartInspectSummary`, never `HyperchartInspectResult`.

```json
{
  "action": "inspect",
  "chartPath": ".pi/hypercharts/review.chart.ts"
}
```

The response is always a capped digest. Full source, schemas, and static state definitions are available only through the browser inspector and never enter Pi session JSONL.

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

Without `wait`, result details contain only the bounded startup result below. The owned terminal boundary is later injected as a compact model-facing follow-up only into the originating session/workDir and is receipted by request id; its durable full prompt payload is not copied into session JSONL.

```ts
{
  runId: string;
  runDir: string;
  chartId: string;
  final: false;
  status: "started";
}
```

With `wait: true`, the tool participates in the same session/workDir presentation arbiter as background scans. It returns whichever boundary occurs first: terminal status for the waited run, or the globally active owned user gate (which can belong to another run that sorts earlier).

Terminal details contain compact status and identifiers only:

```ts
{
  runId: string;
  runDir: string;
  chartId: string;
  boundary: "terminal";
  final: true;
  status: {
    state: "starting" | "running" | "complete" | "failed" | "stopping" | "stopped";
    pid?: number;
    updatedAt?: number;
    exitCode?: number;
    errorPreview?: string;
    replayWarningCount?: number;
  };
}
```

A user boundary has `boundary: "user"`, `final: false`, `interaction: { version, runId, seqId, promptPreview, options, allowedEvents, outputRequired, outputHint? }`, and `waitedRun` identifying the run whose wait was interrupted. `promptPreview` is `{ text, originalChars, omittedChars }`; each option is `{ label: { text, originalChars, omittedChars }, value }`, separating bounded human display text from the exact authored value. `runId`, `seqId`, every `value`, and every allowed event name are exact and are never ellipsized or dropped. `outputHint` is a recursively bounded, non-executable contract: types/nullability; JSON-encoded enum, literal, and default values; recursively required/optional object fields and additional-property policy; array elements/tuples; union alternatives; and supported validation bounds, pattern, and format. It never contains the normalized or executable schema. The same summary is used by visible/hidden gate delivery and is sufficient to translate structured user input into `respond`. If an identity, depth, node, collection, exact-value, gate-summary, or envelope limit would make that impossible, delivery fails closed with an instruction to use the browser inspector rather than exposing a partial gate. The public gate identity is only `(runId, seqId)`; it has no runtime `effectId`.

A terminal result text is a compact boundary notice directing the operator to `view`; it never copies the durable terminal prompt or inspector snapshot. Pi recovery checks persisted `hyperchart-terminal` custom messages by request id before re-sending the same compact notice.

For a background gate, Pi scans only requests owned by the exact session and canonical cwd. While the agent is busy, it sends a hidden `hyperchart-yield` steering message and lets the current safe action/tool batch finish. On idle or `agent_settled`, it rechecks the shared arbiter and displays the active request once without `triggerTurn`. State is `pending → yielding → awaiting-user → answered/closed`; reload/session-start recovery reconstructs it from mailbox receipts. Simultaneous requests remain queued in lexical `runId`, then numeric `seqId` order.

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
  /** Deprecated: true is rejected; use action: "view". */
  verbose?: boolean;
}
```

The tool always returns a bounded `RunInspectSummary`; `verbose: true` is rejected. Its collections use digest names such as `stateDigests`, `pendingStateIds`, and `sessionDigest`, and every capped collection carries its corresponding omission count. Full runtime states, visit histories, schemas, and transcripts are fetched only by the browser inspector and never returned in tool `details`. Agent states preserve declared `role`/`toolset` and expose `resolvedModel`/`resolvedTools` from the run's persisted `runner.config.json`; session snapshots may also include the actual role, model, toolset, and tool allowlist used at launch.

```json
{
  "action": "run_inspect",
  "runDir": "review-20260711-180000"
}
```

Use this tool before resume, replay override, rewind, or recovery after a crash. Open user requests remain visible through persisted run state/mailbox inspection even when no interactive session can present them.

### `action: "respond"`

Commits the real user's answer to the exact active gate:

```ts
{
  action: "respond";
  runId: string;
  seqId: number;
  event: string;
  output?: unknown;
}
```

Pi normally creates this call from the user's next ordinary prompt after the visible gate. The extension injects hidden context instructing the model to translate that prompt into one allowed event and optional output, then call `respond` immediately; the model must not answer or infer consent itself.

The host requires the exact originating Pi session and canonical working directory, the exact globally active `(runId, seqId)`, a non-`FAILED` allowed event, and schema-valid output when declared. A byte-for-byte equivalent semantic retry is idempotent; a different answer for the same phase conflicts. Closed, stale, queued, foreign-session, and foreign-cwd coordinates are rejected.

```json
{
  "action": "respond",
  "runId": "review-20260723-120000",
  "seqId": 14,
  "event": "BLOCK",
  "output": { "feedback": "Clarify the risks." }
}
```

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

For both run and static views, result details are exactly URL-only:

```ts
{ url: string }
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

### `action: "branches"`

Lists durable named heads for a run. This is read-only and does not change the selected view.

### `action: "fork"`

```ts
{ action: "fork", runDir: string, branchId: string, fromSeqId: number, sourceBranchId?: string, reason?: string }
```

Creates a durable named branch pointer. Fork never selects or starts it and rejects duplicate names or missing records.

### `action: "rewind"`

```ts
{
  action: "rewind";
  runDir: string;
  branchId: string;
  state?: string;
  seqId?: number;
  to?: "compatible";
  mode?: "before" | "after";
  start?: boolean;
}
```

Moves only the named durable head by appending a branch mutation. All records and downstream files remain. `start: true` starts exactly `branchId` after a successful move. Run, run inspection, and run view likewise require an explicit branch handle.

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
