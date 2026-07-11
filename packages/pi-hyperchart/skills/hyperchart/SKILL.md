---
name: hyperchart
description: Author, inspect, run, resume, debug, and safely recover durable TypeScript Hyperchart workflows in Pi. Use for .chart.ts files, /hyperchart commands, hyperchart_* tools, typed refs, artifacts, replay warnings, and runtime troubleshooting.
license: MIT
compatibility: Requires Node.js >=22.19 and the @surprisal-io/pi-hyperchart Pi package.
---

# Hyperchart

Hyperchart runs explicit statecharts and records semantic facts in `log.jsonl` so work can be inspected and resumed.

## Choose the procedure

- **Write or change a chart:** read [Authoring](references/authoring.md).
- **Start, resume, or inspect a run:** read [Operations](references/operations.md).
- **Override replay, rewind, stop after a crash, or delete:** read [Safety](references/safety.md) first.

## Rules

1. Treat chart modules as executable TypeScript. `hyperchart_inspect` does not dispatch actions, but module loading can execute top-level code.
2. Inspect the normalized chart before the first real run. Resolve structural and missing-agent-definition issues.
3. Prefer typed `refs()` and schema-backed replies, inputs, and artifacts.
4. Keep routing in the chart. Agents return events and data; they do not choose hidden next states.
5. Reinspect a concrete run before deciding to resume, restart, or rewind.
6. Never edit `log.jsonl` manually, rewind a live run, or override replay warnings without explaining the incompatibility.
7. External side effects are not rolled back. Reconcile files, APIs, and remote work before retrying an ambiguous invocation.
8. Back up important runs outside their run directory before rewind or deletion.
9. Report the run id, run directory, current/terminal status, and unresolved replay or validation issues.

Canonical manual: [Hyperchart documentation](https://github.com/surprisal-io/hyperchart/tree/main/docs).
