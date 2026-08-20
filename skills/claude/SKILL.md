---
name: hyperchart
description: Author, list, inspect, run, steer, and debug durable TypeScript Hyperchart workflows in Claude Code. Use for .chart.ts files, the hyperchart_* MCP tools, typed refs, artifacts, replay warnings, live agent sessions, and runtime troubleshooting.
license: MIT
---

<!-- Canonical source. Package publication stages this file as skills/hyperchart/SKILL.md; edit only this file. -->
# Hyperchart agent procedure

Hypercharts are durable, typed statechart workflows. Each agent action of a chart runs as a real Claude session in a detached background runner; runs survive restarts and are inspectable in a localhost browser inspector.

## Choose the tool

| Task | Tool |
|---|---|
| List chart definitions and this directory's runs | `hyperchart_list` |
| Validate and inspect a chart definition | `hyperchart_inspect` |
| Start a chart or resume an existing run | `hyperchart_run` |
| Commit the real `AskUserQuestion` answer | `hyperchart_respond` |
| Inspect durable state for one run | `hyperchart_run_inspect` |
| Steer a live agent session of a run | `hyperchart_steer` |
| Stop one or all active runs | `hyperchart_stop` |
| Move a stopped named branch head without deleting history | `hyperchart_rewind` |
| Open the browser inspector for a run | `hyperchart_view` |

Pass `cwd` explicitly when working outside the session's starting directory.

## Discover available charts

