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

## Bundled reference

Read the smallest local page that covers the task:

- [DSL and typed refs](../../docs/api/dsl.md) — authoring signatures, options, constraints, and examples.
- [Pi tools](../../docs/api/pi.md) — exact schemas for all four `hyperchart_*` tools and lifecycle statuses.
- [Runtime API](../../docs/api/runtime.md) — runtime, stores, scripts, guards, artifacts, and execution errors.
- [Recovery and safety](../../docs/safety.md) — replay warnings, crash ambiguity, rewind, cleanup, and external effects.
- [File and run contracts](../../docs/reference.md) — run layout, durable records, and limitations.
- [Documentation index](../../docs/README.md) — routes to every bundled guide and API page.

These files ship inside the Pi package. Prefer them over network documentation so the reference matches the installed version.

## Author or modify a chart

1. Read the existing `.chart.ts` file, the bundled [DSL reference](../../docs/api/dsl.md), and nearby chart examples.
2. Keep control flow explicit in the chart. Agents and scripts return events and data; they do not choose hidden next states.
3. Prefer `refs()` plus Zod-backed replies, inputs, and artifacts. Use transition inputs for visit-local handoff and artifacts for file deliverables.
4. Call `hyperchart_inspect` after every structural change.
5. Resolve all diagnostics and unavailable agent definitions before starting a real run.
6. Do not start the chart unless the user asked to execute it.

### Best practice: typed artifacts first

Put every substantial or reusable result in a declared artifact by default. Give JSON artifacts a Zod shape, mirror them in the `Files` registry passed to `refs()`, and pass them downstream with `artifactOf()` or `joinArtifactOf()`. Reserve `reply` for small routing data that belongs in a completion event.

This catches different failures at the right boundary:

- TypeScript catches a missing producer, artifact-name mismatch, invalid selector, or `Files` registry drift.
- Runtime validation catches a missing file, invalid JSON, or content that does not match the Zod shape.
- Durable files make inspection, recovery, replay analysis, and manual verification easier than large prompt/result payloads.

```ts
import { agent, artifact, final, refs, t, z } from "@surprisal-io/hyperchart";

const Report = z.object({
  title: z.string(),
  findings: z.array(z.string()),
});

const Review = z.object({
  approved: z.boolean(),
  issues: z.array(z.string()),
});

type Args = { topic: string };
type Files = {
  write: { report: z.infer<typeof Report> };
  review: { review: z.infer<typeof Review> };
};

const { chart, arg, artifactOf } = refs<
  Args,
  Record<never, never>,
  Files
>();

export default chart({
  kind: "chart",
  id: "typed-artifacts",
  initial: "write",
  states: {
    write: {
      kind: "state",
      action: agent("writer", {
        task: t`Research ${arg("topic")} and write the declared JSON report artifact.`,
        artifacts: {
          report: artifact("artifacts/report.json", Report),
        },
      }),
      transitions: { DONE: "review", FAILED: "failed" },
    },
    review: {
      kind: "state",
      action: agent("reviewer", {
        task: "Review the supplied report and write the declared JSON review artifact.",
        reads: [artifactOf("write", { artifact: "report" })],
        artifacts: {
          review: artifact("artifacts/review.json", Review),
        },
      }),
      transitions: { DONE: "done", FAILED: "failed" },
    },
    done: final(),
    failed: final(),
  },
});
```

After editing this pattern, call `hyperchart_inspect`; do not rely on TypeScript alone because agent availability and normalized-chart diagnostics are host/runtime concerns.

## Start a run

1. Inspect the chart first with `hyperchart_inspect`.
2. Verify every named agent definition is available.
3. Call `hyperchart_run` with `chartPath` and `args`.
4. Use `wait: true` only when the current task must block until terminal status. Otherwise retain the returned run id and directory.
5. Inspect the concrete result with `hyperchart_run_inspect` before reporting completion.

## Resume a run

Read [Recovery and safety](../../docs/safety.md), then:

1. Call `hyperchart_run_inspect` with the existing run id or directory.
2. Check process status, pending invocations, validation attempts, replay findings, sessions, and artifacts.
3. Reconcile any external file, API, or remote side effect that may have succeeded before a crash.
4. Resume with `hyperchart_run` using `runDir` alone. To create a different run, use `chartPath` without an existing `runDir`.
5. Do not set `ignoreReplayWarnings` unless the incompatibility has been explained and the user explicitly accepts the risk.

## Rewind a run

Read [Recovery and safety](../../docs/safety.md), then:

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
