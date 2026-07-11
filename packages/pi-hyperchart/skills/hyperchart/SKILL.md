---
name: hyperchart
description: Author, inspect, run, resume, debug, and safely recover durable TypeScript Hyperchart workflows in Pi. Use for .chart.ts files, hyperchart_* tools, typed refs, artifacts, replay warnings, and runtime troubleshooting.
license: MIT
compatibility: Requires Node.js >=22.19 and the @surprisal-io/pi-hyperchart Pi package.
---

# Hyperchart agent procedure

Use the `hyperchart_*` tools directly. `/hyperchart` is a human-facing Pi command and is not part of this agent procedure.

## Choose the tool

| Task | Tool |
|---|---|
| Validate and inspect a chart definition | `hyperchart_inspect` |
| Start a chart or resume an existing run | `hyperchart_run` |
| Inspect durable state for one run | `hyperchart_run_inspect` |
| Back up and truncate a stopped run | `hyperchart_rewind` |

## Author or modify a chart

1. Read the existing `.chart.ts` file and nearby chart examples.
2. Keep control flow explicit in the chart. Agents and scripts return events and data; they do not choose hidden next states.
3. Prefer `refs()` plus Zod-backed replies, inputs, and artifacts. Use transition inputs for visit-local handoff and artifacts for file deliverables.
4. Call `hyperchart_inspect` after every structural change.
5. Resolve all diagnostics and unavailable agent definitions before starting a real run.
6. Do not start the chart unless the user asked to execute it.

Canonical DSL and API reference: https://github.com/surprisal-io/hyperchart/tree/main/docs/api

## Start a run

1. Inspect the chart first with `hyperchart_inspect`.
2. Verify every named agent definition is available.
3. Call `hyperchart_run` with `chartPath` and `args`.
4. Use `wait: true` only when the current task must block until terminal status. Otherwise retain the returned run id and directory.
5. Inspect the concrete result with `hyperchart_run_inspect` before reporting completion.

## Resume a run

1. Call `hyperchart_run_inspect` with the existing run id or directory.
2. Check process status, pending invocations, validation attempts, replay findings, sessions, and artifacts.
3. Reconcile any external file, API, or remote side effect that may have succeeded before a crash.
4. Resume with `hyperchart_run` using `runDir` alone. To create a different run, use `chartPath` without an existing `runDir`.
5. Do not set `ignoreReplayWarnings` unless the incompatibility has been explained and the user explicitly accepts the risk.

## Rewind a run

1. Inspect the run and confirm it is stopped.
2. Choose exactly one target: `state`, `seqId`, or `to: "compatible"`.
3. Explain which durable facts will be removed and that external effects will not be undone.
4. Call `hyperchart_rewind`. Keep `cleanupArtifacts: false` unless the user explicitly requests best-effort artifact cleanup.
5. Inspect the rewound run again before starting it.

## Safety rules

- Chart modules are executable TypeScript. Loading one can execute top-level code even when no workflow action is dispatched.
- Never edit `log.jsonl` manually.
- Never rewind a live run.
- Never treat a missing agent definition as an unrestricted default.
- Stop, rewind, replay, and deletion do not undo arbitrary external effects.
- Back up important runs outside their run directory before destructive recovery.
- Treat `ignoreReplayWarnings` as an assertion, not a repair.

## Report

Include the chart id, run id, absolute run directory, current or terminal status, artifact paths, and unresolved validation, replay, session, or external-side-effect risks.
