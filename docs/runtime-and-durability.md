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

## Append-only branch storage

`log.jsonl` is a flat v2 journal. Every line is either one branch create/move entry or one immutable `DurableLogRecord`, and every entry shares one positive per-run `seqId` namespace: the root `branch/create` owns `1`, then each record or branch operation consumes exactly the next id. Records also carry ancestry `parentId`, mandatory durable provenance `branchId`, and `timestamp`; gaps in record ids therefore identify intervening branch operations rather than missing records. Branch entries never enter chart projection.

A new run creates `main` before its first record. Only the v2 writer-produced format is supported; storage readers trust durable bytes instead of scanning for structural corruption or migrating legacy layouts.

JSONL parses the file and builds one private in-memory index when a read or write first needs the journal. It does not repair, truncate, or validate stored entries: malformed JSON fails the operation and leaves the file untouched. Branch handles created with `forBranch()` share that index, while independent readers open independent one-read views. Commits allocate from the shared writer index, reject a changed byte boundary, append only new flat entries, and publish them after the append succeeds.

PostgreSQL does not materialize the run journal on open. Branches, individual records, counts, and selected ancestry use SQL over the record `parent_id` chain. A transaction atomically reserves ids from the run's `hyperchart_run_meta.next_seq` counter, immediately inserts its rows inside `BEGIN`, and therefore sees its own writes without rereading or replay-validating the run. Counter reservations roll back with the transaction. PostgreSQL constraints and the session advisory writer claim are the storage contract. Replay compatibility still projects the selected ancestry against the current chart; that is a semantic check, not storage-integrity validation.

Public history uses a captured `{branchId, headSeqId}` and opaque stateless cursors. Record, state-visit, map-visit, actor-generation, and actor-message reads always return newest-first chunks of at most 100 items; cursors are bound to the exact snapshot and typed subject. Branch enumeration is read-committed keyset pagination rather than a history snapshot. The runtime-only projection stream is oldest-first and yields at most 500 facts per batch. Storage returns AST-free durable record groups; host presentation mapping remains outside storage.

The current PostgreSQL implementation is explicitly temporary correctness scaffolding: it may traverse and materialize the complete captured ancestry internally, then filters and caps the response. This is intentionally inefficient but does not leak an unbounded public result. A deferred version-order predecessor catalog will replace the backend implementation after a separate benchmark gate. JSONL answers the same contract from its private complete in-memory index and adds no on-disk sidecar.

A multi-record `appendDrafts()` call is the atomicity hint: PostgreSQL inserts its flat rows in one transaction, while JSONL concatenates its flat lines into one buffer and issues one `O_APPEND` write. JSONL serializes writes only within one Node process and intentionally provides neither cross-process writer consistency nor crash-atomic all-or-none recovery for a short or torn write. Each record owns its universal sequence id, and the final record becomes the branch head. Fork creates a head without selection; checkout/view is a non-durable handle; rewind appends a head move and preserves every prior record and downstream file.

One detached runner process may execute a dynamic, non-empty set of live branch reservations concurrently. It replay-gates all initial branch seeds before starting any initial runtime; dynamically admitted branches gate independently. Each admitted branch gets one `ChartRuntime` and one host executor over the shared journal. Executor instances are deliberately branch-scoped: Pi/Claude live-session maps cannot collide across branches. The process is failed if any branch fails; `status.json` v2 publishes current live `branchIds` and terminal states use `[]`. A singleton `branchId` runner config remains accepted and is normalized to one branch.

The run owns two different filesystem locations. `projectDir` is the repository/project directory recorded as `meta.workDir`; it scopes discovery and ownership but is not an action cwd. Each branch executes in `branchWorkspace = <runDir>/workspaces/<branchId>`, materialized only from pinned Hyperchart artifacts. Agent system context names both paths and warns that the branch workspace is not a repository checkout. Scripts receive authoritative `HYPERCHART_PROJECT_DIR` and `HYPERCHART_BRANCH_WORKSPACE` variables while retaining the branch workspace as `cwd`. Editing `projectDir` explicitly is outside branch-workspace isolation.

## Bounded live projection

