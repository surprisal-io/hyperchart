# Operations

## Inspect a chart

```json
{
  "chartPath": ".pi/hypercharts/example.chart.ts"
}
```

Use `hyperchart_inspect` for source, topology, contracts, schemas, transitions, and definition issues. It does not start a run.

## Start a run

```json
{
  "chartPath": "example",
  "args": {},
  "wait": false
}
```

Use `wait: true` only when the caller must block for terminal status. Otherwise keep the returned run id/directory and inspect later.

## Inspect a concrete run

```json
{
  "runDir": "<run-id>"
}
```

Use `hyperchart_run_inspect`. Check:

- process status and heartbeat;
- current states and visits;
- pending/resolved invocations;
- validation attempts;
- map generation and instance status;
- runtime/replay issues;
- sessions, usage, and artifacts.

## Resume

```json
{
  "runDir": "<run-id>"
}
```

Call `hyperchart_run` with the existing `runDir`. Omit `chartPath`; `meta.json` supplies it. Do not set `ignoreReplayWarnings` until the incompatibility has been reviewed.

## Slash command

```text
/hyperchart
/hyperchart run <name> --args '{"key":"value"}'
/hyperchart view <run-id>
/hyperchart resume <run-id>
/hyperchart restart <run-id>
/hyperchart status
/hyperchart stop <run-id>
/hyperchart delete <run-id>
```

Statuses are `starting`, `running`, `complete`, `failed`, `stopping`, and `stopped`.

## Report results

Always include:

- run id and absolute run directory;
- chart id;
- current or terminal status;
- output artifact paths;
- unresolved validation, session, replay, or external-side-effect risks.
