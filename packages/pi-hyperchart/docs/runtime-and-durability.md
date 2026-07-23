# Runtime and durability

Hyperchart stores external and accepted workflow facts, then recomputes control state from those facts and the current chart.

This page describes the host-neutral runtime contract. For operator procedures, use [Recovery and safety](safety.md).

## The execution loop

A runtime iteration is:

1. read the normalized chart and ordered durable records;
2. project visits, accepted results, map instances, and pending actions;
3. ask the pure machine for the next output;
4. append requested records;
5. execute requested effects;
6. convert acknowledgements and completions into machine events;
7. repeat until the root reaches final or execution stops.

The machine does not call an agent provider, spawn a process, write a log file, or update Pi status. It returns data describing what the runtime must do.

## Machine output

The machine returns one of:

- `MachineOutputEffect` — append records, invoke an action, validate, start a timer, reject/resume, or cancel work;
- `MachineOutputFinal` — the root chart is complete;
- `MachineOutputError` — the machine reports a protocol or consistency error (e.g. a missing transition, a validation with no pending action) and the runtime throws.

Effect interpreters live in the runtime. This boundary keeps transition semantics testable without Pi.

## Durable records

`log.jsonl` is an ordered stream of `DurableLogRecord` values. Every record has:

- `seqId` — monotonically increasing sequence id;
- `parentId` — branch parent, or `null`;
- `timestamp` — append time;
- a record-specific payload.

Record kinds:

| Record | Meaning |
|---|---|
| `args` | run arguments for a fresh log |
| `session_ref` | Pi session file associated with an action invocation |
| `spawned` | pinned key/item set for one map entry |
| `state_action / invoke` | action identity and full normalized action definition |
| `state_action / complete` | completion event claimed by the action |
| `state_action / validated` | validator reference and stored verdict for a completion claim |
| `state_action / timer_fired` | deadline expired for an invocation |

Transitions are deliberately absent. The projection reads the event and asks the current chart where it leads.

Cancellation is a runtime effect derived from scope exit, deadline, terminal rejection, or stop. The durable cause is recorded where applicable—for example `timer_fired`—but there is no standalone cancellation record kind in the current log contract.

## Why store facts instead of current state

A mutable checkpoint answers “where did the old program say it was?” A fact log lets Hyperchart ask “what state follows from these accepted facts under this chart?”

That distinction supports:

- deterministic projection;
- visit and result history;
- pinned map instances;
- replay compatibility checks after chart edits;
- detection of missing action provenance;
- independent validation against the TLA+ model.

It also means chart changes are not automatically safe. If an old event would route differently, `explainReplay()` reports the mismatch.

## Projection

Projection derives:

- the active branch;
- one visit identity per entry;
- accepted results by runtime state path;
- transition inputs bound to visits;
- map spawn generations and instance paths;
- pending action invocations;
- completed and stale visits;
- deadlines and validation attempts.

Runtime map paths include keys:

```text
chapters#intro.write
```

Template paths omit keys:

```text
chapters.write
```

The distinction matters for artifact lookup, state selection, rewind, and replay diagnostics.

## Invocations and provenance

Every `state_action / invoke` record stores an `actionUid` and the normalized action definition. Replay compares that definition with the current chart.

The definition includes the action kind and settings needed to establish meaning: agent name and invocation overrides, script command/args/environment templates, schemas, reads, and artifact declarations.

A historical log without required provenance is structurally incompatible. Hyperchart must detect it as broken instead of assigning the current definition retroactively.

## Completion and validation

An action completion is a claim. The runtime checks:

1. event type is allowed;
2. reply output matches the declared schema;
3. declared artifacts exist and match their shapes;
4. an optional validator accepts the claim.

A validation verdict is durable. Replay reads the stored verdict; it does not run validator code again.

Because validator identity is stored, changing the validator can make replay stale or broken. This is intentional: the same accepted fact must not acquire a new meaning silently.

## Map durability

A map appends `spawned` with the exact keys and items resolved on entry. Replay uses that record rather than re-reading a changed upstream value.

`concurrency` affects when instances may invoke actions. It does not change the persisted spawn set. Runtime inspection marks active instances held before invoke as `waiting`; only admitted instances are `running`.

Re-entering a map can create a new generation. Runtime inspection distinguishes generations so completions from an older traversal are shown as stale rather than pending in the current one.

## Operational overlays

The Pi package adds files that are useful but not semantic history:

