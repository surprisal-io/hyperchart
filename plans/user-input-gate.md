# Durable `user()` input gate plan

## Context

`user()` is already represented in the DSL/AST and projected as a pending action, but the generic runtime currently warns and drops `UserEffect`, while `stepMachine()` accepts and ignores `UserMachineEvent`. The goal is to turn it into a durable rendezvous: a detached runner publishes an addressed request, the originating interactive host collects real user input, and the answer completes the pending action so the chart resumes.

The gate must not abort an in-flight host tool batch or terminate the detached runner; parallel/map branches may continue and may independently reach additional `user()` states. Those requests must all be persisted immediately but presented strictly one at a time, so one user answer can never be ambiguously attributed to two branches. Delivery and replies must be idempotent and restricted to the exact `originSessionId + workDir` owner.

In Claude Code, the plugin monitor notifies Claude and Claude invokes the native `AskUserQuestion` tool for the arbiter's single active gate. That tool holds the interactive session until the human answers; Claude then submits the answer to the durable request. Pi uses its extension message/settled APIs and normal next input to provide the equivalent gate behavior.

## Approach

### Runtime protocol

Add a per-run `user-interactions/` mailbox. The external identity of every dispatched user phase is only `(runId, seqId)`, where `seqId` is the durable record that caused the current phase (`invoke` for the initial gate, the current rejected-validation fact for a retry). Its directory is `user-interactions/<seqId>/`; the persist-once request stores `runId`, `seqId`, rendered prompt, authored options, allowed chart events, optional reply schema, action UID, and timestamps. No `effectId` or extra request ID appears in the persisted/public gate contract. A sibling atomic response file stores the explicit `ChartEvent`; presentation receipts use the existing claim-lease/confirmed-receipt pattern. A closed marker suppresses requests abandoned by timeout, parallel exit, or another winning transition. An operator stop only halts the in-process waiter and leaves the request resumable; hosts suppress delivery while the run is not live.

The file-backed `UserExecutor` writes/reuses the `(runId, seqId)` request, keeps the detached runner alive while waiting, notices a response (including one written before a restart), and emits `UserMachineEvent`. The existing `effectId` remains only an in-memory machine callback correlation value captured by `UserExecutor.start()`; it is never used by monitors, host APIs, tools, files, ordering, or user-visible messages. `ChartRuntime` starts, retries, cancels, and disposes the executor alongside agent/script executors. Rewind moves the interaction mailbox into the rewind backup so replay cannot consume a stale answer or receipt.

`UserEffect` will expose the durable phase `seqId` plus the same completion contract needed by other action executors: allowed events and optional reply schema. A shared response validator rejects `FAILED`, unsupported events, malformed envelopes, and schema-invalid output before the response file is committed. Duplicate identical submissions succeed idempotently; conflicting second answers fail. `stepMachine()` handles user completions through the existing agent/script completion path, so durable `state_action/complete`, optional `validate`, rejection retry, timers, and late-completion races retain one implementation.

### Cross-branch serialization and human-facing interaction

Every branch publishes its request as soon as its `UserEffect` is dispatched; serialization is a **presentation concern**, not a machine pause. A host-neutral arbiter stored under the host's runs root holds one active gate for the tuple `host + originSessionId + canonical workDir`. It orders requests strictly by `(runId, seqId)`—lexical `runId`, then numeric durable `seqId` within that run—and uses an atomic claim/lease so concurrent scans, `wait: true`, session recovery, and multiple run/branch arrivals cannot present different gates at once. `requestId` and wall-clock `createdAt` are identity/audit fields only and never affect ordering.

The active gate remains pinned until its response is durably committed or the machine closes it. New requests from other `parallel` regions, map instances, or separate owned runs remain queued regardless of arrival timing or repeated scans. When the active gate resolves, the arbiter atomically releases it and promotes the next still-live request in `(runId, seqId)` order. On restart, an unanswered already-presented gate remains pinned ahead of every never-presented request; stale/dead/closed entries are reconciled before promotion. If a race ever leaves multiple presentation receipts, recovery keeps the lowest `(runId, seqId)` request active and suppresses the rest until it resolves.