`BranchProjection` is current machine state, not a history view. It retains only open journal-native user gates; resolving, closing, or global failure removes them, while exact historical response lookup and UI history come from the storage history API. Actor and pool projections retain mailbox/current-worker control plus pending call messages only; settled non-call message history is reconstructed from durable record groups rather than accumulated in each endpoint. The retained `actorProducerVisits` counter is exact and monotonic: replay requires each enqueue to use the next producer visit and canonical `<producer>:message:<visit>:<batchIndex>` identity, preserving durable global message-id uniqueness after settled payloads leave live state.

Accepted completion pins are projected into `artifactPins`, keyed by rendered authored path. `machine` attaches the current pin to each rendered artifact read, so `ChartRuntime` restores the accepted revision without reading ancestry or performing storage I/O from synchronous machine code.

`compileProjectionRetention(ast)` records statically discovered result readers, externally read map scopes, resumable actions, and re-enterable states. `compactProjection()` is synchronous. The initial implementation prunes only session references proven non-resumable; inputs, results, spawns, actor generations, and other values are retained whenever loops, guards, dynamic map paths, actor-local control, or future readers make liveness ambiguous. A stronger whole-chart data-flow analysis is deferred rather than guessed. Phase 3's execution-owned projection loader calls this seam after every projected batch and before checkpoint serialization.

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

## Artifact pins

A declared deliverable file is mutable on disk, but the state the workflow *accepted* is a fact. When a run directory is configured, completion admission snapshots each declared artifact into a content-addressable store inside the run directory and records a pin on the completion fact:

- the file is copied first and the copy is hashed, so the pin references exactly the stored bytes even if the working file keeps changing;
- schema checks at admission run against the snapshotted bytes, so the accepted revision is the validated one;
- the completion fact stores `artifacts: { <renderedPath>: { hash, size } }`; the pin is provenance — replay never re-hashes;
- store objects live at `<runDir>/artifact_store/objects/<aa>/<rest-of-sha256>` and are externally verifiable with `sha256sum`;
- identical content across branches or retries maps to one object.

On action entry the runtime restores each declared read to its pinned revision: if the file at the authored path no longer hashes to the producer's pin (a sibling branch overwrote it, or it was edited out of band), the pinned bytes are copied back before the action starts. Reads whose producer completion carries no pin keep current-file semantics. Files touched outside declared channels are outside the guarantee.

Completions recorded without pins — pre-versioning logs or runtimes without a run directory — are reported by `explainReplay()` as `unpinned` diagnostics: valid history whose historical artifact values are unverifiable.

Authored paths keep their public semantics: the working file stays where the chart declared it; the store is an append-only shadow, never a replacement.

## Map durability

A map appends `spawned` with the exact keys and items resolved on entry. Replay uses that record rather than re-reading a changed upstream value.

`concurrency` affects when instances may invoke actions. It does not change the persisted spawn set. Runtime inspection marks active instances held before invoke as `waiting`; only admitted instances are `running`.

Re-entering a map can create a new generation. Runtime inspection distinguishes generations so completions from an older traversal are shown as stale rather than pending in the current one.

## Operational overlays

The Pi package adds files that are useful but not semantic history:

| File | Meaning |
|---|---|
| `status.json` | v2 pid, heartbeat, process state, current live `branchIds`, opaque runner-attempt identity, terminal error, timestamps |
| `terminal-notification/request.json` | persist-once terminal prompt/outcome/artifact-path outbox with a fresh per-attempt UUID, written before terminal status |
| `terminal-notification/receipts/<request-hash>/*.json` | generation-isolated, recoverable per-host/session terminal-delivery leases and confirmed receipts |
| `terminal-notification-history/<generation>/` | complete outboxes archived when a terminal run starts another attempt; prior requests and receipts remain auditable but are no longer deliverable |
| journal `user_interaction/opened` | fully rendered durable gate; its record seqId is the external gate identity |
| journal `user_interaction/resolved` | validated external input that directly completes the user action |
| `user-interactions/<branchId>/<seqId>/receipts/*.json` | non-semantic per-host/session presentation claims and confirmations |
| `user-interactions/<branchId>/<seqId>/receipts/*.published` | internal immutable publication-order markers used only for cross-process presentation arbitration |
| `runner-control/user-responses/{requests,results}/*.json` | attempt-fenced, non-semantic command/ack transport to the sole live runtime writer; journal facts remain authoritative |
| `sessions/progress.json` | optional branch-tagged agent progress summaries |
| `sessions/<sanitized-branch-prefix>-<hash>/<actionUid>/<invocation>/` | collision-resistant branch-separated host conversation state and usage; there is no legacy-directory migration |
| `sessions/steering/*.json` | requests carrying `branchId`; the runner routes each only to that branch's executor |

