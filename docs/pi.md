# Pi extension

`@surprisal/pi-hyperchart` adds chart discovery, run management, one consolidated `hyperchart` agent tool, a terminal run view, a React inspector, and a bundled `hyperchart` skill to Pi.

It does not define chart semantics. Those come from the exact matching version of `@surprisal/hyperchart`.

## Install

Install the Pi package from your shell:

```sh
pi install npm:@surprisal/pi-hyperchart
```

Start Pi after the install, or restart an existing Pi process. Pi loads:

- `extensions/hyperchart.ts`;
- `skills/hyperchart/SKILL.md`.

The extension and skill are declared in the package's `pi` manifest. See [Pi Packages](https://pi.dev/docs/latest/packages) for package scope and installation behavior.

For local repository development, run:

```sh
npm install
npm run build
pi
```

The repository root `package.json` points Pi at the workspace extension and skill.

## Discovery

A chart name resolves from the current project first, then from user scope:

| Scope | Flat chart | Self-contained bundle |
|---|---|---|
| project | `.pi/hypercharts/*.chart.ts` | `.pi/hypercharts/<name>/chart.ts` |
| user | `~/.pi/agent/hypercharts/*.chart.ts` | `~/.pi/agent/hypercharts/<name>/chart.ts` |

Project definitions override same-name user definitions. You may also pass an absolute or relative module path.

### Self-contained bundles

Use a bundle when chart needs private agents, extensions, guards, or scripts:

```text
hypercharts/video-review/
├── chart.ts
├── agents/
│   ├── analyzer.md
│   └── localizer.md
├── extensions/
│   └── video-tools/
│       └── index.ts
├── scripts/
└── guards/
```

Rules:

- `chart.ts` defines bundle entrypoint and discovery name.
- `agents/` definitions override project and user definitions only for this chart.
- `extensions/<name>/index.ts` exports a default Pi extension registration function.
- Bundle extensions register when Pi loads or reloads Hyperchart.
- Project bundle overrides same-name user bundle, including its extensions.
- Guards and chart-owned paths resolve relative to `chart.ts`.
- Extension implementation files do not appear as separate charts.
- Flat charts remain supported.

A run id is visible only from the working directory recorded in its `meta.json`. Open the owning directory before viewing, resuming, stopping, or rewinding that run.

## `/hyperchart`

Run `/hyperchart` with no arguments to open recent runs for the current working directory.

```text
/hyperchart
/hyperchart --limit 20
```

### Start a run

```text
/hyperchart run <name-or-chart.ts> [options]
```

Options:

| Option | Meaning |
|---|---|
| `--args <json>` | run arguments object |
| `--run-dir <run-id-or-path>` | existing run to resume, or explicit destination directory |
| `--export <name>` | named chart export instead of the default export |
| `--ignore-replay-warnings` | continue despite stale or skipped replay records |

Example:

```text
/hyperchart run review --args '{"pullRequest":42}'
```

### Resume or restart

```text
/hyperchart resume <run-id>
/hyperchart resume <run-id> --ignore-replay-warnings
/hyperchart restart <run-id>
```

`resume` continues in the existing run directory. `restart` creates a new run using the old run's chart metadata and arguments; it does not mutate the old log.

### View status

```text
/hyperchart status
/hyperchart view <run-id>
/hyperchart <run-id>
```

`view` opens the terminal run view. A bare run id is shorthand when it resolves to a run in the current working directory.

### Stop a run

```text
/hyperchart stop <run-id>
```

Stopping requests process termination and changes operational status. It does not undo scripts, files, API calls, or agent-side effects that already occurred.

### Delete a run

```text
/hyperchart delete <run-id>
/hyperchart rm <run-id>
```

Delete recursively removes the run directory, including its durable log, status, session data, and rewind backups stored inside that directory. Copy important runs outside the run directory before deletion. Deletion is not a rewind and has no built-in restore command.

## Agent tool

The extension registers one `hyperchart` tool. Set `action` to `list`, `inspect`, `run`, `run_inspect`, `rewind`, or `stop`. The slash command remains the direct human interface.

### `hyperchart` with `action: "list"`

List project and user definitions without executing chart modules. Each result includes chart name, scope, and absolute path.

```json
{ "action": "list" }
```

### `hyperchart` with `action: "inspect"`

Load a chart module and return its static inspector model without starting a run.

```json
{
  "action": "inspect",
  "chartPath": ".pi/hypercharts/review.chart.ts",
  "exportName": "reviewChart"
}
```

`chartPath` is required. `exportName` is optional.

The result contains source, contracts, topology, transitions, schemas, and definition issues. It contains no run status, visits, usage, session failures, or artifacts from a concrete run.

> The tool loads executable TypeScript. It does not dispatch chart actions, but top-level code in the module can run with your permissions.

### `hyperchart` with `action: "run"`

Start or resume a run.

```json
{
  "action": "run",
  "chartPath": "review",
  "args": { "pullRequest": 42 },
  "wait": true
}
```

