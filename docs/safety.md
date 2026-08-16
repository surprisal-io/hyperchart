# Recovery and safety

Hyperchart can reconstruct control state from durable facts. It cannot make arbitrary external effects transactional.

Use this page before resuming after a crash, overriding replay warnings, rewinding, or deleting a run.

## Chart modules are executable code

A chart is a TypeScript module. Parsing and inspection load it through Jiti, which can execute top-level JavaScript with the current user's permissions.

`hyperchart` with `action: "inspect"` is static only in the data-model sense: it returns chart source, contracts, and topology without runtime overlays and without dispatching workflow actions. It is not a sandbox.

Before loading an unfamiliar chart:

1. read the source and imported local modules;
2. look for top-level writes, network calls, child processes, timers, or environment mutation;
3. inspect dependency changes;
4. run Pi in an appropriate container or sandbox if the source is not trusted.

See [Pi Security](https://pi.dev/docs/latest/security) and [Pi Containerization](https://pi.dev/docs/latest/containerization) for host-level isolation.

## External effects are not rolled back

Scripts and agents can modify files, repositories, APIs, databases, and remote services. Hyperchart records invocation and accepted completion facts, but it does not wrap those systems in a transaction.

A crash may happen after the external effect and before the completion fact is appended:

```text
invoke fact persisted
        │
        ▼
external action runs ──► side effect succeeds
        │
        └── process crashes before completion fact
```

On recovery, the log proves that the action was invoked. It may not prove whether the external effect completed.

Design actions to be idempotent when possible:

- use stable request/idempotency keys;
- write files atomically;
- check whether an output already exists and is valid;
- make API operations queryable before retry;
- separate irreversible publication from preparation;
- keep enough provenance to reconcile manually.

## Replay warnings

`explainReplay()` compares the current chart with the stored log and classifies records:

| Class | Meaning | Default response |
|---|---|---|
| compatible | record still has the same meaning | replay normally |
| stale | chart changes make a historical derivation no longer current | inspect the change before continuing |
| skipped | a record cannot participate in the current traversal | inspect ordering and chart changes |
| broken | the record cannot be interpreted safely | do not override; repair or restart |

The runner blocks stale and skipped replay by default. Broken replay is not an override case.

`--ignore-replay-warnings` and `ignoreReplayWarnings: true` are explicit assertions that you have reviewed the mismatch. They do not repair the log and do not make external effects safe to repeat.

Before overriding:

1. stop the run if it is live;
2. call `hyperchart` with `action: "run_inspect"` or open the run view;
3. read every replay issue and affected state path;
4. diff the chart source and imported validators;
5. decide whether the old facts still mean what the new chart expects;
6. back up the run outside its directory;
7. prefer restart when compatibility is uncertain.

## Resume or restart

Use **resume** when:

- the run log is compatible;
- chart and validator meaning have not changed incompatibly;
- outstanding external actions are safe to reconcile or retry;
- you need to preserve visit and result history.

Use **restart** when:

- the chart changed materially;
- the old log is not needed for the new attempt;
- external effects can be handled independently;
- you want the old run preserved as evidence.

`/hyperchart restart <run-id>` creates a new run. It does not delete or rewrite the source run.

## Stop a run

```text
/hyperchart stop <run-id>
```

Stopping is required before rewind. It asks the runner to terminate active execution and updates operational status.

Stopping does not guarantee that every child process, remote request, or agent-side effect was reversed. Inspect the process status and external systems before resuming.

## Rewind a run

Rewind is an append-only move of one durable named branch head. It is stopped-only and requires an explicit `branchId`. It never deletes, truncates, moves, backs up, or rewrites machine records, sessions, user-interaction mailboxes, terminal notifications, or artifacts.

1. Stop the runner and inspect the selected branch ancestry and full record tree.
2. Choose exactly one selector: `state`, `seqId`, or `to: "compatible"`, plus `mode: "before" | "after"`.
3. Confirm the branch name and target. An explicit `seqId` may point to a preserved sibling tip; state and compatibility selectors resolve within the selected branch ancestry.
4. Move the head. The run remains stopped. To continue, start exactly the same `branchId` explicitly.

The next append takes its parent from that durable head, receives a globally new `seqId` from the full journal, and advances only that branch. External side effects and artifact files are not rolled back. Artifact paths retain their authored mutable-file semantics, so sibling executions can overwrite the same path; preserving historical artifact values requires a separate artifact-versioning design.

Fork is different: it creates another named pointer at a historical record, but never changes selection and never starts a runner. Checkout/view is non-durable and writes nothing.

## Delete a run

```text
/hyperchart delete <run-id>
```

Deletion recursively removes the run directory. That includes:

- `meta.json`;
- `log.jsonl`;
- `status.json`;
- agent sessions and progress;
- branch heads and preserved sibling histories in the append-only log;
- any artifacts stored inside the run directory.

Artifacts outside the run directory and remote effects are not deleted automatically.

There is no trash or restore command. Confirm the run is stopped, inspect its ownership, and make an external backup before deleting anything that may be needed for audit or recovery.

## Keep chart and log together

Replay recomputes transitions from the current chart. Preserve the chart source, imported validators, and package versions used for important runs.

Recommended release practice:

- pin `@surprisal/hyperchart` and `@surprisal/pi-hyperchart` to exact matching versions;
- keep chart changes in version control;
- record the source revision in surrounding project metadata;
- do not edit `log.jsonl` manually;
- use rewind to move a stopped branch head while preserving every historical record.

## Related pages

- [Runtime and durability](runtime-and-durability.md)
- [Pi commands and tools](pi.md)
- [Architecture and formal model](architecture.md)

## Actor safety invariants

Every message is accepted only by an explicit `receive()` state; an actor owns at most one current message; every accepted workflow reaches exactly one graph-inferred `reply()` before the next accept; FIFO head mismatch fails globally. Reserved `FAILED` cannot be authored as a transition and terminalizes immediately after durable failure intent. See [Explicit actors](./explicit-actors.md).

### Pool and batch invariants

A pool has exactly its declared positive concurrency, at most that many busy workers, and at most one current message per worker. Only the FIFO head can be assigned; the scheduler may choose any compatible idle worker, and that durable `workerIndex` must be named by every later reply/settlement. Ordered pool-local reservations treat dispatched but unprojected acceptance facts as virtual dequeues and occupied workers, preventing duplicate assignment without blocking ordinary actors or unrelated pools. A batch is non-empty and all items validate before atomic enqueue. Batch resolution is impossible until every declared member settles and its `messageIds` must match authored `batchIndex` order.

When an unsupported head exists, a busy worker may still return to a compatible receive state, so failure waits until all workers are idle and incompatible. Closing rejects external admission but drains queued/current work. The owner and terminal run wait for empty backlog and all idle/stopped workers. Global failure prevents successor effects and includes pending worker actions in best-effort cancellation.
