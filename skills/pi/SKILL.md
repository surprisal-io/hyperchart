---
name: hyperchart
description: Author, list, inspect, run, resume, debug, and safely recover durable TypeScript Hyperchart workflows in Pi. Use for .chart.ts files, the hyperchart tool, typed refs, artifacts, replay warnings, and runtime troubleshooting.
license: MIT
compatibility: Requires Node.js >=22.19 and the @surprisal/pi-hyperchart Pi package.
---

<!-- Canonical source. Package publication stages this file as skills/hyperchart/SKILL.md; edit only this file. -->
# Hyperchart agent procedure

Use the consolidated `hyperchart` tool directly. `/hyperchart` is a human-facing Pi command and is not part of this agent procedure.

## Choose the tool

| Task | Tool |
|---|---|
| List project and user chart definitions | `hyperchart` with `action: "list"` |
| Validate and inspect a chart definition | `hyperchart` with `action: "inspect"` |
| Start a chart or resume an existing run | `hyperchart` with `action: "run"` |
| Commit the user's answer to an active gate | `hyperchart` with `action: "respond"` |
| Inspect durable state for one run | `hyperchart` with `action: "run_inspect"` |
| Open the browser inspector for a run | `hyperchart` with `action: "view"` |
| Stop one or all active runs | `hyperchart` with `action: "stop"` |
| Back up and truncate a stopped run | `hyperchart` with `action: "rewind"` |

## Discover available charts

Before choosing or asking for a chart, list definitions from both scopes:

1. Project scope: nearest ancestor containing `.pi` (or `.hypercharts`), then `.pi/hypercharts/` below it.
2. Shared project scope: `<projectRoot>/.hypercharts/` — a host-neutral directory whose charts are visible to every Hyperchart host; the host-specific project scope wins on a name clash.
3. User scope: `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/hypercharts/`.
4. Include flat `*.chart.ts`/`*.ts` files and bundle `<name>/chart.ts` entrypoints. Exclude `runs/`, hidden directories, and `node_modules/`.
5. Report chart name, scope, and absolute path. When both scopes define the same chart name, project scope wins.
6. Do not load every chart module merely to build the list. Chart modules execute top-level TypeScript when inspected. Inspect only selected chart with `hyperchart({ action: "inspect", chartPath })`.

Prefer `hyperchart({ action: "list" })`; it applies scope precedence without loading chart modules.

Self-contained workflow layout:

```text
hypercharts/<name>/
├── chart.ts
├── agents/
├── extensions/<extension>/index.ts
└── scripts/
```

Bundle agent definitions override project and user definitions. Bundle extensions export default Pi registration functions and load with Hyperchart. Resolve scripts relative to the working directory (CWD).

Agent definitions can declare a symbolic `role` (model tier) and `toolset` (tool list) in frontmatter instead of a concrete `model`/`tools`. Both are mapped to concrete values in `settings.json` under the charts directories (`.pi/hypercharts/settings.json` project scope, `<projectRoot>/.hypercharts/settings.json` shared scope, `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/hypercharts/settings.json` user scope; stronger scopes win per key, and a shared file may namespace mappings per host, e.g. `{ "pi": { "roles": ... }, "claude": { ... } }`): `{ "roles": { "reviewer": "anthropic/claude-opus-4-8" }, "toolsets": { "reading": ["read", "grep"] } }`. Resolution per invocation: chart `model`/`tools` override → configured role/toolset → frontmatter `model`/`tools` (fallback for an unconfigured name) → default model. An unconfigured role/toolset with no fallback (and no chart override) fails the action with an error — declare a fallback or configure the mapping before running.

Use `find`/`ls` only as fallback:

```bash
project_root="$PWD"
while [ "$project_root" != "/" ] && [ ! -d "$project_root/.pi" ] && [ ! -d "$project_root/.hypercharts" ]; do
  project_root="$(dirname "$project_root")"
done
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
find "$project_root/.pi/hypercharts" "$project_root/.hypercharts" "$agent_dir/hypercharts" \
  -type f \( -name '*.chart.ts' -o -name '*.ts' \) \
  ! -path '*/runs/*' ! -path '*/node_modules/*' ! -path '*/hypercharts/.*/*' 2>/dev/null | sort
```

