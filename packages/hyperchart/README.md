# `@surprisal/hyperchart`

Host-neutral Hyperchart authoring, machine, replay, runtime, and inspector models.

## Install

```sh
npm install @surprisal/hyperchart
```

Requires Node.js 22.19 or newer.

## Create a chart

```ts
import { chart, final, script } from "@surprisal/hyperchart";

export default chart({
  kind: "chart",
  id: "hello",
  args: {
    message: { description: "Text to print", default: "hello" },
  },
  initial: "run",
  states: {
    run: {
      kind: "state",
      action: script("node", ["-e", "console.log('done')"]),
      transitions: { DONE: "done" },
    },
    done: final(),
  },
});
```

Optional chart-level `args` metadata gives hosts serializable descriptions and JSON defaults for on-demand launch forms; it is inspection metadata, not executable validation or automatic runtime input. Action states may publish finite-JSON domain facts with ordered `emit()` declarations; optional emit schemas are consumer/typing/UI contracts only, are neither runtime-enforced nor journaled, and emits are appended atomically only with accepted outcomes and remain inert during projection. `gate()` opens a durable host-application request without dispatching an executor or entering human request scanning, then uses the same branch-aware interaction commit APIs as `user()`. `refs<Args>().chart()` accepts subset or empty metadata and rejects every key outside `Args`, including typos mixed with valid keys. A script with one successful transition may select it implicitly on exit code `0`. `tsAction(module, exportName, options)` is the trusted in-process alternative for measured subprocess hot paths; it preserves durable action provenance, shared completion validation, and artifact pinning, but cancellation cannot terminate continuing CPU work or side effects. Top-level `final()` and `failed()` terminals explicitly select `complete` or `failed` run outcome; optional terminal notifications can append a scoped prompt and authoritative paths for declared artifacts. Runner/host delivery uses a persist-once outbox and per-session receipts.

## Entry points

| Import | Purpose |
|---|---|
| `@surprisal/hyperchart` | DSL, types, parsing, inspection, machine, projection, replay |
| `@surprisal/hyperchart/runtime` | projection-free effect runtime, log stores, scripts, guards, artifacts |
| `@surprisal/hyperchart/runner` | runner/controller, branch, rewind, and user-interaction controls |
| `@surprisal/hyperchart/host` | canonical chart/run models and adapters |
| `@surprisal/hyperchart/react` | optional React inspector and run surfaces |
| `@surprisal/hyperchart/react/styles.css` | required inspector stylesheet |
| `@surprisal/hyperchart/package.json` | package metadata |
| `@surprisal/hyperchart/inspect` | run inspection, inspector server, and session transcripts |
| `@surprisal/hyperchart/sessions` | session progress, steering, and run status |

The host runtime overlay distinguishes map actions held behind a `concurrency` gate as `waiting`; admitted or invoked actions remain `running`. In the React inspector, agent cards show declared role/toolset metadata and resolved model/tool configuration, while a selected run state's `Runtime` section owns its live-session controls and actual launch-plan summary. `HyperchartRunStrip` accepts the lightweight chart/run summaries from `readSessionSnapshot()` directly and hides progress when its three summary progress fields are omitted or incomplete.

Run inspectors load a projection-backed overview first, then request snapshot-pinned state/map/actor/record chunks through `HyperchartInspectorDataSource`. The dialog keeps a bounded, chronological **Action visit history** beside the graph: repeated invocations remain separate and are ordered by durable sequence, while pending, waiting, skipped, and unvisited states stay in a distinct state-context disclosure. Record pages request batched semantic action-visit enrichment, avoiding one full-prefix scan per visible state; inherited invocations retain their origin branch for transcript lookup. Live overview updates keep open history and Execution viewport stable; **Refresh history** adopts latest received snapshot. Older/newer controls make partial windows explicit, and selecting a row opens that exact invocation when its state is represented in the current graph. Runtime lists use `@tanstack/react-virtual`, retain at most 1,000 rows, and load transcripts only when a visit is opened. Actor messages remain grouped by durable enqueue transaction.