| Parameter | Required | Meaning |
|---|---:|---|
| `chartPath` | no | chart name or module path; omit when `runDir` identifies an existing run |
| `args` | no | run arguments object |
| `runDir` | no | existing run directory/id or destination directory |
| `exportName` | no | named export |
| `wait` | no | wait for terminal status before returning |
| `ignoreReplayWarnings` | no | explicitly continue despite stale/skipped replay records |

When `wait` is false or omitted, the tool returns after startup with `final: false`. When `wait` is true, it returns the terminal status and runtime-enriched inspector model.

### `hyperchart` with `action: "run_inspect"`

Load a concrete run and return the runtime-enriched inspector model.

```json
{
  "action": "run_inspect",
  "runDir": "review-20260711-142500"
}
```

The overlay includes run status, runtime issues, visits, resolved invocations, map generations, validation attempts, artifacts, usage, session failures, and replay findings. Historical tool results remain historical snapshots; rerun the tool to read new facts.

### `hyperchart` with `action: "stop"`

Stop one run:

```json
{ "action": "stop", "runDir": "review-20260711-142500" }
```

Stop every active run owned by current working directory:

```json
{ "action": "stop", "all": true }
```

Exactly one of `runDir` or `all: true` required.

### `hyperchart` with `action: "rewind"`

Back up and truncate a stopped run log.

```json
{
  "action": "rewind",
  "runDir": "review-20260711-142500",
  "state": "review",
  "mode": "before"
}
```

Exactly one target is required:

- `state` — state or runtime instance path;
- `seqId` — durable record sequence id;
- `to: "compatible"` — first prefix compatible with the current chart.

Other parameters:

| Parameter | Default | Meaning |
|---|---:|---|
| `mode` | `before` | cut before or after the matching record |
| `cleanupSessions` | `true` | move downstream session directories/progress into the backup |
| `cleanupArtifacts` | `false` | best-effort backup and removal of downstream declared artifact files |
| `start` | `false` | start the rewound run immediately |
| `ignoreReplayWarnings` | `false` | when starting, allow stale/skipped records explicitly |

A live run cannot be rewound. Read [Recovery and safety](safety.md#rewind-a-run) before using this tool.

## Run files

By default, run directories live under:

```text
${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/hypercharts/runs/<run-id>/
```

| Path | Owner | Meaning |
|---|---|---|
| `meta.json` | runner | chart path/export, args, working directory, run identity |
| `log.jsonl` | core runtime | ordered semantic facts |
| `status.json` | Pi runner | process state, pid, heartbeat, exit, error |
| `sessions/` | Pi executor | agent sessions and progress |
| `rewind-backups/` | rewind tool | timestamped copies of truncated state |

Only `log.jsonl` defines semantic history. The other files describe how the current process and host are doing.

## Agent definitions

An agent action names a Pi agent definition:

```ts
agent("reviewer", { task: "Review the change." })
```

The Pi adapter checks bundle `agents/` first, then resolves project and user agent-definition directories using Pi's normal rules. The definition supplies system prompt, model, thinking level, and tool defaults. Chart-level values may override invocation settings.

If the concrete definition cannot be loaded, inspection reports `agentDefinitionUnavailable`, and execution refuses to run that state.

## Run lifecycle

Operational status normally moves through:

```text
starting → running → complete
                   ↘ failed
running  → stopping → stopped
```

A dead pid or stale heartbeat can make a run operationally stale while its durable log remains valid. Inspect both layers before deciding to resume or rewind.

## Reload behavior

Auto-discovered extensions and skills can be refreshed with `/reload`. An extension loaded explicitly with `pi -e` may remain bound to the process. If behavior or exports appear stale, exit Pi and start a new process.

## Troubleshooting

### `Cannot find module @surprisal/hyperchart`

Install the Pi package normally instead of copying only `extensions/hyperchart.ts`. Pi package installs use production dependencies; copied source files do not bring their dependency tree.

### A chart is missing from completion

Check the filename and scope:

- `.pi/hypercharts/name.chart.ts` or `.pi/hypercharts/name/chart.ts` for project scope;
- `~/.pi/agent/hypercharts/name.chart.ts` or `~/.pi/agent/hypercharts/name/chart.ts` for user scope.

You can still pass an explicit path.

### A run belongs to another directory

Change into the working directory recorded in `meta.json`, then reopen Pi. Run ids are scoped by working directory to avoid mutating unrelated projects.

### Replay blocks startup

Do not add `--ignore-replay-warnings` first. Inspect the run, read the stale/skipped/broken explanation, compare the current chart with the chart that produced the log, then choose resume, restart, or rewind. See [Replay warnings](safety.md#replay-warnings).

## Next steps

- [Run your first chart](quickstart.md)
- [Recovery and safety](safety.md)
- [React and host integration](integration.md)
- [Exact Pi tool and status reference](api/pi.md)