If neither scope contains charts, say so before proposing authoring a new chart.

## Bundled reference

Read the smallest local page that covers the task:

- [DSL and typed refs](../../docs/api/dsl.md) — authoring signatures, options, constraints, and examples.
- [Pi tools](../../docs/api/pi.md) — exact schemas for all `hyperchart` actions and lifecycle statuses.
- [Runtime API](../../docs/api/runtime.md) — runtime, stores, scripts, guards, artifacts, and execution errors.
- [Recovery and safety](../../docs/safety.md) — replay warnings, crash ambiguity, rewind, cleanup, and external effects.
- [File and run contracts](../../docs/reference.md) — run layout, durable records, and limitations.
- [Documentation index](../../docs/README.md) — routes to every bundled guide and API page.

These files ship inside the Pi package. Prefer them over network documentation so the reference matches the installed version.

## Author or modify a chart

1. Read the existing `.chart.ts` file, the bundled [DSL reference](../../docs/api/dsl.md), and nearby chart examples.
2. Keep control flow explicit in the chart. Agents and scripts return events and data; they do not choose hidden next states.
3. Prefer `refs()` plus Zod-backed replies, inputs, and artifacts. Use transition inputs for visit-local handoff and artifacts for file deliverables.
4. Call `hyperchart` with `action: "inspect"` after every structural change. Inspect actions always return a bounded digest. Never request `verbose: true`; it is rejected. Use `action: "view"` for full source, schemas, states, visits, or transcripts.
5. Resolve all diagnostics and unavailable agent definitions before starting a real run.
6. Do not start the chart unless the user asked to execute it.

### Best practice: typed artifacts first

Put every substantial or reusable result in a declared artifact by default. Give JSON artifacts a Zod shape, mirror them in the `Files` registry passed to `refs()`, and pass them downstream with `artifactOf()` or `joinArtifactOf()`. Reserve `reply` for small routing data that belongs in a completion event.

This catches different failures at the right boundary:

- TypeScript catches a missing producer, artifact-name mismatch, invalid selector, or `Files` registry drift.
- Runtime validation catches a missing file, invalid JSON, or content that does not match the Zod shape.
- Durable files make inspection, recovery, replay analysis, and manual verification easier than large prompt/result payloads.

```ts
import { agent, artifact, final, refs, t, z } from "@surprisal/hyperchart";

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
      transitions: { DONE: "review" },
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
      transitions: { DONE: "done" },
    },
    done: final(),
  },
});
```

After editing this pattern, call `hyperchart` with `action: "inspect"`; do not rely on TypeScript alone because agent availability and normalized-chart diagnostics are host/runtime concerns.

## Start a run

1. Inspect the chart first with `hyperchart` with `action: "inspect"`. The result is always a bounded digest; full inspection is browser-only through `action: "view"`.
2. Verify every named agent definition is available.
3. Call `hyperchart({ action: "run", chartPath, args })`.
4. Use `wait: true` only when the current task must block. Otherwise retain the returned run id and directory; Pi routes owned gates and the terminal prompt to that exact originating session/canonical working directory. Do not start a polling watcher.
5. A waited call can return terminal status **or** `boundary: "user"` for the globally active owned gate, possibly from another run that sorts earlier. Handle the gate before waiting again.
6. Inspect concrete result with `hyperchart` with `action: "run_inspect"` before reporting completion.

## Answer a user gate

Pi may first deliver hidden steering asking you to finish the current safe action/tool batch and yield. Do not answer the gate, continue unrelated work, or call a tool based only on that steering. On idle, Pi displays the real question without triggering another model turn.

