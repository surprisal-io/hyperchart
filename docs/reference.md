# API and file reference

This page lists supported entry points and stable names. Use the task guides for behavior and examples.

## Package entry points

### `@surprisal-io/hyperchart`

| Entry point | Contents |
|---|---|
| `@surprisal-io/hyperchart` | DSL, normalized types, parser/inspection, machine, projection, replay, execution loop, Zod export |
| `@surprisal-io/hyperchart/host` | canonical chart/run models and data adapters |
| `@surprisal-io/hyperchart/runtime` | generic runtime, log stores, script runner, artifacts, guards, schemas, run directories |
| `@surprisal-io/hyperchart/package.json` | package metadata |

`./internal/core/*` and `./internal/utils/*` exist for first-party package wiring. They are not a compatibility promise for application code.

### `@surprisal-io/pi-hyperchart`

| Entry point | Contents |
|---|---|
| `@surprisal-io/pi-hyperchart` | package marker/default entry |
| `@surprisal-io/pi-hyperchart/command` | in-process command event API |
| `@surprisal-io/pi-hyperchart/pi-host` | Pi host adapter |
| `@surprisal-io/pi-hyperchart/react` | React components, models, adapters, graph/display helpers |
| `@surprisal-io/pi-hyperchart/react/styles.css` | complete React stylesheet |
| `@surprisal-io/pi-hyperchart/package.json` | package metadata |

The npm tarball also contains `extensions/hyperchart.ts` and `skills/hyperchart/` for Pi discovery.

## Authoring functions

Imported from `@surprisal-io/hyperchart`:

| Function | Signature summary | Purpose |
|---|---|---|
| `refs<Args, Results, Files, Maps, Inputs>()` | returns typed chart constructor and refs | checked authoring registry |
| `chart(definition)` | identity helper | untyped chart authoring |
| `agent(name, options?)` | agent action | invoke a named host agent |
| `script(command, args?, options?)` | script action or guard | execute a static command |
| `user(options)` | user action | request host user input |
| `final()` | final state | complete a containing scope |
| `compound(options)` | compound state | one active child |
| `parallel(options)` | parallel state | fixed concurrent regions |
| `map(options)` | map state | data-driven concurrent instances |
| `artifact(path, shape?)` | artifact declaration | require a file deliverable |
| `t\`...\`` | template tag | interpolate refs into text |
| `json(ref)` | ref wrapper | serialize a value as JSON text |
| `event(path?)` | event binding | bind transition input from completion output |
| `input(name)` | untyped input ref | read target-visit input |
| `visit(state?)` | visit ref | read visit number |
| `resume(message)` | re-entry policy | reuse a supported session with a message |
| `tsImport(module, exportName)` | guard ref | load a validator export |
| `z` | Zod namespace | define reply, input, and artifact schemas |

Prefer `event`, `input`, `visit`, `arg`, `result`, `artifactOf`, `joinArtifactOf`, `key`, and `item` returned by `refs()` where available. The typed forms carry registry and path checks.

`createChart` exists inside the DSL implementation as an alias but is not exported from the package root. Use `chart`.

## `refs()` selectors

```ts
const {
  chart,
  arg,
  event,
  visit,
  input,
  result,
  artifactOf,
  joinArtifactOf,
  key,
  item,
} = refs<Args, Results, Files, Maps, Inputs>();
```

| Selector | Form |
|---|---|
| run argument | `arg(name)` |
| event output | `event(path?)` |
| visit number | `visit(state?)` |
| transition input | `input(name, path?)` |
| accepted result | `result(state, path?)` |
| one artifact path | `artifactOf(state, { artifact?, select? })` |
| artifacts from all map instances | `joinArtifactOf(state, { artifact? })` |
| current map key | `key(mapPath)` |
| current map item | `item(mapPath, path?)` |

Dot-path selection traverses object fields. Array indexing is not part of the typed `Paths<T>` selector contract.

## Chart and state fields

### Chart

```ts
{
  kind: "chart";
  id: string;
  initial: string;
  states: Record<string, StateCst>;
}
```

### Action state

```ts
{
  kind: "state";
  action: AgentActionCst | ScriptActionCst | UserActionCst;
  input?: Record<string, SchemaCst>;
  transitions?: TransitionMapCst;
  after?: { delayMs: number; target: string };
  validate?: GuardRef;
  onReject?: "resume" | "restart";
  onReenter?: "restart" | { kind: "resume"; message: Templatable };
  retries?: number;
}
```

### Compound

```ts
{
  kind: "compound";
  initial: string;
  states: Record<string, StateCst>;
  transitions?: TransitionMapCst;
  onDone?: string;
}
```

### Parallel

```ts
{
  kind: "parallel";
  states: Record<string, StateCst>;
  transitions?: TransitionMapCst;
  onDone?: string;
}
```

### Map

```ts
{
  kind: "map";
  input?: Record<string, SchemaCst>;
  over: InputRef;
  concurrency?: number;
  onReenter?: OnReenterCst;
  initial: string;
  states: Record<string, StateCst>;
  transitions?: TransitionMapCst;
  onDone?: string;
}
```

