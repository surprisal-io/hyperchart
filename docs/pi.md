# Pi extension: install, operate, inspect, and recover

`@surprisal-io/pi-hyperchart` is a Pi package containing one extension, one bundled `hyperchart` skill, the Pi runtime/host adapter, terminal UI, and React inspector.

## Install

Global installation:

```sh
pi install npm:@surprisal-io/pi-hyperchart
```

Project-local installation:

```sh
pi install -l npm:@surprisal-io/pi-hyperchart
```

Try without persisting settings:

```sh
pi -e npm:@surprisal-io/pi-hyperchart
```

Pi discovers `extensions/hyperchart.ts` and `skills/hyperchart/` from the package's `pi.extensions` and `pi.skills` manifest entries. Pi packages execute with full system access; review package source before installation.

Use `pi list` to verify the package and `pi config` to enable/disable its extension or skill. The skill is available as `/skill:hyperchart` when skill commands are enabled.

## Chart discovery

Project charts live in:

```text
.pi/hypercharts/*.chart.ts
```

The command/tools accept:

- a discovered basename such as `review`;
- `review.chart.ts` under the project chart directory;
- an explicit relative or absolute module path;
- an optional named export.

Project charts take their normal project trust boundary. TypeScript source is linted/typechecked before a run starts. Fix diagnostics instead of bypassing them with casts.

## Slash command reference

```text
/hyperchart
/hyperchart --limit N
/hyperchart <runId>
/hyperchart run <name|chart.ts> [--args JSON] [--run-dir RUN_ID|DIR] [--export NAME] [--ignore-replay-warnings]
/hyperchart resume <runId> [--ignore-replay-warnings]
/hyperchart restart <runId>
/hyperchart status
/hyperchart view [runId]
/hyperchart stop <runId>
/hyperchart delete <runId>
/hyperchart rm <runId>
```

| Form | Behavior |
|---|---|
| no arguments | Opens recent runs in TUI; in non-TUI modes prints a compact list. |
| `--limit N` | Limits the recent-run list (`-n N` is also accepted). |
| bare run ID | Opens that run's view. |
| `run` | Starts a chart, or resumes/targets a run directory with `--run-dir`. |
| `resume` | Continues an existing durable run. |
| `restart` | Creates a new run using the original chart/export and persisted arguments. |
| `status` | Shows attached/live/recent status. |
| `view` | Opens the TUI run overlay or prints the directory outside TUI. |
| `stop` | Sends termination to a live runner or marks a dead runner stopped. |
| `delete` / `rm` | Confirms, stops if necessary, then recursively removes the run directory. |

`--args` must be a JSON object. Quote it for your shell/editor, for example:

```text
/hyperchart run review --args '{"topic":"durable agents"}'
```

`--run-dir` can name an existing run to resume or an explicit destination. A run may only be controlled from the work directory recorded in its metadata.

`requestHyperchartCommand()` from `@surprisal-io/pi-hyperchart/command` lets another Pi extension invoke the same handler through Pi's shared event bus. It returns `false` if the Hyperchart extension did not claim the request.

## Tool reference

### `hyperchart_inspect`

Static inspection without a run.

| Parameter | Required | Meaning |
|---|---:|---|
| `chartPath` | yes | Discovered chart name or module path. |
| `exportName` | no | Named export; default is `default`. |

The result contains normalized source/graph/contracts/diagnostics and resolved Pi agent defaults. It does not contain statuses, visits, logs, sessions, or usage.

Use this before running an unfamiliar or modified chart.

### `hyperchart_run`

Start or resume.

| Parameter | Required | Meaning |
|---|---:|---|
| `chartPath` | unless resuming | Chart name/path. |
| `args` | no | Run argument object. |
| `runDir` | no | Existing run to resume or destination directory. |
| `exportName` | no | Named chart export. |
| `wait` | no | Wait for terminal status and return final inspector data. |
| `ignoreReplayWarnings` | no | Explicitly continue despite stale/skipped warnings. Default `false`. |

When `wait` is false, the tool returns after launching/attaching and includes the initial runtime inspector model. When true, cancellation of the calling turn does not make external side effects reversible; inspect the run afterward.

### `hyperchart_run_inspect`

Runtime inspection of one run.

| Parameter | Required | Meaning |
|---|---:|---|
| `runDir` | yes | Run ID or directory. |

The result overlays durable facts, status, issues, session progress, visits, resolved invocations, usage, artifacts, map generations, stale states, and current control flow on the static chart model.

### `hyperchart_rewind`

Back up and truncate a stopped run.

| Parameter | Required | Meaning |
|---|---:|---|
| `runDir` | yes | Existing run ID/directory. |
| exactly one of `state`, `seqId`, `to: "compatible"` | yes | Selects the cut target. |
| `mode` | no | `before` (default) or `after` the matching record. `to: compatible` always cuts before the first broken record. |
| `cleanupSessions` | no | Back up/remove downstream session progress and directories. Default `true`. |
| `cleanupArtifacts` | no | Best-effort backup/remove declared downstream artifact files. Default `false`. |
| `start` | no | Resume immediately after truncation. Default `false`. |
| `ignoreReplayWarnings` | no | Only applies when `start` is true. |