Thus the host exposes exactly one gate at a time per originating conversation, while all non-gated branches and detached runners keep progressing. The active request contains the prompt, authored options, allowed events, and reply contract. Claude renders that request through `AskUserQuestion`; Pi displays its visible gate message and associates the next normal user input with the same pinned request. In either host, only the active request is put into model context, and the host model translates the human answer into an explicit `{ runId, seqId, event, output? }` response call. This preserves freeform/structured replies without making branch attribution ambiguous.

### Pi delivery

A session-scoped scanner reuses the exact owner checks and receipt semantics used for terminal notifications. If Pi is busy, it sends a hidden `hyperchart-yield` with `deliverAs: "steer"`, asking the model to finish the current action/tool batch, start no new work, and end the turn. It never calls `ctx.abort()` and omits `triggerTurn`. When `agent_settled` fires—or immediately when `ctx.isIdle()` is already true—it rechecks ownership/liveness and sends the visible `hyperchart-user-request` without triggering another model turn. `before_agent_start` re-injects the still-pending request on the user's next normal prompt; the consolidated `hyperchart` tool gains `action: "respond"`.

### Claude Code delivery

The always-on plugin monitor scans interaction requests as well as terminal notifications and emits one JSON line only for the exact owning Claude session and cwd. Its notification tells Claude to finish the current safe action, start no unrelated work, invoke `AskUserQuestion` exactly once for the arbiter's active request, and never answer the gate itself. Authored `options` become selectable choices; without options Claude asks for free text and uses the returned answer to construct the explicit event/output envelope.

`AskUserQuestion` is the blocking presentation boundary: while it waits, the arbiter keeps every other branch/run gate queued. When the tool returns real human input, Claude immediately calls `hyperchart_respond`; only a successfully committed response releases/promotes the next gate. The MCP tool performs owner, liveness, active-request, event, reply-schema, and idempotency checks before committing the response. Session-start recovery re-surfaces the same pinned unanswered gate so an interrupted Claude session asks it again rather than advancing to another branch.

Claude monitor delivery is host-scheduled and therefore cannot provide Pi's explicit `agent_settled` acknowledgement before `AskUserQuestion`; stopping after the current action remains instruction-mediated. The durable protocol guarantees that an interrupted question remains recoverable rather than being lost or auto-answered.

### Waited and non-interactive runs

`wait: true` must race terminal completion against the shared arbiter's active owned request. At a gate it returns that request immediately from the current tool call instead of hanging until terminal status; Claude then invokes `AskUserQuestion`, while Pi presents its gate through the extension path. Hosts without an interactive owner leave the request pending and expose it through run inspection plus the explicit response command/tool.

## Files to modify

### Core and generic runtime

- `packages/hyperchart/src/core/machine.ts` — render the user completion contract and share completion handling with agent/script events.
- `packages/hyperchart/src/runtime/generic/chart_runtime.ts` — dispatch/retry/cancel/dispose user effects.
- `packages/hyperchart/src/runtime/generic/user_executor.ts` — file-backed request waiter implementing initial and rejected user phases.
- `packages/hyperchart/src/runtime/generic/user_interactions.ts` — request/response/receipt schema, atomic persistence, validation, claiming, closing, scanning, and idempotency helpers, including the runs-root active-gate arbiter shared by scanners and waited calls.
- `packages/hyperchart/src/runtime/generic/runner_main.ts` — construct the file-backed executor for every detached host runner.
- `packages/hyperchart/src/runtime/generic/rewind.ts` — back up/remove interaction state with the rewound generation.
- `packages/hyperchart/src/runtime/index.ts` — export the public executor/mailbox contracts and response helpers.
- `packages/hyperchart/src/host/models.ts`, `packages/hyperchart/src/host/adapters.ts`, and `packages/hyperchart/src/host/summarize.ts` — expose pending `(runId, seqId)` gate coordinates/contracts in full and compact run inspection for recovery/non-interactive response.

### Pi host

- `packages/pi-hyperchart/extensions/hyperchart.ts` — scanner, two-phase yield/presentation, lifecycle recovery, next-turn context, `respond` tool/command, waited-run boundary, and removal of the unsupported-user warning.
- `skills/pi/SKILL.md` — teach the model to present gates, wait for actual user input, and submit responses rather than answering them; package publication stages this canonical file as `skills/hyperchart/SKILL.md`.