A run may have a valid log and a stale process status. Conversely, a process can be alive while replay is incompatible. Operators must inspect both.

## Generic runtime components

`@surprisal/hyperchart/runtime` exports the supported runtime building blocks:

- the `Runtime` effect-interpreter interface;
- `ChartRuntime`;
- `AgentExecutor` and journal-native user-input admission;
- `ScriptRunner`;
- `JsonlLogStore`;
- run-directory and metadata helpers;
- artifact, guard, schema, and terminal-outcome helpers.

The generic runtime receives a host `AgentExecutor`. It owns effect interpretation and log mechanics; the host owns actual agent transport and session lifecycle.

Terminal notification metadata is a runner/host outbox protocol, not a durable machine transition or log fact. Delivery waits until `status.json` matches the request outcome. Each host launch opens a fresh opaque runner-attempt identity, and terminal requests record that identity. A new runner attempt archives any prior attempt's complete outbox, so a recovered run may publish a different eventual outcome without rewriting the old request; stale recovery also rejects a predecessor request if the process dies before archival. Receipt claims and confirmations are fenced by the caller's observed request UUID, preventing an in-flight old generation from confirming and suppressing its replacement. User interactions are a second file-backed rendezvous: the runner persists every open request immediately and remains alive while waiting, but only the containing branch blocks. Hosts select one owned request across parallel/map branches and runs by lexical `runId`, then numeric `seqId`, pinning it until response or close. Exact `originSessionId + canonical workDir` checks prevent another session or checkout from answering it.

A host validates the exact active `(runId, branchId, seqId)` coordinate, non-`FAILED` allowed event, and optional reply schema before atomically publishing a resolution. Identical responses are idempotent; divergent ones conflict. Machine cancellation closes an abandoned phase, while executor disposal on operator stop preserves it for resume. Gate files remain inspectable; only the exact live runner branch may accept a response, and global sequence ids are never reused.

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

## Actor mailbox facts

Explicit actors use the durable log as their only state. Creation, atomic enqueue, receive acceptance, reply validation, settlement/call wake-up, closing, drain, stop, and failure intent are semantic facts. Replay never reads an actor snapshot. See [Explicit event-sourced actors](./explicit-actors.md).

## Actor pools and batch facts

`actor_created.definition` contains the endpoint union; a pool record carries declared concurrency and the worker graph and materializes exactly that many workers. `actor_messages_enqueued.source.kind` remains one of `send | sendBatch | call | callBatch`, and every envelope preserves `callId` when present plus authored `batchIndex`. A normalized self-send retains `definition.self: true`, while `targetDeclaration` and `occurrence` record the resolved endpoint; for a pool this is the shared endpoint and `workerIndex` appears only when admission later assigns the message. Pool `actor_message` accepted/replied/settled facts require `workerIndex`; `occurrence` continues to name the endpoint. `actor_batch_call_resolved` stores `callId`, caller state, and ordered `messageIds`, while reply payloads stay in item reply facts.

Replay validates the FIFO head, that the durably selected worker was idle and receive-compatible at that prefix, assignment/reply/settlement identity, group membership and order, and full settlement before resolution. Fresh execution may select any eligible worker. While a pool acceptance append is unprojected, the machine keeps an ordered pool-local reservation that virtually dequeues its message and occupies its worker; it does not gate ordinary actors, unrelated pools, or other durable work. Projection becomes the sole owner of active worker state when the matching acknowledgement is applied. Closing stops external admission but continues pool assignment and active work; stop requires an empty mailbox and no worker current message.