## Rewind reference

**Rewind is destructive to the active history tail.** It creates a timestamped backup under `rewind-backups/`, but the live log is then replaced by its kept prefix. A resumed run creates new facts from that point.

Safe sequence:

1. stop the run and verify it is not live;
2. call `hyperchart_run_inspect`;
3. inspect replay explanation and external side effects;
4. retain an independent backup when the run matters;
5. select one exact target;
6. rewind with `start: false`;
7. inspect files/status again;
8. resume only after review.

`state` matches runtime or template paths and cuts at the first matching durable record. `seqId` selects one exact record. `to: "compatible"` cuts before the first structurally broken replay record; it refuses to run when history is already structurally compatible.

Session cleanup moves downstream session directories into the backup. Artifact cleanup only knows declared artifacts and is best-effort. Neither option reverses network requests, commits, messages, deployments, or other external side effects.

## Run lifecycle

Status values are:

```text
starting → running → complete
                   ↘ failed
running → stopping → stopped
```

A detached runner writes a heartbeat. If the extension observes a lost heartbeat beyond its grace period, it marks the run failed. `complete`, `failed`, and `stopped` are terminal process statuses; a stopped run can later resume.

The extension restores run widgets on startup, reload, and session resume. `/hyperchart view` and `hyperchart_run_inspect` reconstruct state from durable facts rather than trusting UI memory.

## Run directory layout

Runs are stored below the Pi agent directory:

```text
$PI_CODING_AGENT_DIR/hypercharts/runs/<runId>/
  meta.json
  log.jsonl
  status.json
  runner.config.json
  runner.stdout.log
  runner.stderr.log
  sessions/
    progress.json              # optional
    <action-session dirs>/
  rewind-backups/              # only after rewind
```

`meta.json` records chart path/export, work directory, chart ID, and creation time. `status.json` is an atomic operational snapshot. `log.jsonl` is the semantic source of truth. `sessions/progress.json` is optional host progress and does not define workflow state.

Do not edit these files while a runner is live.

## Agent definitions and invocation defaults

`agent("name", options)` resolves Pi agent definitions from project and user definition directories. The definition supplies system prompt and defaults such as model, thinking, and tools. Chart options override per invocation. The task is a user message, not the agent system prompt.

If the definition cannot be loaded, static and runtime inspection marks the state unavailable; it does not display the misleading fallback "all tools allowed". Create/fix the agent definition before running.

Each agent receives an injected finish tool. Its completion event and payload must match the chart contract. Validation rejection may resume the same session or start a new attempt according to `onReject`.

## Inspection model

Use static inspect to answer “what is defined?” and run inspect to answer “what happened?”

Static information includes:

- validated DSL definition source;
- state topology and transitions;
- agent/script/user invocation contract;
- input, reply, artifact, and validation schemas;
- source diagnostics and agent-definition availability.

Runtime overlays include:

- current status/timestamps;
- active/pending/stale/skipped states;
- visit history and resolved invocations;
- validation attempts and issues;
- map item generations and fan-out progress;
- session usage and artifacts;
- replay/status/session-file issues.

Runtime issue sources are explicitly identified (`meta.json`, `log.jsonl`, `status.json`, or `sessions/progress.json`).

## Reload behavior

Auto-discovered package resources reload with `/reload`. An extension passed explicitly with `--extension` may remain bound to the old process/module graph; exit and start/resume the Pi session when a changed explicitly loaded extension does not update.

## Troubleshooting

### Package or tool missing

1. `pi list` — confirm the scoped package is installed.
2. `pi config` — confirm extension and skill are enabled in the intended scope.
3. `/reload` — reload package resources.
4. Restart Pi if the package was supplied through an explicit extension flag.

### Chart not found

Check current working directory and `.pi/hypercharts/<name>.chart.ts`; otherwise pass an explicit path. Use `exportName` for named exports.

### Typecheck/module-load failure

Run the chart's TypeScript diagnostics directly. Ensure ESM imports use installed package names and the module is data-first. Avoid inline closures in chart definitions.

### Run appears stuck

Inspect status and run details, then check `runner.stderr.log`, heartbeat, PID, and current pending action. Do not immediately restart; doing so can duplicate external work.

### Replay warning

Read [Replay explanation](runtime-and-durability.md#replay-explanation). Compare stored provenance with the current chart. Prefer a new run for material changes.

### Schema or artifact rejection

Inspect the producer's completion payload, declared schema, artifact path, and validation feedback. Verify structured files are valid JSON where required.

### React styles missing

Import `@surprisal-io/pi-hyperchart/react/styles.css` exactly once and follow [React integration](integration.md#react-inspector).
