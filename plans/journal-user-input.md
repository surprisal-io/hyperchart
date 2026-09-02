# Journal-native durable user input

## Context

Hyperchart currently commits one user answer through two independent durable paths:

1. The runtime derives a `UserEffect` from the journal projection and writes a persist-once `request.json` under `user-interactions/<branchId>/<seqId>/`.
2. Pi or Claude validates the active coordinate and writes the immutable response-or-close winner to `resolution.json`.
3. `FileUserExecutor` polls that mailbox, validates the persisted event again, and calls `phase.emit()`.
4. The normal machine path converts that callback to `state_action/complete`, which is committed later to `log.jsonl` or `hyperchart_journal`.

This leaves a crash-visible state in which the answer is durable in `resolution.json` but is not yet part of the execution journal. The mailbox and journal also use different serialization mechanisms, preventing PostgreSQL from committing a gate answer atomically with a branch fork and host-domain SQL.

The target is one semantic durability boundary: the run journal is both execution history and the ordered log of accepted external input. Presentation leases and delivery receipts may remain non-semantic sidecars, but they must not decide replay or machine state.

### Current implementation map

- `packages/hyperchart/src/runtime/generic/user_interactions.ts` owns request/resolution/receipt schemas, active-gate scanning, ownership checks, validation, and atomic hard-link publication.
- `packages/hyperchart/src/runtime/generic/user_executor.ts` implements mailbox polling and response delivery.
- `packages/hyperchart/src/core/machine.ts` turns a live `user` callback into `state_action/complete`.
- `packages/hyperchart/src/runtime/generic/chart_runtime.ts` dispatches `UserExecutor` effects and appends machine drafts.
- `packages/hyperchart/src/runtime/generic/log_store.ts` provides JSONL append serialization and stale-writer detection.
- `packages/hyperchart/src/runtime/generic/postgres_log_store.ts` provides the PostgreSQL journal, a process-level advisory writer lock, and per-mutation transactions.
- `packages/hyperchart/src/core/durable_events.ts`, `projection.ts`, and `replay_check.ts` define and validate the durable semantic contract.

## Approach

### Approved semantic contract

Use two typed journal facts:

- `user_interaction/opened` is emitted once for each running or rejected user phase. Its assigned journal `seqId` is the public gate identity. It pins the `actionUid`, fully rendered prompt/options, allowed events, reply schema, and rejection metadata so stopped-run inspection never depends on reparsing current chart source.
- `user_interaction/resolved` references the exact opened fact by `gateSeqId`, carries the validated chart event, and **directly applies the same projection semantics as an accepted action completion**. It is not routed through `phase.emit()` and does not cause a second `state_action/complete` append.

The opened fact is a durable rendering/provenance fact, not a transition. The resolved fact is the single external-input/completion fact. Validation verdicts after a resolved input remain ordinary `state_action/validated` facts; a rejected verdict causes the machine to append a new opened fact with a new gate identity.

A gate is open only when its opened fact is in the selected branch ancestry, has no resolution in that ancestry, and its exact user action phase is still pending in projection. Timer, failure, competing exit, or rewind closes it by changing the projected prefix; no redundant `closed` record is required.

### Writer and runtime model

- Add a serialized `respond` writer operation. Under one backend serialization boundary it refreshes the selected branch prefix, reconstructs projection, confirms the exact opened gate is pending, validates ownership/event/reply, checks ancestry for an existing resolution, and appends `user_interaction/resolved`.
- Identical resolution already present in selected ancestry returns idempotently. A different resolution for the same gate conflicts. A gate absent from or no longer pending in selected ancestry is stale. A resolution on an abandoned history after rewind does not poison the selected ancestry.
- Allow offline response commit while the runner is stopped. A later resume consumes the resolved fact through ordinary replay.
- The detached process owns the complete runtime and is the sole live journal writer. A host response for a live run is a typed, non-semantic runner-control command; the runtime commits it through its already-open branch store and directly acknowledges the committed record to the machine. `LogStore` has no subscription, watch, polling, or cross-process catch-up contract.
- A stopped run may temporarily open the same writer API and append a response for later replay. Attempt-fenced control acknowledgements plus selected-ancestry idempotency make a crash between commit and acknowledgement safe to retry.
- JSONL validates and stamps against its already-open snapshot under the append lock and rejects any stale byte boundary. It never rereads changes from another live writer.
- PostgreSQL retains a session-level advisory writer claim for the lifetime of the runtime/store. Its managed transaction callback supplies journal operations plus raw `query()` for host-domain SQL, but only the sole writer may use it; another live writer is rejected.
- The composite fork/response operation deterministically creates the fork from the pre-response source head first, then resolves an explicitly named branch. The new branch therefore does not inherit the answer unless it is itself selected as the response branch, and source/new branches can answer independently from the shared open-gate prefix.
- Keep host presentation claims, confirmations, and leases as non-semantic sidecars. They select and redeliver UI boundaries but never establish whether a gate is open or answered.
- Remove semantic request/resolution mailbox files and `FileUserExecutor` only after Pi, Claude, wait/recovery, inspection, rewind, and live-runtime wake-up use journal-backed gates.

