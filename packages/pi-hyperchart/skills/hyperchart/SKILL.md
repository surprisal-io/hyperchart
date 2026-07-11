---
name: hyperchart
description: Author, inspect, run, resume, debug, and safely recover durable TypeScript Hyperchart workflows in Pi. Use for .chart.ts files, /hyperchart commands, hyperchart_* tools, typed refs, artifacts, replay warnings, and runtime troubleshooting.
license: MIT
compatibility: Requires Node.js >=22.19 and the @surprisal-io/pi-hyperchart Pi package.
---

# Hyperchart workflow skill

Use Hyperchart when work has explicit stages, typed handoffs, parallel/map fan-out, validation, or must resume after a crash.

## Route by task

1. **Author/change a chart:** read [authoring](references/authoring.md), place project charts in `.pi/hypercharts/<name>.chart.ts`, and import from `@surprisal-io/hyperchart`.
2. **Inspect before running:** call `hyperchart_inspect`; resolve diagnostics before execution.
3. **Start/resume/observe:** read [operations](references/operations.md), use `hyperchart_run`, then `hyperchart_run_inspect` for concrete state.
4. **Recover history:** read [safety](references/safety.md) before any replay override or `hyperchart_rewind`.
5. **Need full detail:** use the canonical [GitHub documentation](https://github.com/surprisal-io/hyperchart/tree/main/docs).

## Working rules

- Prefer typed `refs()` and schema-backed replies/artifacts; never hide a diagnostic with `any`.
- Keep workflow routing in the chart and agent roles focused.
- Inspect an unfamiliar chart before running it. Confirm arguments and paths.
- Never edit `log.jsonl`, rewind a live run, or casually use `--ignore-replay-warnings`.
- Before destructive recovery: stop, inspect, back up, identify exactly one rewind target, and account for external side effects.
- Resume existing durable work instead of starting duplicate agents.
- Report run ID/directory and terminal state; include validation/replay warnings.

The reference links above are relative to this file and are included in the npm package.
