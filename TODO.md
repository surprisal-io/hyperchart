# TODO

## Revisit the `onReenter` design

The current `onReenter` design is too broad and has unclear semantics.

### Potential simplifications

`onReenter` should probably be allowed only for states with an `agent` action. Resuming a previous context makes sense only for an agent with a persisted session. `user` and `script` likely do not need a separate re-entry policy: when entered again, they can simply run again from scratch.

Decide whether `"restart"` should be removed from `onReenter` entirely. If omitting `onReenter` already means starting a new run, a separate `"restart"` value adds nothing.

### Unresolved `map` and `parallel` semantics

It is unclear how partially returning items or branches for rework should behave:

- resume the previous agent session for every selected item or branch;
- always create a new session;
- allow the policy to be configured separately on the child agent state;
- make the policy depend on the reason for re-entry: review feedback, retry, changed input, or a regular graph cycle.

The following questions are especially important:

1. How is the “same” map item identified across traversals: by key alone, or also by its value/input?
2. What happens when the key remains the same but the item has changed completely?
3. Should a completed branch/item session remain eligible for resume after leaving the `map`/`parallel` state?
4. Should a new branch/item always start with a new session?
5. Where is this decision configured: on the child agent state, on the `map`/`parallel` container, or automatically by the runtime?

### Required outcome

Define a single, simple contract that clearly answers two questions:

1. When does re-entry resume a previous agent session, and when does it create a new one?
2. How does this contract apply to individual items and branches inside `map` and `parallel`?

Do not expand the `onReenter` API or add more special cases until this decision is made.

## Revisit the replay design

Decide what replay should mean. The original idea was based on branching, but the current implementation behaves differently.

## Complete recursive actor calls

Send-only recursive actor messaging is implemented: `self()` is a typed symbolic capability for actor-local `send()`/`sendBatch()`, resolves to the current logical endpoint (the shared endpoint for a pool), preserves placement/map/generation identity, and uses ordinary FIFO drain semantics. Calls to `self()` remain rejected.

Do not enable self-`call` or static actor call cycles without choosing one coherent tail-call or reentrant policy. Under the current non-reentrant one-current-message rule, an ordinary self-call deadlocks; bounded pool capacity only makes that failure depth-dependent rather than valid.

Any future recursive-call implementation must cover durable frame/correlation semantics, cycle legality and deadlock behavior, replay and rewind, shutdown/draining, failure and cancellation, Inspector/TUI presentation, tests, TLA+, and trace validation.

## Support named replies in `callBatch()`

`callBatch()` currently accepts only protocol messages with one `reply` schema. Extend it to support messages with named replies such as `APPLIED` and `REJECTED`.

Define the ordered aggregate result shape and routing semantics first. Each batch item must retain its authored index, durable call/message identity, reply event, and validated event-specific output. Partial completion, mixed reply events, replay, rewind, pool worker assignment, failure, and Inspector presentation must remain deterministic without weakening atomic batch enqueue.

## Rework the documentation

Review and restructure the documentation. Its current organization and presentation are not effective enough and need a broader redesign.