## Files to modify

### Durable contract and execution

- `packages/hyperchart/src/core/durable_events.ts`
- `packages/hyperchart/src/core/machine.ts`
- `packages/hyperchart/src/core/projection.ts`
- `packages/hyperchart/src/core/replay_check.ts`
- `packages/hyperchart/src/core/execution_loop.ts`
- `packages/hyperchart/src/runtime/generic/chart_runtime.ts`

### Journal writers and runner integration

- `packages/hyperchart/src/runtime/generic/log_store.ts`
- `packages/hyperchart/src/runtime/generic/memory_log_store.ts`
- `packages/hyperchart/src/runtime/generic/postgres_log_store.ts`
- `packages/hyperchart/src/runtime/generic/log_store_factory.ts`
- `packages/hyperchart/src/runtime/generic/runner_main.ts`
- `packages/hyperchart/src/runtime/generic/runner_control.ts`
- `packages/hyperchart/src/runtime/generic/branches.ts`

### User interaction and host surfaces

- `packages/hyperchart/src/runtime/generic/user_interactions.ts`
- `packages/hyperchart/src/runtime/generic/user_executor.ts` (remove after cutover)
- `packages/hyperchart/src/runtime/index.ts`
- `packages/pi-hyperchart/extensions/hyperchart.ts`
- `packages/claude-hyperchart/src/mcp/tools.ts`
- `packages/claude-hyperchart/src/monitor.ts`
- relevant inspector/host adapters that currently read mailbox-backed open interactions

### Semantics, tests, and documentation

- `tla/Hyperchart.tla`
- `tla/HyperchartTrace.tla`
- `tla/trace/record-sample.mjs`
- user-interaction, runtime, replay, rewind, branch, JSONL, PostgreSQL, Pi, and Claude test suites under `tests/`
- `docs/api/runtime.md`
- `docs/runtime-and-durability.md`
- `docs/api/pi.md`
- `docs/api/dsl.md`
- `docs/pi.md`
- `docs/claude-code.md`
- `docs/reference.md`
- `docs/safety.md`
- package READMEs/skills if their public workflow changes

## Reuse

- Reuse user-effect reconstruction in `userInvocationForAction()` and pending-action identity in `packages/hyperchart/src/core/machine.ts`.
- Reuse exact event/reply validation from `validateUserInteractionEvent()` in `packages/hyperchart/src/runtime/generic/user_interactions.ts`, moving the semantic portion to a backend-neutral admission layer.
- Reuse journal stamping and multi-record `appendDrafts()` calls from `packages/hyperchart/src/runtime/generic/log_store.ts`; durable storage remains flat.
- Reuse targeted branch-history membership/response queries and restored projections as the source for open-gate checks and idempotency. Execution prepares the validated resolved draft; storage accepts only `commitPreparedUserInteraction()` and never imports the AST/projector admission layer.
- Reuse JSONL `acquireWriterLock()` and stale-length validation, but place validation and append in one critical section.
- Reuse PostgreSQL advisory locking and `writeChain` serialization, adapting them to transaction-scoped composition rather than introducing a second interaction table.
- Reuse existing ownership/session/cwd checks and presentation receipt arbitration where they remain host-delivery concerns.

## Steps