Removing a validator replays recorded verdicts with a warning; missing positive validation never becomes an accepted result. Unknown legacy invoke policies block unfinished invocations, including those still running. The machine enforces this execution gate by returning an error; history remains inspectable. See [Recovery and safety](../../docs/safety.md#a-validator-was-removed).

If an edited chart cannot replay historical facts, the inspector labels its graph **Current definition only** and keeps durable history/transcripts readable without relaxing execution replay. See [incompatible historical run inspection](https://github.com/surprisal-io/hyperchart/blob/main/docs/integration.md#inspecting-an-incompatible-historical-run) for diagnostics and record-only limitations.

The core package has no Pi dependency. React integrations use the optional peer dependencies declared by the package.

## Documentation

- [Run your first chart](https://github.com/surprisal-io/hyperchart/blob/main/docs/quickstart.md)
- [Author charts](https://github.com/surprisal-io/hyperchart/blob/main/docs/core-authoring.md)
- [Runtime and durability](https://github.com/surprisal-io/hyperchart/blob/main/docs/runtime-and-durability.md)
- [Complete API reference](https://github.com/surprisal-io/hyperchart/tree/main/docs/api)
- [DSL reference and examples](https://github.com/surprisal-io/hyperchart/blob/main/docs/api/dsl.md)

## Explicit actors

The core package includes statically placed, event-sourced actors with explicit `receive()`, FIFO `send`, typed `call`, and graph-inferred `reply()`. See the canonical [explicit actor guide](../../docs/explicit-actors.md).

MIT · experimental `0.6.0`

Static actor pools are available through `actorPool()`. Use singleton `send()`/`call()` or explicit non-empty `sendBatch()`/`callBatch()`; a single-reply `callBatch()` publishes its complete input-ordered reply array through `result("batchState")`. Actor templates may target their current endpoint with send-only `self()`. A sixth `refs()` actor-protocol registry exposes typed, authoring-only `actorRef(name)` forward targets; `refs().chart()` resolves them to static durable paths and rejects missing, duplicate, incompatible, out-of-scope, or cross-chart bindings. A seventh completion registry exposes nominal `completionRef(name)` capabilities: actors publish with exact-validated, nonblocking `notify()`, while root or compound sequential control durably consumes retained notifications with `waitFor()`. Publication and consumption each commit atomically with their action completion and fail closed on duplicate or stale reuse. See the canonical [explicit actors guide](../../docs/explicit-actors.md).

Formal checks and their bounded/existential guarantees are documented in the [development guide](../../docs/development.md#formal-coverage-and-limits).

## Branch storage

`@surprisal/hyperchart/runtime` exports projection-free storage/effect APIs and opaque checkpoint envelopes; branch and runner controls live in `@surprisal/hyperchart/runner`. History is snapshot-pinned and cursor-paged at no more than 100 items; stores expose no `readAncestry()`, full-history array, projection loader, or replay-stream method. The internal execution layer alone restores and compacts projections and encodes opaque blobs from package-private replay pages capped at 500 facts. PostgreSQL atomically persists each due 512-record envelope, fork/rewind targets, and non-empty clean-shutdown tails without interpreting its selector or blob; see [Runtime and durability](../../docs/runtime-and-durability.md#append-only-branch-storage). Every runner/inspection uses an explicit branch handle. Detached runners distinguish the owning repository `projectDir` from each isolated `<runDir>/workspaces/<branchId>` action cwd; scripts receive both as `HYPERCHART_PROJECT_DIR` and `HYPERCHART_BRANCH_WORKSPACE`.

Historical inspector hosts can pass `snapshot: { branchId, headSeqId }` to
`hyperchartRunFromRunId` to restore a read-only past boundary, including an
unanswered user gate. See [historical branch inspection](../../docs/api/react.md#inspecting-a-historical-branch-boundary).

Runs are addressed only by `runId`. Host storage config declares backend, root and `run-id` or `sha256` layout; existing literal framework and hashed AutoDiscovery layouts remain unchanged. See the [canonical runtime identity contract](../../docs/api/runtime.md#run-identity-and-storage-scope). Moves only drain and change the head. External schedulers can recover ordinary durable unfinished work using controller-owned `canStartBranch()` fences and `onBranchChange()` lifecycle wakeups, including readiness changes without journal writes. Failed cleanup remains non-reusable and preserves its cause. See the [runner lifecycle contract](../../docs/api/runtime.md).
