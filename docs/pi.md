# Pi extension

`@surprisal/pi-hyperchart` adds chart discovery, run management, one consolidated `hyperchart` agent tool, compact terminal progress/history surfaces, a localhost React inspector, and a bundled `hyperchart` skill to Pi.

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

Run `/hyperchart` with no arguments to open the minimal run picker for the current working directory. Use ↑/↓ to select a run, Enter to open its browser inspector, and Esc to close the picker.

Over SSH, set `HYPERCHART_INSPECTOR_PORT` to a fixed port and forward it (`ssh -L <port>:127.0.0.1:<port>`); the inspector then skips opening a server-side browser and the printed URL works through the tunnel. A fixed port serves one process — when another session already holds it, the inspector falls back to an ephemeral port and the printed URL carries the actual port. Alternatively `HYPERCHART_INSPECTOR_HOST=0.0.0.0` binds all interfaces and advertises the machine's LAN address in inspector URLs — the per-run URL token is the only access control in that mode, so use it on trusted networks only.


For active agent states, the selected state's run-specific `Runtime` section expands automatically and shows `View session`. Agent cards show definition metadata plus declared `role`/`toolset` and their resolved model/tool allowlist; they never embed session controls. The session window polls the persisted Pi transcript, completed reasoning blocks, current tool activity, and throttled live text/reasoning deltas alongside the run. Its composer sends a steering message to the runner through a run-scoped local queue; Pi delivers it after the agent's current tool call. Steering is available only while the runner and matching agent session are active.

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
| `--wait` | wait until terminal status or the session's globally active user gate |
| `--ignore-replay-warnings` | continue despite stale or skipped replay records |

Runs are asynchronous by default. Pi shows a compact live widget with active states and the same path-aware percentage used by the React inspector: completed visits on the actual run path versus the shortest remaining transition path. On startup or session resume, Pi restores widgets only for non-terminal runs created by that exact Pi session; terminal runs and older runs without ownership metadata remain available through run history but do not appear as active widgets.

When an owned background run reaches matching `complete`/`failed` status, Pi injects a compact terminal notice as a model-facing follow-up into the exact originating session and working directory; the durable terminal prompt stays out of the session log. Pi sends before confirming the terminal request id; session recovery checks both confirmed receipts and already-persisted custom messages before sending. A stale dead runner is terminalized through the durable outbox recovery operation and surfaced on recovery.

A durable `user()` action is routed through the same exact session/canonical-cwd ownership boundary. Every branch persists its gate immediately, while Pi presents only one across all owned runs in lexical `runId`, then numeric `seqId` order. If Pi is busy, a hidden steering message asks it to finish the current safe action/tool batch and yield; on idle or `agent_settled`, Pi rechecks and displays the question without triggering a model turn. The user's next ordinary prompt is bound to that gate and the model must immediately translate it into an explicit `action: "respond"` call instead of answering the gate itself. Only that branch waits; the detached runner and other parallel/map branches continue.

Add `--wait` when the command should remain blocked; the waited call uses the same arbiter and returns either terminal status or the globally active user gate, even when that gate belongs to a different owned run. Do not start a polling watcher.

```text
/hyperchart run review --args '{"pullRequest":42}'
/hyperchart run review --args '{"pullRequest":42}' --wait
```

### Resume or restart

```text
/hyperchart resume <run-id>
/hyperchart resume <run-id> --ignore-replay-warnings
/hyperchart restart <run-id>
```

`resume` continues in the existing run directory. `restart` creates a new run using the old run's chart metadata and arguments; it does not mutate the old log.

### Steer a live agent

The browser inspector and integrated hosts use the same command transport:

```text
/hyperchart steer <run-id> <action-key> <message>
```

The command validates run ownership and requires the matching session to be `starting` or `running`, then writes the message to the run-scoped steering queue. Normal users should use the session window composer rather than copying action keys manually.

### View status

```text
/hyperchart status
/hyperchart view <run-id>
/hyperchart <run-id>
```

`view` opens the full React inspector for that run in the system browser. A bare run id is shorthand when it resolves to a run in the current working directory. The extension starts one loopback-only HTTP server lazily per active Pi session and selects the run through a unique URL; it does not duplicate graph, session, or transcript inspection in the TUI. Pi closes the server during session shutdown, reload, switch, or fork, so reopen the inspector from the new session when needed.

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

Delete recursively removes the run directory, including its durable log with every branch and preserved sibling history, status, session data, and run-local artifacts. Copy important runs outside the run directory before deletion. Deletion is not a rewind and has no built-in restore command.

## Agent tool

The extension registers one `hyperchart` tool. Set `action` to `list`, `inspect`, `run`, `run_inspect`, `view`, `rewind`, `stop`, or `respond`. The slash command remains the direct human interface.

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

`chartPath` is required and `exportName` is optional. The tool always returns a bounded digest of identity, topology, agent availability, and diagnostics. The deprecated `verbose: true` form is rejected; use `action: "view"` for full source, contracts, schemas, and state definitions.

Full chart definitions never enter Pi tool results or session JSONL. Loading still executes the selected module's top-level TypeScript, but the complete inspection model is retained only behind the browser inspector's on-demand HTTP surface.

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
| `wait` | no | wait for terminal status or the shared active user gate before returning |
| `ignoreReplayWarnings` | no | explicitly continue despite stale/skipped replay records |