1. Project scope: nearest ancestor containing `.claude` (or `.agents`/`.hypercharts`), then `.claude/hypercharts/` below it.
2. Shared project scope: `<projectRoot>/.hypercharts/` — a host-neutral directory whose charts are visible to every Hyperchart host; the host-specific project scope wins on a name clash.
3. User scope: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hypercharts/`.
4. Prefer `hyperchart_list`; it applies scope precedence without loading chart modules. Chart modules execute top-level TypeScript when inspected — inspect only the selected chart with `hyperchart_inspect`.

Self-contained workflow layout:

```text
hypercharts/<name>/
├── chart.ts
├── agents/
└── scripts/
```

Agent definitions are markdown files with frontmatter (`name`, `description`, `role`, `toolset`, `model`, `thinking`, `tools`, `systemPromptMode`); the body is the agent's system prompt. Resolution order: `<chartDir>/agents`, `<projectRoot>/.claude/agents`, `<projectRoot>/.agents`, `~/.agents`, `~/.claude/agents`. Model ids are passed to the Claude Agent SDK verbatim (e.g. `claude-sonnet-5`, `claude-opus-4-8`).

`role` names a symbolic model tier instead of a concrete model, and `toolset` a symbolic tool list instead of enumerating tools. Both are mapped to concrete values once in `settings.json` under the charts directories — `<projectRoot>/.claude/hypercharts/settings.json`, `<projectRoot>/.hypercharts/settings.json` (shared, host-neutral; may namespace mappings per host, e.g. `{ "claude": { "roles": ... }, "pi": { ... } }`), and `~/.claude/hypercharts/settings.json` — stronger scopes winning per key — e.g. `{ "roles": { "reviewer": "opus" }, "toolsets": { "reading": ["Read", "Grep"] } }`. Resolution per invocation: chart `model`/`tools` override → configured role/toolset → frontmatter `model`/`tools` (fallback for an unconfigured name) → default model. An unconfigured role/toolset with no fallback (and no chart override) fails the action with an error — declare a fallback or configure the mapping before running.

## Author or modify a chart

1. Read the existing `.chart.ts` file and nearby chart examples.
2. Keep control flow explicit in the chart. Agents and scripts return events and data; they do not choose hidden next states.
3. Prefer `refs()` plus Zod-backed replies, inputs, and artifacts. Use transition inputs for visit-local handoff and artifacts for file deliverables.
4. Call `hyperchart_inspect` after every structural change and resolve all diagnostics and unavailable agent definitions before starting a real run.
5. Do not start the chart unless the user asked to execute it.

Put every substantial or reusable result in a declared artifact with a Zod shape; reserve `reply` for small routing data that belongs in a completion event. TypeScript catches producer/name/selector drift, runtime validation catches missing or invalid files, and durable artifacts make inspection and recovery easier than large prompt payloads.

## Start a run

1. Inspect the chart first with `hyperchart_inspect` and verify every named agent definition is available. Inspect tools always return bounded digests. Never pass `verbose: true`; it is rejected. Use `hyperchart_view` for full source, schemas, states, visits, or transcripts.
2. Call `hyperchart_run` with `chartPath` and `args`.
3. Use `wait: true` only when the current task must block. Otherwise retain the returned run id and directory; the monitor routes owned user gates and the terminal prompt to this exact originating Claude session/canonical working directory. Never start Bash/Monitor polling watchers.
4. A waited call can return terminal status **or** `boundary: "user"` for the globally active owned gate, possibly from another run that sorts earlier. Handle the gate before waiting again.
5. Inspect concrete result with `hyperchart_run_inspect` before reporting completion.

A run's owning repository/project directory is not its action cwd. Each branch executes in `<runDir>/workspaces/<branchId>`, materialized from Hyperchart artifacts rather than checked out from the repository. Agent context and Inspector metadata expose both paths; scripts receive `HYPERCHART_PROJECT_DIR` and `HYPERCHART_BRANCH_WORKSPACE`. If work must touch the repository, use the explicit project path and treat those edits as outside branch isolation.

## Answer a user gate

A `hyperchart-user-request`, waited user boundary, or SessionStart recovery context provides the exact `(runId, seqId)`, a bounded question preview, authored options with bounded display labels separated from exact values, exact allowed events, and an optional recursively bounded non-executable output contract. Display strings include `originalChars`/`omittedChars`; never copy an ellipsized label in place of an option `value`, event, or coordinate. Read `types`/`nullable`, JSON-decode `literalJson`, `allowedValueJson`, and `defaultJson`, recurse through required/optional `fields`, `element`/`tupleItems`, and `alternatives`, and obey `additionalProperties` and `constraints`. It never includes the full prompt or raw reply schema. If Claude reports that the gate cannot be represented safely, do not guess or submit a partial identity/shape; direct the user to the browser inspector/user interaction. The monitor may arrive while you are busy: finish the current safe action/tool batch, start no unrelated work, and then:

1. If the same gate already has a native question in flight, do not open a concurrent duplicate. Otherwise call native `AskUserQuestion` once for this delivery attempt, mapping authored options when present and preserving a free-text/Other path when needed.
2. Never infer, fabricate, summarize away, or supply the human answer yourself.
3. Immediately after the human answers, call `hyperchart_respond` with `{ runId, seqId, event, output? }`, choosing an allowed non-`FAILED` event and satisfying the reply contract.
4. Do not continue the workflow until `hyperchart_respond` confirms the durable commit.

The public gate identity is only `(runId, seqId)`; never invent or disclose an `effectId` or separate `requestId`. The host rejects queued, stale, closed, wrong-session, wrong-cwd, unsupported, schema-invalid, and conflicting answers. An identical retry is idempotent. Presentation is at least once: if session recovery repeats an unanswered coordinate and no `AskUserQuestion` remains in flight, ask it again; a repeated coordinate is recovery, not permission to answer it from memory.

Multiple gates from parallel/map branches and separate owned runs are serialized by lexical `runId`, then numeric `seqId`. Only the gate's branch waits; do not assume the runner as a whole is paused.

## Watch and steer a run

- `hyperchart_view` returns exactly `{ url }` and opens the browser inspector: live chart graph, declared role/toolset names with resolved model/tool allowlists, per-state details, and live agent session transcripts with a steering composer. It is the only full inspection surface; tool responses never copy definitions, schemas, runtime snapshots, visit histories, or transcripts into Claude session logs.
- `hyperchart_run_inspect` shows each session's `actionKey`, status, and current activity.
- `hyperchart_steer` queues a message for a `starting`/`running` session; the runner delivers it into the live Claude session after its current tool call.

## Resume a run

1. Call `hyperchart_run_inspect` with the existing run id or directory.
2. Check process status, pending invocations, validation attempts, replay findings, sessions, and artifacts.
3. Reconcile any external file, API, or remote side effect that may have succeeded before a crash.
4. Resume with `hyperchart_run` and `runDir`. Create a different run with `chartPath` and no `runDir`.
5. If a `failure_intent` was durably recorded, plain resume replays back into global failure quiescence or the failed outcome. Recover with `hyperchart_rewind`: stop the run, rewind to before the failure intent (`state` or `seqId`), then resume. Rewind appends a move of the explicit branch head; all records and downstream files remain.
6. Do not set `ignoreReplayWarnings` unless the incompatibility has been explained and the user explicitly accepts the risk.

## Safety rules

- Chart modules are executable TypeScript. Loading one can execute top-level code even when no workflow action is dispatched.
- Never edit `log.jsonl` manually and never resume a run whose replay check reports incompatibilities without explicit user confirmation.
- Never treat a missing agent definition as an unrestricted default.
- Stop and deletion do not undo arbitrary external effects.
- Chart agent sessions run headless with permission checks bypassed inside the chart's working directory; guards and validators in the chart are the control surface. Do not point charts at directories the user has not approved.

## Report

Include the chart id, run id, absolute run directory, current or terminal status, artifact paths, and unresolved validation, replay, session, or external-side-effect risks.

## Explicit actors

For shared mutable resources, prefer a statically placed actor: declare its `protocol`, build an `actor()` template, place one invocation in the lexical owner's `actors`, and use typed `send`/`call`. Never invent dynamic actor names or route `FAILED`; business rejection is a named reply. Every handler must enter through `receive()` and terminate with graph-inferred `reply()`.

When authoring bounded actor concurrency, use `actorPool({ concurrency, worker })`. Never encode batching as `send({ inputs })`: choose `sendBatch` or single-reply-only `callBatch`, and preserve FIFO/drain semantics. Inside an actor template, use `self()` only with `send`/`sendBatch`; for a pool it addresses the shared endpoint, and recursive calls remain unsupported.