### Claude Code host

- `packages/claude-hyperchart/src/monitor.ts` — owned interaction scanning and at-least-once notification emission.
- `packages/claude-hyperchart/bin/hyperchart-monitor.mjs` — invoke the combined terminal/interaction scan.
- `packages/claude-hyperchart/src/mcp/tools.ts` — add `hyperchart_respond`; make `wait: true` return on a user gate as well as terminal status.
- `packages/claude-hyperchart/hooks/session_start.mjs` — include the exact pinned unanswered gate during session recovery so Claude re-invokes `AskUserQuestion` for it before other work.
- `skills/claude/SKILL.md` — teach the `AskUserQuestion → hyperchart_respond` protocol and prohibit Claude from answering a gate itself; package publication stages this canonical file as `skills/hyperchart/SKILL.md`.

### Tests and documentation

- `tests/execution_loop.test.ts`, `tests/chart_runtime.test.ts` — user completion, validation/rejection, cancellation, and restart coverage.
- New `tests/user_interactions.test.ts` — mailbox persistence, validation, races, receipts, and rewind behavior.
- `tests/hyperchart_extension.test.ts`, `tests/claude_monitor.test.ts`, `tests/claude_mcp_tools.test.ts` — host routing, delivery phases, response tools, and waited-run behavior.
- `docs/api/dsl.md`, `docs/api/runtime.md`, `docs/claude-code.md`, `packages/claude-hyperchart/README.md`, and Pi mirrored docs/examples that currently say user actions are unsupported.

## Reuse

- `findPendingAction()` and the agent/script completion branch in `packages/hyperchart/src/core/machine.ts` for durable completion, transition lookup, validation, rejection, and stale late-event handling.
- `allowedEvents()` from `packages/hyperchart/src/core/projection.ts` and schema checks from `packages/hyperchart/src/runtime/generic/schema.ts` for the response contract.
- `AgentExecutor`/`ScriptRunner` start-cancel-dispose patterns and the existing `RejectedEffect` retry phase instead of adding a parallel state machine.
- Persist-once atomic writes, request generations, claim leases, confirmed receipts, and at-least-once semantics from `packages/hyperchart/src/runtime/generic/terminal_notifications.ts`.
- Existing `originSessionId`/`workDir` metadata and exact routing in `packages/claude-hyperchart/src/monitor.ts` and `deliverPendingPiTerminalNotification()`.
- Pi's `sendMessage(..., { deliverAs: "steer" })`, `ctx.isIdle()`, `agent_settled`, `before_agent_start`, and session-log custom-message deduplication.
- Claude's always-on monitor plus plugin hooks; no new daemon or direct coupling from the detached runner to the interactive session.
- Existing run watcher/status, inspection, stop, and rewind paths; the runner remains alive at a gate so concurrent branches continue.

## Steps