- [x] Extend `DurableLogRecord` with exhaustive `user_interaction/opened` and `user_interaction/resolved` shapes. Make normalization reject malformed coordinates, schemas, action identities, and events rather than silently accepting unknown machine records.
- [x] Change machine scheduling so every pending running/rejected user phase first requests one `opened` append; only after that append is projected does the phase become externally answerable. Remove the live `UserMachineEvent` completion path.
- [x] Extend projection with durable open-gate state. Apply `resolved` directly as the user action completion, including transition selection, result recording, validation phase entry, abandoned-action cancellation, and timer race behavior.
- [x] Extend `explainReplay` to verify that each opened fact matches the exact user definition and phase at that prefix and that each resolved fact references an open matching gate, contains an allowed non-`FAILED` event, and preserves reply-schema provenance. Detect stale/broken logs rather than reinterpreting them.
- [x] Introduce a backend-neutral response-admission function and `RunLogStore.respondToUserInteraction(...)` operation. Reuse ownership checks at host boundaries; move semantic gate/event/schema checks beside projection/replay so every backend applies the same rules.
- [x] Add selected-ancestry idempotency: identical resolved retry succeeds; divergent retry conflicts; non-pending or non-ancestral gate is stale; an off-ancestry resolution after rewind does not block a new selected-history response.
- [x] Add a typed runner-control response command with attempt-fenced acknowledgement. The sole live writer commits and directly applies its record; stopped runs temporarily open the writer for replay. Do not add a storage subscription API.
- [x] Keep JSONL on one live writer: validate/stamp/append under its writer lock, reject stale byte boundaries, and do not watch or catch up from concurrent writers.
- [x] Keep PostgreSQL on one lifetime session advisory writer claim. Provide a managed transaction callback exposing journal operations and host-domain `query()` only to that owner; reject a second live writer.
- [x] Add one atomic PostgreSQL command path that creates the fork from the pre-response source head, then resolves an explicit source-or-new response branch in the same transaction as caller domain SQL. Roll back the fork, response, and domain writes together on any validation or SQL failure.
- [x] Replace mailbox scans with journal-derived open-gate queries and keep existing owner/session/cwd presentation arbitration over those queries. Retain only receipt/lease sidecars, keyed by the new opened-fact `seqId`.
- [x] Update Pi, Claude, waited-run boundaries, monitor recovery, run inspection, and browser inspector adapters to read opened facts and call the journal writer API. Offline responses must work for stopped runs.
- [x] Remove the old mailbox protocol outright, with no compatibility, migration, import, or diagnostic path.
- [x] Delete `FileUserExecutor`, semantic `request.json`/`resolution.json` persistence and readers, obsolete exports, mailbox rewind handling, PostgreSQL mailbox artifacts if any appear during implementation, and tests/docs that prescribe the old protocol. Keep receipt/lease storage in a renamed presentation-only module if filesystem delivery arbitration remains.
- [x] Update the durable log contract, replay-check tests, TLA+ machine, trace exporter/sample, canonical docs, package READMEs, and Pi/Claude skills as required by the public workflow change.

## Verification

- Exact same response retry succeeds idempotently; a different response for the same phase conflicts.
- Invalid event, `FAILED`, invalid reply payload, foreign branch/session/cwd, missing gate, and closed/timed-out gate do not append.
- Response-versus-timeout/cancellation races have one journal winner under both JSONL and PostgreSQL.
- Crash immediately after response commit needs no mailbox recovery; restart reaches the same projection through replay.
- A live runner receives the typed control command, commits the response through its sole writer, directly applies it once, and never appends a duplicate completion.
- Rewind before the response makes it absent from selected ancestry; forks preserve the intended source-prefix behavior.
- PostgreSQL integration proves `fork(pre-response head) + resolve(explicit branch) + domain SQL` commit and rollback atomically in one transaction; source and fork ancestries expose the answer only where selected.
- JSONL rejects a stale second writer instead of catching up; PostgreSQL rejects a second lifetime writer claim.
- Pi and Claude recover and present open gates without semantic mailbox files; presentation receipts remain at-least-once and non-semantic if retained.
- Run focused tests, then `npm run typecheck`, `npm run check`, `npm run build-storybook` when affected UI stories change, and `git diff --check`.
- Run all TLA+ models:

  ```bash
  for M in MCReviewFix MCPipeline MCGate MCFanout MCMap MCNested; do tla/check.sh $M; done
  ```

- Re-record and validate the real trace:

  ```bash
  node tla/trace/record-sample.mjs
  tla/trace/validate.sh sample_chart.ts sample-run.jsonl main
  ```
