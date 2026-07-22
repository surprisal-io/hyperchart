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

Rewind truncates semantic history. It is a recovery operation, not ordinary navigation.

### 1. Stop and inspect

```text
/hyperchart stop <run-id>
```

Then call:

```json
{ "runDir": "<run-id>" }
```

with `hyperchart` with `action: "run_inspect"`. Identify the target state or `seqId`, affected visits, downstream sessions, and artifacts.

### 2. Make an independent backup

The rewind tool writes a timestamped backup under the run's `rewind-backups/` directory. That protects against an interrupted edit, but the backup is still deleted if the whole run directory is deleted.

For important runs, copy the complete run directory elsewhere first:

```sh
cp -R .pi/hypercharts/runs/<run-id> ../hyperchart-run-backups/<run-id>
```

### 3. Choose one target

By state:

```json
{
  "runDir": "<run-id>",
  "state": "chapter-production#intro.write",
  "mode": "before"
}
```

By sequence id:

```json
{
  "runDir": "<run-id>",
  "seqId": 84,
  "mode": "after"
}
```

To remove the first incompatible suffix:

```json
{
  "runDir": "<run-id>",
  "to": "compatible"
}
```

Exactly one of `state`, `seqId`, or `to` is required.

### 4. Understand cleanup

Defaults:

- `cleanupSessions: true` moves only sessions belonging to removed durable visits into the rewind backup; earlier retained visits of the same action keep their progress and transcript directories, while legacy transcripts shared across a retained/resumed boundary are backed up and truncated at the first removed invocation;
- `cleanupArtifacts: false` leaves artifact files in place.

Artifact cleanup is best effort because paths may be dynamic or shared. Even when enabled, it cannot reverse external services or untracked files.

### 5. Reinspect before starting

Run `hyperchart` with `action: "run_inspect"` again. Verify:

- the retained log ends where expected;
- status is `stopped`;
- removed visits and results are absent;
- remaining replay issues are understood;
- external outputs are in the state expected by the next action.

Start separately unless you have a reason to combine rewind and start:

```json
{
  "runDir": "<run-id>"
}
```

Omit `chartPath`; the existing run metadata supplies the chart.

## Delete a run

```text
/hyperchart delete <run-id>
```

Deletion recursively removes the run directory. That includes:

- `meta.json`;
- `log.jsonl`;
- `status.json`;
- agent sessions and progress;
- rewind backups stored inside the run;
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
- use rewind so truncation is backed up and status is repaired consistently.

## Related pages

- [Runtime and durability](runtime-and-durability.md)
- [Pi commands and tools](pi.md)
- [Architecture and formal model](architecture.md)
