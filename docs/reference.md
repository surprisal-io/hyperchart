# Reference

The complete API reference is split by public entry point.

## Published APIs

- [DSL reference](api/dsl.md) — every chart constructor, typed selector, state field, transition, artifact, guard, schema, and composition primitive, with examples.
- [Core API](api/core.md) — normalization, parsing, inspection, AST, projection, machine, durable records, replay, execution loop, and async utilities.
- [Runtime API](api/runtime.md) — runtime and agent contracts, log stores, script execution, guards, schemas, artifacts, run directories, and terminal outcomes.
- [Host API](api/host.md) — discovery contract, canonical chart/run/state models, visit history, issues, and static/runtime adapters.
- [Pi API](api/pi.md) — command bridge, Pi host adapter, all consolidated-tool actions, parameters, results, and errors.
- [React API](api/react.md) — components, props, providers, graph/display helpers, models, peers, and stylesheet contract.

The [API index](api/README.md) lists every supported package entry point and the stability boundary.

## File contracts

### Run directory

```text
<run-dir>/
├── meta.json
├── log.jsonl
├── status.json
├── runner.config.json
├── runner.stdout.log
├── runner.stderr.log
├── sessions/
│   └── progress.json
└── rewind-backups/
```

Only `meta.json`, `log.jsonl`, and the run directory itself are fundamental. Status, runner logs, session progress, and rewind backups appear when the corresponding host/runtime behavior is used. `runner.config.json` snapshots the host's role/model and toolset/tool mappings for that run; `sessions/progress.json` may additionally record each launched session's declared role/toolset and actual model/tool allowlist.

Artifacts may live anywhere inside the run working directory according to the chart declaration; they are not required to live under `<run-dir>`.

### Process states

```ts
type HyperchartRunState =
  | "starting"
  | "running"
  | "complete"
  | "failed"
  | "stopping"
  | "stopped";
```

These `status.json` values are different from canonical host run statuses and per-state inspector statuses. See [Pi API](api/pi.md#process-status-values) and [Host API](api/host.md).

## Current limitations

- Pi and the generic runtime do not implement `user` actions.
- Rewind cannot reverse external effects.
- Artifact cleanup during rewind is best effort.
- General agent-session identity for partial map/parallel re-entry is not defined.
- Missing agent definitions are execution errors.
- Loading a chart executes its top-level TypeScript.
- Important durable runs should pin exact package versions.