When `wait` is false or omitted, the tool returns after startup with `final: false`, chart/run ids, the absolute run directory, and compact status only. Owned user gates and eventual terminal boundaries are delivered asynchronously to the exact originating Pi session and canonical working directory.
When `wait` is true, the tool participates in the same cross-run arbiter and returns a compact terminal status or a `boundary: "user"` with a bounded prompt preview, options whose bounded labels are separate from exact values, exact allowed events, a non-executable structured-output hint, and the original `waitedRun` coordinate. Every display string includes `originalChars` and `omittedChars`. Response coordinates and identities are never ellipsized; an unsafe identity or total gate envelope fails closed and routes completion to the browser inspector. It never embeds a run inspector model, terminal prompt payload, transcript, full prompt, or raw reply schema. User-gate identity is exactly `(runId, seqId)`. Presentation is at least once across recovery; response persistence is idempotent.

### `hyperchart` with `action: "respond"`

After Pi displays a gate, the user's next normal prompt is treated as the answer. Pi injects hidden context requiring an immediate explicit call:

```json
{
  "action": "respond",
  "runId": "review-20260723-120000",
  "seqId": 14,
  "event": "APPROVED",
  "output": { "note": "Ship it." }
}
```

`event` must be one of the gate's exact allowed non-`FAILED` events and `output` must satisfy its reply contract when present. Copy `runId`, `seqId`, event names, and option values exactly; only display labels/previews may be shortened, and their metadata states the original and omitted character counts. The delivered non-executable summary recursively covers allowed values, nested required/optional fields, arrays, alternatives, defaults, nullability, and supported constraints. If an identity or the contract cannot be represented within its field/collection/depth/node/value/byte caps, Pi fails delivery closed and directs the operator to the browser inspector instead of showing a partial gate. The extension rejects wrong-session, wrong-cwd, non-active, stale, closed, or conflicting responses. Repeating the identical answer succeeds idempotently. Gate messages never expose an `effectId` or separate `requestId`.

### `hyperchart` with `action: "run_inspect"`

Load a concrete run and return the runtime-enriched inspector model.

```json
{
  "action": "run_inspect",
  "runDir": "review-20260711-142500"
}
```

| Parameter | Required | Meaning |
|---|---:|---|
| `runDir` | yes | existing run directory/id |
| `verbose` | no | deprecated; `true` is rejected with a direction to `hyperchart view` |

The result is always a bounded digest: run identity/status, capped state activity, concise issues, session counters/current-activity previews, and artifact paths. Full runtime states, visits, invocations, map histories, schemas, and transcripts never enter tool results or session JSONL; they are available only through `view`.

### `hyperchart` with `action: "view"`

Open the localhost browser inspector and return exactly `{ "url": string }`. Pass exactly one of `runDir` or `chartPath`; `chartPath` opens a static inspector for a chart definition without a run.

```json
{
  "action": "view",
  "runDir": "review-20260711-142500"
}
```

Alternatively, open a static chart inspector without a run:

```json
{ "action": "view", "chartPath": ".pi/hypercharts/review.chart.ts" }
```

Set `"open": false` to start the inspector and return its URL without opening the system browser. For a run, the run must belong to the current working directory. `view` returns exactly `{ "url": string }`; complete data is fetched on demand by the browser and does not enter the host session JSONL. The inspector supports the same live polling and session steering as `/hyperchart view`.

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

### Branch actions and non-destructive rewind

All run, run inspection, view, response, and rewind calls carry explicit `branchId`. Use `action: "branches"` to list durable named heads. `action: "fork"` requires `runDir`, a new `branchId`, and `fromSeqId`; it creates the pointer without selecting or starting it.

```json
{ "action": "rewind", "runDir": "review-20260711-142500", "branchId": "main", "seqId": 42, "mode": "after" }
```

Rewind is stopped-only and appends a move of only that branch head. Select exactly one of `state`, `seqId`, or `to: "compatible"`. It preserves every record, session, gate, notification, and artifact. `start: true` starts exactly the named branch. Checkout/view is non-durable and never writes `log.jsonl`.

## Run files

By default, run directories live under:

```text
${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/hypercharts/runs/<run-id>/
```

| Path | Owner | Meaning |
|---|---|---|
| `meta.json` | runner | chart path/export, args, working directory, run identity, originating Pi session |
| `log.jsonl` | core runtime | append-only v2 record-batch and named-branch mutations |
| `status.json` | Pi runner | process state, explicit runner branch, pid, heartbeat, exit, error |
| `user-interactions/<branchId>/<seqId>/` | runner + host | exact branch-scoped request, immutable resolution, and receipts |
| `sessions/` | Pi executor | branch/invocation-scoped agent sessions and progress |

Only `log.jsonl` defines durable record history and named heads. Selected UI/view branch remains non-durable.

## Agent definitions

An agent action names a Pi agent definition:

```ts
agent("reviewer", { task: "Review the change." })
```

The Pi adapter checks bundle `agents/` first, then resolves project and user agent-definition directories using Pi's normal rules. The definition supplies system prompt, model, thinking level, and tool defaults. Chart-level values may override invocation settings.

A definition can declare a symbolic `role` instead of a concrete model and a symbolic `toolset` instead of a tool list; both map to concrete values in `settings.json` under `<projectRoot>/.pi/hypercharts/` or `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/hypercharts/` (project entries win per key), e.g. `{ "roles": { "reviewer": "anthropic/claude-opus-4-8" }, "toolsets": { "reading": ["read", "grep"] } }`. An unconfigured name falls back to the definition's `model`/`tools`; with no fallback declared the action fails with an error. The inspector shows both symbolic names and resolved values. For a concrete run it uses the role/toolset mappings persisted in `runner.config.json`, while `Runtime` reports the session plan actually launched. An absent explicit tool list is labelled as the host default, never as “all tools allowed.” See [Core authoring](core-authoring.md#model-roles) for the resolution order.

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
