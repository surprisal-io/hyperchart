# API and data-contract reference

This reference describes the supported package entry points in 0.1.0. TypeScript declaration files are authoritative for exact generic signatures.

## `@surprisal-io/hyperchart`

### Authoring functions

| Export | Purpose |
|---|---|
| `refs()` | Typed argument/result/artifact/map/input selectors plus checking chart constructor. |
| `chart()` | Untyped chart identity helper (`createChart` is an alias). |
| `agent()` | Agent action definition. |
| `script()` | Script action or script validation guard. |
| `user()` | Host user-interaction action. |
| `compound()` | Nested sequential state. |
| `parallel()` | Concurrent regions and join. |
| `map()` | Dynamic keyed fan-out. |
| `final()` | Final state. |
| `artifact()` | Declared file output, optionally schema-backed. |
| `artifactOf()` | Untyped producer artifact reference. |
| `joinArtifactOf()` | Untyped mapped artifact fan-in. |
| `arg()`, `result()`, `input()`, `visit()`, `key()`, `item()` | Untyped value refs. Prefer refs returned by `refs()`. |
| `event()` | Transition event-payload binding. |
| `t` | Tagged template producing serializable template data. |
| `json()` | Explicit JSON rendering of a non-primitive ref in a template. |
| `resume()` | Resume-style re-entry policy with a message template. |
| `tsImport()` | Serializable imported TypeScript guard reference. |
| `z` | Re-exported Zod authoring API. |

### Parsing, source, and inspection

| Export | Purpose |
|---|---|
| `normalizeChartConfig()` | Validate authoring CST and return a frozen AST/diagnostics result. |
| `parseChartExport()` | Normalize one already-loaded export. |
| `parseChartModule()` | Asynchronously load/parse a module. |
| `parseChartModuleAst()` | Parse or throw `ChartParseError`. |
| `parseChartModuleSync()` | Jiti-backed synchronous TypeScript module load. |
| `inspectChartAst()` | Static inspector model from AST. |
| `inspectChartModuleSync()` | Load and statically inspect a module. |
| `hyperchartSource()` | Generate normalized validated DSL source. |
| `hyperchartStateSources()` | Generate per-state source definitions. |
| `ChartParseError` | Parse exception carrying the diagnostic result. |

### Machine, projection, replay, and loop

| Export | Purpose |
|---|---|
| `start()` | Seed arguments and execute a new runtime. |
| `loop()` | Continue driving a runtime from durable facts. |
| `createMachineOutput()` | Derive machine output from AST and facts. |
| `stepMachine()` | Apply one machine event to machine output. |
| `createBranchProjection()` | Create a projection accumulator. |
| `projectBranch()` | Project ordered durable facts. |
| `isFinalState()` | Test final projection state. |
| `explainReplay()` | Classify broken/stale/skipped provenance. |
| `isReservedSystemEvent()` | Test reserved system event names. |

### Utilities

`createAsyncQueue`, `toAsyncIterable`, and `concatAsyncIterables` support runtime adapters. Their types include `AsyncQueue` and `MaybeAsyncIterable`.

### Public types

The root declaration exports the complete CST/AST type family (`ChartCst`, `ChartAst`, state/action/ref/template/artifact/transition/schema types), machine effect/event/state types, durable log types, projection/replay types, parser/inspection types, and typed-ref helpers (`InputsOf`, `Paths`, `ValueAt`). Prefer inferred chart types over manually constructing AST values.

## `@surprisal-io/hyperchart/host`

Host-neutral inspector/dashboard boundary:

- `HyperchartHostAdapter` and snapshot options/session snapshot;
- canonical chart, run, state, edge, issue, usage, validation, visit, artifact, map, and branch models;
- `hyperchartRunFromInfo()`;
- `hyperchartRunFromInspectResult()`;
- `hyperchartRunFromRuntime()`;
- `hyperchartRunFromToolDetails()`.

Runtime adapters accept typed options for status/session progress. UIs should transport these models unchanged rather than inventing host-specific variants.

## `@surprisal-io/hyperchart/runtime`

Stable runtime integration entry point:

- `Runtime`;
- `ChartRuntime` / `ChartRuntimeOptions`;
- `AgentExecutor` / `EmitCompletion`;
- `LogStore`, `JsonlLogStore`, `MemoryLogStore`;
- `ScriptRunner` and `runGuard`;
- artifact/schema helpers;
- run-directory metadata helpers;
- terminal outcome helpers.

The `./internal/core/*` and `./internal/utils/*` export patterns exist for the first-party Pi integration. They are not the recommended application API and may move before 1.0.

## `@surprisal-io/pi-hyperchart`

