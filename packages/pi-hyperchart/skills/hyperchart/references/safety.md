# Safety

## Before resume after a crash

1. inspect the run with `hyperchart_run_inspect`;
2. identify pending invocations and last durable facts;
3. check whether external files/API calls already succeeded;
4. resume only when retry or reconciliation is safe;
5. otherwise restart as a new run and preserve the old run for evidence.

A completion may have happened externally before the process crashed and before its completion fact was appended.

## Before overriding replay warnings

1. stop live execution;
2. inspect every stale, skipped, or broken finding;
3. compare current chart/validator definitions with the log provenance;
4. make an independent backup;
5. prefer restart if meaning is uncertain.

Never override a broken record. `ignoreReplayWarnings` is an assertion, not a repair.

## Rewind

A run must be stopped. Choose exactly one target:

```json
{ "runDir": "<run-id>", "state": "path", "mode": "before" }
```

```json
{ "runDir": "<run-id>", "seqId": 42, "mode": "after" }
```

```json
{ "runDir": "<run-id>", "to": "compatible" }
```

Defaults: `cleanupSessions: true`, `cleanupArtifacts: false`, `start: false`.

After rewind, inspect again before starting. Rewind backs up truncated files inside the run directory but does not undo external effects.

## Delete

`/hyperchart delete <run-id>` recursively removes the run directory, including its durable log, sessions, status, and internal rewind backups. There is no restore command.

Stop, inspect, and copy important runs outside `.pi/hypercharts/runs/` before deletion.

## Never

- edit `log.jsonl` manually;
- rewind a live run;
- assume stop or rewind reverses external effects;
- treat missing agent definitions as harmless defaults;
- load untrusted chart modules without reviewing top-level TypeScript.