| File | Meaning |
|---|---|
| `status.json` | pid, heartbeat, process state, terminal error, timestamps |
| `terminal-notification/request.json` | persist-once terminal prompt/outcome/artifact-path outbox with a fresh per-generation UUID, written before terminal status |
| `terminal-notification/receipts/*.json` | recoverable per-host/session terminal-delivery leases and confirmed receipts |
| `user-interactions/<seqId>/request.json` | persist-once rendered user gate identified externally only by `(runId, seqId)` |
| `user-interactions/<seqId>/resolution.json` | immutable response-or-close winner; a committed response contains the validated chart event |
| `user-interactions/<seqId>/receipts/*.json` | per-host/session claims and presentation confirmations; never a second gate identity |
| `user-interactions/<seqId>/receipts/*.published` | internal immutable publication-order markers used only for cross-process presentation arbitration |
| `sessions/progress.json` | optional agent progress summaries |
| agent session files | host conversation state and usage |

A run may have a valid log and a stale process status. Conversely, a process can be alive while replay is incompatible. Operators must inspect both.

## Generic runtime components

`@surprisal/hyperchart/runtime` exports the supported runtime building blocks:

- the `Runtime` effect-interpreter interface;
- `ChartRuntime`;
- `AgentExecutor` and the file-backed `UserExecutor`;
- `ScriptRunner`;
- `JsonlLogStore`;
- run-directory and metadata helpers;
- artifact, guard, schema, and terminal-outcome helpers.

The generic runtime receives a host `AgentExecutor`. It owns effect interpretation and log mechanics; the host owns actual agent transport and session lifecycle.

Terminal notification metadata is a runner/host outbox protocol, not a durable machine transition or log fact. Delivery waits until `status.json` matches the request outcome. User interactions are a second file-backed rendezvous: the runner persists every open request immediately and remains alive while waiting, but only the containing branch blocks. Hosts select one owned request across parallel/map branches and runs by lexical `runId`, then numeric `seqId`, pinning it until response or close. Exact `originSessionId + canonical workDir` checks prevent another session or checkout from answering it.

A host validates the exact active coordinate, non-`FAILED` allowed event, and optional reply schema before atomically publishing a resolution. Identical responses are idempotent; divergent ones conflict. Machine cancellation closes an abandoned phase, while executor disposal on operator stop preserves it for resume. Rewind moves both the complete terminal outbox and the complete `user-interactions/` mailbox into its backup before replay resumes, preventing pre-rewind answers or receipts from matching reused sequence ids.

## Agent executor contract

A host executor receives a normalized agent effect and must report a completion event or failure through the runtime contract. It is also responsible for cancellation and cleanup of live work.

The executor must not invent transition targets. It returns events; the machine resolves targets from the chart.

For a custom host:

1. normalize the chart;
2. create a `JsonlLogStore` and runtime working directory;
3. implement `AgentExecutor` with stable invocation identity;
4. preserve event and artifact validation;
5. propagate cancellation;
6. expose semantic logs separately from host status.

See the exact exports in [Core API](api/core.md) and [Runtime API](api/runtime.md), and canonical UI models in [Host API](api/host.md).

## Replay compatibility

`explainReplay()` returns compatible, stale, skipped, and broken findings. The runner blocks stale/skipped replay unless the operator explicitly overrides warnings. Broken records remain unsafe.

Typical causes:

- an event now targets another state;
- a state or action no longer exists;
- an invocation definition changed;
- validator provenance changed;
- map or hierarchy structure changed;
- old logs lack mandatory provenance;
- a record belongs to a traversal skipped by the current chart.

Do not treat an override as migration. For recovery steps, read [Replay warnings](safety.md#replay-warnings).

## Crash ambiguity

The log append and an external side effect are not one atomic transaction. The critical ambiguous window is:

```text
invoke persisted → external side effect → crash → no completion persisted
```

The runtime can show the pending invocation and associated session/process information. It cannot infer whether a remote side effect happened. Reconciliation belongs to the host action and operator.

## Formal trace validation

The repository records a sample run from the TypeScript engine and checks that its exported trace is a behavior accepted by `tla/HyperchartTrace.tla`.

```sh
node tla/trace/record-sample.mjs
tla/trace/validate.sh sample_chart.ts sample-run.jsonl
```

`TRACE ACCEPTED` means the sampled engine and formal spec agree. It does not prove external agent or script side effects are transactional.

## Related pages

- [Recovery and safety](safety.md)
- [Architecture and TLA+](architecture.md)
- [Host and React integration](integration.md)