## Parsing and inspection

Root exports:

| Export | Purpose |
|---|---|
| `parseChartExport()` | parse a loaded module export |
| `parseChartModule()` | asynchronously load and normalize a chart module |
| `parseChartModuleAst()` | parse a module directly to AST-oriented result |
| `parseChartModuleSync()` | synchronously load with Jiti |
| `inspectChartAst()` | inspect an already normalized AST |
| `inspectChartModuleSync()` | load and produce static inspector data |
| `hyperchartSource()` | render normalized definition source |
| `hyperchartStateSources()` | render per-state normalized source |
| `normalizeChartConfig()` | validate CST and produce AST/diagnostics |
| `ChartParseError` | thrown parse/load error type |

Module loading executes top-level TypeScript. See [Module loading and trust](core-authoring.md#module-loading-and-trust).

## Machine, projection, and replay

Root exports:

| Export | Purpose |
|---|---|
| `createMachineOutput()` | derive the first machine output from state |
| `stepMachine()` | advance the pure machine by one machine event |
| `createBranchProjection()` | initialize projection state |
| `projectBranch()` | derive current branch from durable records |
| `isFinalState()` | test normalized final state |
| `explainReplay()` | classify log compatibility |
| `start()` | start the execution loop |
| `loop()` | continue the execution loop |

The root also exports the corresponding `MachineState`, effect, event, projection, replay, and durable-record types.

## Runtime entry point

`@surprisal-io/hyperchart/runtime` exports:

| Export | Kind |
|---|---|
| `Runtime` | effect interpreter interface |
| `AgentExecutor`, `EmitCompletion` | host agent contract types |
| `ChartRuntime`, `ChartRuntimeOptions` | generic runtime implementation |
| `JsonlLogStore`, `MemoryLogStore`, `LogStore` | durable/in-memory log stores |
| `ScriptRunner` | child-process script executor |
| `createRunDir`, `loadRunMeta`, `saveRunMeta`, `RunMeta` | run-directory metadata |
| `checkArtifactFile`, `resolveArtifactValue`, `serializeEnvValue` | artifact helpers |
| `runGuard`, `checkSchema` | validation helpers |
| `terminalStateForFinalMachine`, `isFailureStatePath`, `finalMachineFailureMessage` | terminal outcome helpers |

## Host entry point

`@surprisal-io/hyperchart/host` exports:

- `HyperchartHostAdapter`;
- `HyperchartSessionSnapshot` and snapshot options;
- canonical `HyperchartInfo`, `HyperchartRunInfo`, state, visit, issue, artifact, usage, and status models;
- `hyperchartRunFromInfo()`;
- `hyperchartRunFromInspectResult()`;
- `hyperchartRunFromRuntime()`;
- `hyperchartRunFromToolDetails()`.

## Pi run states

`status.json` uses:

```ts
type HyperchartRunState =
  | "starting"
  | "running"
  | "complete"
  | "failed"
  | "stopping"
  | "stopped";
```

The canonical inspector model also uses `pending`, `stale`, `skipped`, and related display statuses for individual states/visits. These are not process lifecycle values.

## Durable record kinds

```ts
type DurableLogRecord =
  | ArgsLog
  | SessionRefLog
  | SpawnedLog
  | StateActionInvokeLog
  | StateActionCompleteLog
  | StateActionValidatedLog
  | StateActionTimerFiredLog;
```

See [Durable records](runtime-and-durability.md#durable-records) for meaning and replay behavior.

## Pi tool names

| Tool | Required parameters |
|---|---|
| `hyperchart_inspect` | `chartPath` |
| `hyperchart_run` | chart path and/or existing `runDir` as appropriate |
| `hyperchart_run_inspect` | `runDir` |
| `hyperchart_rewind` | `runDir` plus exactly one of `state`, `seqId`, `to: "compatible"` |

Full schemas and examples are in [Pi extension](pi.md#agent-tools).

## Run directory

```text
<run-dir>/
├── meta.json
├── log.jsonl
├── status.json
├── sessions/
│   └── progress.json
└── rewind-backups/
```

`progress.json` and `rewind-backups/` are optional. Artifacts may live inside or outside the run directory according to the chart.

## Current limitations

- Pi user actions are not implemented by the current Pi executor.
- Rewind cannot reverse external effects.
- Artifact cleanup during rewind is best effort.
- Agent session reuse for partial map/parallel re-entry has no general identity contract.
- A missing agent definition is an execution error.
- Chart inspection loads executable TypeScript.
- Exact package versions should be pinned for important durable runs.

## Terms

| Term | Meaning |
|---|---|
| state | one chart node in the authoring/runtime model |
| state path | absolute template address such as `pipeline.review` |
| runtime path | materialized address, possibly with map keys such as `chapters#intro.write` |
| visit | one entry into a state; a state path may have many visits |
| fact | durable external or accepted workflow record |
| projection | control/data state derived from ordered facts |
| effect | work requested by the pure machine and interpreted by a runtime |
| stale | historical completion outside the current traversal/generation |
| runtime overlay | status, visits, sessions, usage, artifacts, and issues attached to static inspection |