The root and `./command` expose `HYPERCHART_COMMAND_EVENT`, `HyperchartCommandRequest`, and `requestHyperchartCommand()` for inter-extension command dispatch.

`./pi-host` exposes `createPiHyperchartHost()`, `piHyperchartHost`, and `PiHyperchartHostOptions`.

`./react` exposes:

- `HyperchartInspectorDialog`, `HyperchartInspectorSidePanel`, `HyperchartGraphPreview`;
- graph helpers `buildGraph`, `immediateMapScopeId`, `visibleStateIdsForScope`;
- `HyperchartRunStrip`, `HyperchartLaunchDialog`, `HyperchartToolSummary`;
- display/status/time/usage helpers;
- host-model adapter functions;
- `HyperchartPortalProvider`, `HyperchartUiThemeProvider`;
- all public React prop/model/theme types.

Import `./react/styles.css` once when using React components.

The extension and skill are Pi resources declared in `package.json`; they are not JavaScript export subpaths.

## Authoring shape (CST)

```ts
type ChartCst = {
  kind: "chart";
  id: string;
  initial: string;
  states: Record<string, StateCst>;
};
```

### Action state

| Field | Required | Notes |
|---|---:|---|
| `kind: "state"` | yes | One action per state. |
| `action` | yes | Agent, script, or user. |
| `input` | no | Named Zod schemas. |
| `transitions` | no | Event to target/object map. |
| `after` | no | `{ delayMs, target }`. |
| `validate` | no | `script()` or `tsImport()` guard. |
| `onReject` | with custom policy | `resume` or `restart`; default resume when validated. |
| `retries` | no | Rejected retry budget; requires validation. |
| `onReenter` | no | `restart` or `resume(message)`; resume only where normalization permits. |

### Compound

`kind`, `initial`, `states`, optional `transitions`, and required `onDone` when normalized as a completable compound.

### Parallel

`kind`, region `states`, optional transitions, and `onDone`. Each child is normalized as a region and must be completable.

### Map

`kind`, `over`, `initial`, nested `states`, `onDone`, optional `input`, `concurrency`, `transitions`, and `onReenter`.

### Final

Only `{ kind: "final" }`.

## Normalized shape (AST)

Normalization flattens nested states into `ChartAst.states`, keyed by absolute template state path. Each node records `id` and optional `parent`. Transitions contain resolved targets and normalized bindings. Templates contain literal string segments and ref nodes. Zod values become read-only JSON Schema data. Action UIDs include chart/state/action identity.

Do not serialize CST values with live Zod instances as the durable chart contract. Normalize first.

## Durable record schema

```ts
type DurableLogRecord =
  | ArgsLog
  | SpawnedLog
  | SessionRefLog
  | StateActionInvokeLog
  | StateActionCompleteLog
  | StateActionValidatedLog
  | StateActionTimerFiredLog;
```

Every record carries `seqId`, `parentId`, and `timestamp`. `invoke` records include action-definition provenance. `complete` and `validated` records contain the emitted event. `spawned` pins map instances. There is no transition record.

Read [runtime and durability](runtime-and-durability.md) before consuming or migrating logs.

## Pi run status

Pi operational status is one of `starting`, `running`, `complete`, `failed`, `stopping`, or `stopped`. Status includes run/chart IDs, run directory, timestamps, and optional PID, heartbeat, exit, error, and replay warnings. It is operational metadata, not a substitute for projection.

## Limitations

- APIs and internal export patterns are experimental at 0.1.0.
- Pi is the only complete host adapter.
- Pi user actions are not implemented.
- A local durable log cannot guarantee exactly-once external side effects.
- Topology migration is manual and may require a new run or reviewed rewind.
- Re-entry session reuse for partial fan-out remains under design.
- Runtime is Node.js ESM and requires Node >=22.19.
- React ships only with the Pi package and requires its peer UI libraries.

## Glossary

| Term | Definition |
|---|---|
| CST | Author-written chart configuration containing Zod schemas. |
| AST | Validated/frozen normalized chart data. |
| effect | Work requested by the pure machine. |
| machine event | Runtime acknowledgement/completion delivered to the machine. |
| fact | Append-only durable log record. |
| projection | Current branch/results/visits derived from AST plus facts. |
| visit | One entry into a state or map scope. |
| action UID | Durable chart/state/action identity for one action lineage. |
| artifact | Declared file output, optionally schema-validated. |
| reply | Small completion-event payload. |
| guard | Post-action validation before completion acceptance. |
| region | Internal child scope of a parallel state. |
| stale | Work completed in an earlier traversal but not current traversal. |
| replay warning | Stale/skipped provenance requiring operator review. |