- [x] Extend `UserEffect` with durable phase `seqId`, allowed events, and reply metadata, while keeping `effectId` private to the machine/runtime callback; route `UserMachineEvent` through the existing action-completion branch and add focused tests for success, unsupported events, validation/rejection retries, timeout wins, and late duplicate replies.
- [x] Define versioned interaction request, response, close marker, and per-host receipt records under `user-interactions/<seqId>/`; implement atomic persist-once writes, `(runId, seqId)` lookup, rewind cleanup/recreation, and strict malformed-file isolation without publishing `effectId` or a second gate identifier.
- [x] Add a runs-root presentation arbiter keyed by `host + originSessionId + canonical workDir`: atomically pin one live request across parallel regions, map instances, and separate runs using strict `(runId, seqId)` order; retain it across scans/restarts; release only after answer/close; and make monitor scans, Pi scans, recovery, and `wait: true` use the same arbitration path.
- [x] Add shared response validation and persistence: exact active `(runId, seqId)` gate, non-`FAILED` allowed event, optional output schema/runtime contract, identical retry idempotency, divergent-answer conflict, and exact owner/cwd enforcement at host boundaries.
- [x] Implement `FileUserExecutor.start/reject/cancel/dispose`: reuse requests on process restart, keep the runner alive while waiting, emit persisted responses once, close machine-abandoned phases on `cancel`, but let `dispose` preserve them for run resume; avoid exiting the runner while other parallel/map work remains.
- [x] Construct the executor in `runHyperchartRunner`, wire it through `ChartRuntime`, and move the whole interaction mailbox into rewind backups so replay cannot consume pre-rewind answers or receipts.
- [x] Extend run inspection and waited-run watchers to surface queued versus active gates; make `wait: true` participate in the same session/workDir arbiter and return the active interaction boundary instead of hanging behind another branch's gate, while ordinary background runs continue detached.
- [x] Implement Pi's owned interaction scanner and state transitions `pending → yielding → awaiting-user → answered/closed`: steer only while busy, recheck on idle/`agent_settled`, display once without `triggerTurn`, recover on session start/reload, and serialize multiple gates in `(runId, seqId)` order.
- [x] Add Pi `hyperchart action=respond` and next-turn context injection so the user's ordinary prompt is translated into an explicit validated response; remove unsupported-user warnings and ensure the model cannot silently answer the gate itself.
- [x] Extend the Claude monitor to emit owned interaction notifications with recoverable claims and instructions to call `AskUserQuestion` exactly once for the arbiter's active request after the current safe action.
- [x] Add Claude `hyperchart_respond` and session-start recovery context: map the real `AskUserQuestion` result to an explicit response, commit it before continuing, and deny wrong-session, wrong-cwd, non-active, stale, already-closed, and conflicting responses.
- [x] Cover mailbox restart windows (response before log append, crash before/after presentation confirmation), simultaneous gates from multiple parallel/map branches and runs, arbiter claim races/failover/promotion, cancellation and stop/resume, malformed/foreign requests, and post-rewind identity in unit/integration tests.
- [x] Update runtime, DSL, Pi, Claude, skill, example, and run-layout documentation; describe Pi's normal-input path, Claude's `AskUserQuestion` path, explicit response envelopes, serialized cross-branch presentation, at-least-once recovery, host limitations, and the non-interactive recovery path.

## Verification

- Run focused suites: `npx vitest run tests/execution_loop.test.ts tests/chart_runtime.test.ts tests/user_interactions.test.ts tests/hyperchart_extension.test.ts tests/claude_monitor.test.ts tests/claude_mcp_tools.test.ts`.
- Run `npm run check` (repository typechecks/tests/build checks) after the focused suites.
- Pi manual flow: start the review example in the background during an active tool batch; verify that the batch completes, hidden steering yields the model, exactly one visible normal prompt appears after settle, Pi remains idle, and the next ordinary user reply causes one validated `respond` call and one durable completion.
- Claude manual flow: start the same chart through the plugin; verify the monitor reaches only the originating session/cwd, Claude invokes `AskUserQuestion` once with the rendered prompt/options, remains blocked until a real human answer, and immediately resumes the detached run through `hyperchart_respond` without answering on the user's behalf.
- Repeat both flows with `wait: true`; verify the tool returns at the user boundary rather than hanging to terminal completion and that later terminal delivery is still deduplicated correctly.
- Restart the detached runner before and after writing a response; verify the same request/answer resumes exactly once. Restart/resume the interactive session and verify pending owned gates are recovered without cross-session/workDir leakage.
- Drive at least three simultaneous gates (two `parallel`/`map` branches in one run plus another owned run); verify all requests are persisted, exactly the lowest `(runId, seqId)` gate is marked active and reaches `AskUserQuestion`/Pi input context, non-gated branches keep progressing, and each queued gate is promoted exactly once in the same order after the previous active gate is answered or machine-closed.
- Crash/restart the host scanner while several branch gates are queued; verify the already-presented unanswered gate remains pinned. Race the background scanner against `wait: true`; verify the shared arbiter prevents double presentation or advancing to a second branch.
- Verify invalid event/output, `FAILED`, malformed JSON, duplicate identical answer, conflicting answer, timeout-vs-answer race, stop/resume, foreign owner, and rewind-after-answer behavior.
