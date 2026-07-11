# Runtime, durable logs, replay, and recovery

Hyperchart separates a pure state machine from effect execution. This page defines the adapter boundary and the guarantees a host must preserve.

## Stable runtime entry point

```ts
import { loop, start } from "@surprisal-io/hyperchart";
import type { Runtime } from "@surprisal-io/hyperchart/runtime";
```

```ts
interface Runtime {
  runEffects(effects: Effect[]): void;
  eventsQueue(): AsyncIterable<MachineEvent>;
  loadAst(): Promise<ChartAst>;
  loadLogs(): Promise<readonly DurableLogRecord[]>;
}
```

- `loadAst()` supplies one validated normalized chart.
- `loadLogs()` returns ordered durable facts.
- `runEffects()` receives work requested by the machine.
- `eventsQueue()` yields completions and durable-append acknowledgements back to the loop.

`start(runtime, args)` seeds a fresh run with arguments and begins execution. `loop(runtime)` continues from the current AST/log. Do not call `start` on a non-empty run as a substitute for resume.

## Effects and machine events

The pure machine requests effects for:

- durable record append;
- agent, script, and user actions;
- validation;
- timers;
- rejection feedback/restart;
- cancellation.

The host executes those effects and sends typed machine events. Durable records must be persisted before dependent work is treated as accepted. Preserve per-run ordering and do not invent transitions in the adapter; routing comes from the chart AST.

The package root exports `createMachineOutput()` and `stepMachine()` for lower-level integrations. Most hosts should use `start()`/`loop()` or `ChartRuntime` rather than hand-driving micro-steps.

## Generic runtime utilities

`@surprisal-io/hyperchart/runtime` exports the reusable host-neutral implementation pieces:

- `ChartRuntime` — effect interpreter over a log store and agent executor;
- `AgentExecutor` / `EmitCompletion` — host agent boundary;
- `JsonlLogStore`, `MemoryLogStore`, and `LogStore`;
- `ScriptRunner`, `runGuard`, and schema/artifact helpers;
- run-directory metadata helpers;
- final-machine outcome helpers.

Pi composes these with its own agent executor, status files, and runner process. A custom host may do the same without importing Pi.

## Minimal custom adapter shape

A practical adapter needs:

1. a durable `LogStore`;
2. an `AgentExecutor` implementation;
3. a work directory for scripts/artifacts;
4. a queue connecting effect completions to the execution loop;
5. timer and cancellation ownership;
6. a process-level status/health strategy.

The agent executor contract starts, rejects/resumes, cancels, and disposes actions by `ActionUID`. It must emit exactly the completion associated with that action identity and must not reuse a session across unrelated action UIDs.

Before production use, test crashes at every boundary: before append, after append/before dispatch, during external work, after external completion/before durable acceptance, and during cancellation.

## Durable record contract

The log is append-only JSONL facts, not serialized machine state. Every record has:

- monotonic `seqId`;
- causal `parentId` where applicable;
- `timestamp`;
- a typed record payload.

Current record families:

| Record | Meaning |
|---|---|
| `args` | Immutable run input arguments; first fact of a fresh run. |
| `spawned` | Pinned map instance keys and item values for one map visit. |
| `state_action / invoke` | An action visit was invoked; includes normalized action-definition provenance. |
| `state_action / complete` | The action emitted a completion or `FAILED` event. |
| `state_action / validated` | A guard and its accepted/rejected outcome; validation is not rerun on replay. |
| `state_action / timer_fired` | The action deadline won. |
| `session_ref` | Host session-file reference associated with a run/action. |

Transitions are deliberately not records. Projection looks up the current chart transition for each accepted event. This enables controlled chart evolution while making provenance mismatches visible.

Never reorder records, rewrite IDs, edit a live `log.jsonl`, or append a hand-created transition. Use exported projection/replay APIs.

## Projection

`createBranchProjection(ast)` creates an empty projection; `projectBranch(projection, ast, records)` applies facts. The projection derives:

- active leaves and entered scopes;
- pending action UIDs;
- accepted results;
- explicit transition inputs;
- map spawn sets;
- visit counts and timing-relevant facts.

Projection is deterministic for the same AST and ordered records. UI adapters should consume canonical host models rather than independently interpreting raw records.

## Crash and resume behavior

On resume:

1. load the exact chart export recorded in run metadata;
2. load all durable facts;
3. run `explainReplay(ast, records)`;
4. stop on structural breakage and surface warnings;
5. project accepted history;
6. recreate only pending effects;
7. continue consuming events.

Accepted completed work is not rerun. A map's persisted `spawned` value recreates the same instance membership even if the original source value changed.

A local log cannot guarantee exactly-once external side effects. A process may crash after an API accepted a request but before Hyperchart persisted completion. Use idempotency keys derived from action UID, transactional outboxes, content-addressed artifacts, or host-specific reconciliation.

## Replay explanation

`explainReplay()` classifies problems:

- **broken** — a structurally required fact cannot be interpreted safely; normal resume must stop;
- **stale** — recorded provenance no longer matches the relevant current definition;
- **skipped** — a record is outside the current projected traversal or cannot be applied as before.

A warning is evidence to investigate, not noise to suppress. The result includes record/state details suitable for operator and inspector UI.

## Chart evolution and replay warnings

Changes likely to affect replay include:

- chart ID, state ID, or nested topology changes;
- action kind, definition, reply, artifact, validation, deadline, or transition changes;
- map `over`, keys, or nested template paths;
- event names and explicit input bindings;
- changing the named module export used by the run.

Safe changes depend on which states have durable facts. Run replay explanation against representative logs before shipping a migration. Preserve old chart source or package version with important runs.

Prefer a new run after material topology changes.

## `--ignore-replay-warnings`

The Pi command/tool option continues despite stale or skipped warnings. It does not repair history and never makes a broken log valid.

Use it only when all of the following are true:

1. the run is backed up;
2. the replay explanation was inspected record by record;
3. every affected external side effect is accounted for;
4. the surviving history has the intended meaning under the new chart;
5. the decision is recorded for operators.

If any condition is uncertain, start a new run or perform a reviewed rewind.

## Rewind

Rewind is implemented by the Pi package because it owns run/session/artifact layout. It backs up and truncates a stopped run, optionally cleans downstream sessions/artifacts, and leaves the run stopped unless explicitly restarted. It cannot undo external side effects. See [Pi rewind reference](pi.md#rewind-reference).

## Runtime correctness checklist

- Append facts atomically and preserve order.
- Validate record provenance before replay.
- Keep action UID stable through one invocation lifecycle.
- Make external operations idempotent or reconcilable.
- Treat cancellation as cooperative.
- Persist map spawn membership.
- Do not rerun validators for accepted history.
- Test replay after process death and chart edits.
- Expose logs, status, and issues without letting UI code define a second semantics.