The user's next ordinary prompt is the answer. Hidden context supplies the exact `(runId, seqId)`, a bounded question preview, options with bounded display labels separated from exact values, exact allowed events, and a recursively bounded non-executable output contract. Display strings include `originalChars`/`omittedChars`; never copy an ellipsized label in place of an option `value`, event, or coordinate. Read `types`/`nullable`, JSON-decode `literalJson`, `allowedValueJson`, and `defaultJson`, recurse through required/optional `fields`, `element`/`tupleItems`, and `alternatives`, and obey `additionalProperties` and `constraints`. It never supplies the full prompt or raw reply schema. If Pi reports that the gate cannot be represented safely, do not guess or submit a partial identity/shape; direct the user to the browser inspector/user interaction. Translate only real user input, then immediately call:

```json
{
  "action": "respond",
  "runId": "<exact run id>",
  "seqId": 14,
  "event": "<allowed non-FAILED event>",
  "output": "<only when required by the reply contract>"
}
```

Do not infer consent, invent content, expose or ask for an `effectId`/`requestId`, or continue the workflow until the durable commit succeeds. The host rejects a queued, stale, closed, wrong-session, wrong-cwd, unsupported, or schema-invalid answer. Fix a validation error using the same user input when possible; otherwise ask the user for the missing data. Repeating the identical response is idempotent; never replace it with a divergent answer.

Multiple gates are serialized across parallel/map branches and owned runs by lexical `runId`, then numeric `seqId`. Presentation can repeat during recovery, but the same unanswered coordinate is not a new question. If an ordinary prompt arrives without gate-binding context, do not guess that it answers a gate.

## View a run

Call `hyperchart({ action: "view", runDir })` to open the localhost browser inspector and receive exactly `{ url }`. Pass `open: false` when only the URL should be returned. The inspector shows the live graph, declared role/toolset names with resolved model/tool allowlists, per-state runtime details, session transcripts, and steering controls for the selected run. This is the only full inspection surface: tool responses are capped digests and never place definitions, schemas, runtime snapshots, visit histories, or transcripts into session logs.

## Resume a run

Read [Recovery and safety](../../docs/safety.md), then:

1. Call `hyperchart({ action: "run_inspect", runDir })` with existing run id or directory.
2. Check process status, pending invocations, validation attempts, replay findings, sessions, and artifacts.
3. Reconcile any external file, API, or remote side effect that may have succeeded before a crash.
4. Resume with `hyperchart({ action: "run", runDir })`. Create a different run with `chartPath` and no existing `runDir`.
5. Do not set `ignoreReplayWarnings` unless the incompatibility has been explained and the user explicitly accepts the risk.

## Rewind a run

Read [Recovery and safety](../../docs/safety.md), then:

1. Inspect the run and confirm it is stopped.
2. Choose exactly one target: `state`, `seqId`, or `to: "compatible"`.
3. Explain which durable facts will be removed, that the complete user-interaction mailbox moves into the rewind backup, and that external effects will not be undone.
4. Call `hyperchart` with `action: "rewind"`. Keep `cleanupArtifacts: false` unless the user explicitly requests best-effort artifact cleanup.
5. Inspect the rewound run again before starting it.

## Safety rules

- Chart modules are executable TypeScript. Loading one can execute top-level code even when no workflow action is dispatched.
- Never edit `log.jsonl` or `user-interactions/` mailbox files manually.
- Never rewind a live run.
- Never treat a missing agent definition as an unrestricted default.
- Stop, rewind, replay, and deletion do not undo arbitrary external effects.
- Back up important runs outside their run directory before destructive recovery.
- Treat `ignoreReplayWarnings` as an assertion, not a repair.

## Report

Include the chart id, run id, absolute run directory, current or terminal status, artifact paths, and unresolved validation, replay, session, or external-side-effect risks.

## Explicit actors

For shared mutable resources, prefer a statically placed actor: declare its `protocol`, build an `actor()` template, place one invocation in the lexical owner's `actors`, and use typed `send`/`call`. Never invent dynamic actor names or route `FAILED`; business rejection is a named reply. Every handler must enter through `receive()` and terminate with graph-inferred `reply()`.
