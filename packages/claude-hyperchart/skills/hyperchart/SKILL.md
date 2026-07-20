---
name: hyperchart
description: Author, list, inspect, run, steer, and debug durable TypeScript Hyperchart workflows in Claude Code. Use for .chart.ts files, the hyperchart_* MCP tools, typed refs, artifacts, replay warnings, live agent sessions, and runtime troubleshooting.
license: MIT
---

# Hyperchart agent procedure

Hypercharts are durable, typed statechart workflows. Each agent action of a chart runs as a real Claude session in a detached background runner; runs survive restarts and are inspectable in a localhost browser inspector.

## Choose the tool

| Task | Tool |
|---|---|
| List chart definitions and this directory's runs | `hyperchart_list` |
| Validate and inspect a chart definition | `hyperchart_inspect` |
| Start a chart or resume an existing run | `hyperchart_run` |
| Inspect durable state for one run | `hyperchart_run_inspect` |
| Steer a live agent session of a run | `hyperchart_steer` |
| Stop one or all active runs | `hyperchart_stop` |
| Open the browser inspector for a run | `hyperchart_view` |

Pass `cwd` explicitly when working outside the session's starting directory.

## Discover available charts

1. Project scope: nearest ancestor containing `.claude` (or `.agents`), then `.claude/hypercharts/` below it.
2. User scope: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hypercharts/`.
3. Prefer `hyperchart_list`; it applies scope precedence without loading chart modules. Chart modules execute top-level TypeScript when inspected — inspect only the selected chart with `hyperchart_inspect`.

Self-contained workflow layout:

```text
hypercharts/<name>/
├── chart.ts
├── agents/
└── scripts/
```

Agent definitions are markdown files with frontmatter (`name`, `description`, `model`, `thinking`, `tools`, `systemPromptMode`); the body is the agent's system prompt. Resolution order: `<chartDir>/agents`, `<projectRoot>/.claude/agents`, `<projectRoot>/.agents`, `~/.agents`, `~/.claude/agents`. Model ids are passed to the Claude Agent SDK verbatim (e.g. `claude-sonnet-5`, `claude-opus-4-8`).

## Author or modify a chart

1. Read the existing `.chart.ts` file and nearby chart examples.
2. Keep control flow explicit in the chart. Agents and scripts return events and data; they do not choose hidden next states.
3. Prefer `refs()` plus Zod-backed replies, inputs, and artifacts. Use transition inputs for visit-local handoff and artifacts for file deliverables.
4. Call `hyperchart_inspect` after every structural change and resolve all diagnostics and unavailable agent definitions before starting a real run.
5. Do not start the chart unless the user asked to execute it.

Put every substantial or reusable result in a declared artifact with a Zod shape; reserve `reply` for small routing data that belongs in a completion event. TypeScript catches producer/name/selector drift, runtime validation catches missing or invalid files, and durable artifacts make inspection and recovery easier than large prompt payloads.

## Start a run

1. Inspect the chart first with `hyperchart_inspect` and verify every named agent definition is available.
2. Call `hyperchart_run` with `chartPath` and `args`.
3. Use `wait: true` only when the current task must block until terminal status. Otherwise retain the returned run id and directory; the run continues in the background.
4. Inspect the concrete result with `hyperchart_run_inspect` before reporting completion.

## Watch and steer a run

- `hyperchart_view` opens the browser inspector: live chart graph, per-state details, and live agent session transcripts with a steering composer.
- `hyperchart_run_inspect` shows each session's `actionKey`, status, and current activity.
- `hyperchart_steer` queues a message for a `starting`/`running` session; the runner delivers it into the live Claude session after its current tool call.

## Resume a run

1. Call `hyperchart_run_inspect` with the existing run id or directory.
2. Check process status, pending invocations, validation attempts, replay findings, sessions, and artifacts.
3. Reconcile any external file, API, or remote side effect that may have succeeded before a crash.
4. Resume with `hyperchart_run` and `runDir`. Create a different run with `chartPath` and no `runDir`.
5. Do not set `ignoreReplayWarnings` unless the incompatibility has been explained and the user explicitly accepts the risk.

## Safety rules

- Chart modules are executable TypeScript. Loading one can execute top-level code even when no workflow action is dispatched.
- Never edit `log.jsonl` manually and never resume a run whose replay check reports incompatibilities without explicit user confirmation.
- Never treat a missing agent definition as an unrestricted default.
- Stop and deletion do not undo arbitrary external effects.
- Chart agent sessions run headless with permission checks bypassed inside the chart's working directory; guards and validators in the chart are the control surface. Do not point charts at directories the user has not approved.

## Report

Include the chart id, run id, absolute run directory, current or terminal status, artifact paths, and unresolved validation, replay, session, or external-side-effect risks.
