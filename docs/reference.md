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
├── user-interactions/
│   └── <branchId>/
│       └── <seqId>/
│           ├── request.json
│           ├── resolution.json
│           └── receipts/
└── sessions/
    ├── progress.json
    ├── steering/
    └── <branchId>/<actionUid>/<invocation>/
```

Only `meta.json`, the append-only v2 mutation journal `log.jsonl`, and the run directory itself are fundamental. Status and the selected UI branch are operational/non-durable; named branch heads are reconstructed from journal mutations. Persisted `status.json` schema v2 contains the runner's current live `branchIds` array (empty at terminal status) (legacy v1 is read for host delivery compatibility and upgraded on the next write). `sessions/progress.json` records `branchId` and producing invocation `seqId`; session directories are branch-separated with no migration of the old layout. Steering requests also carry `branchId`. A user interaction's exact external identity is `(runId, branchId, seqId)`; older two-component identities are rejected.

Artifact paths keep their authored mutable-file semantics. Branching the durable machine log does not version artifact contents: sibling executions may overwrite the same path, and historical artifact restoration remains a separate artifact-versioning problem.

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

- Interactive delivery requires a supported owning host session (currently Pi or Claude Code); otherwise open gates remain inspectable and resumable through their file mailbox.
- Rewind cannot reverse external effects.
- Shared/static external effects require application-specific idempotency and reconciliation.
- Missing agent definitions are execution errors.
- Loading a chart executes its top-level TypeScript.
- Important durable runs should pin exact package versions.
