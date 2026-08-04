# Explicit event-sourced actors

Explicit actors serialize side-effecting workflows behind a durable FIFO mailbox. They are a static composition tool, not dynamically addressable runtime objects.

## Protocol and template

```ts
import {
  actor, actorInput, agent, call, chart, final, item, message,
  messageInput, protocol, receive, reply, result, send, t, z,
} from "@surprisal/hyperchart";

const EditRequest = z.object({ patch: z.string() }).strict();
const EditReceipt = z.object({ commit: z.string() }).strict();
const EditRejection = z.object({ reason: z.string() }).strict();

const EditorProtocol = protocol({
  APPLY: message({
    input: EditRequest,
    replies: { APPLIED: EditReceipt, REJECTED: EditRejection },
  }),
});

const Editor = actor({
  input: z.object({ projectId: z.string(), file: z.string() }).strict(),
  protocol: EditorProtocol,
  initial: "idle",
  states: {
    idle: receive({ on: { APPLY: "apply" } }),
    apply: {
      kind: "state",
      action: agent("file-editor", {
        task: t`Apply ${messageInput("APPLY", "patch")} to ${actorInput("file")}`,
        reply: EditReceipt,
      }),
      transitions: { APPLIED: "settle" },
    },
    settle: reply({ target: "idle", event: "APPLIED", output: result("apply") }),
  },
});
```

`actor()` returns an authoring-time template. Calling `Editor({...})` returns one static declaration/capability. Put that declaration directly in exactly one lexical owner's `actors` object. There is no `defineActors`, no dynamic `ActorRef`, and declarations cannot appear in messages or other runtime values.

## Reply contracts

`message()` supports exactly three contracts:

- no `reply`/`replies`: durable void settlement;
- `reply: Schema`: one typed result;
- `replies: { EVENT: Schema }`: named business outcomes.

Every accepted message workflow ends at `reply()`. `reply()` has no `for`; normalization propagates the message context from `receive.on` through the graph and rejects missing or ambiguous reply paths. Void replies omit `event` and `output`; single replies provide only `output`; named replies provide a declared `event` and `output`.

## Placement and lexical addressing

```ts
const projectActors = {
  editor: Editor({
    projectId: item("id"),
    file: item("sourceFile"),
  }),
};
```

A root declaration has one occurrence per run. A map-owned declaration has one occurrence per pinned finite map item (`projects#a.@editor`, `projects#b.@editor`). A state can address only declarations in its own or an ancestor lexical owner. Runtime item keys can never select another item's actor.

Actor actions can read only immutable `actorInput()`, the accepted `messageInput()`, and actor-local results/artifacts/visits. Parent or sibling values must be captured explicitly in placement input.

## `send` and `call`

```ts
send({ to: actors.auditor, event: "RECORD", input: { path: result("prepare", "path") }, target: "next" });
send({ to: actors.auditor, event: "RECORD", inputs: result("prepare", "records"), target: "next" });
call({ to: projectActors.editor, event: "APPLY", input: result("prepare"), transitions: { APPLIED: "done", REJECTED: "rework" } });
```

`send` is fire-and-forget after a durable enqueue. It requires exactly one of `input` or `inputs`; an async exact validation failure writes no partial batch. `call` sends exactly one message and keeps the caller visit pending until the correlated typed reply. The optional `callId` is engine-owned; actors never name a reply recipient. Static actor-to-actor call cycles are rejected.

## Durable ordering and shutdown

The log is the only source of truth; actors have no snapshots or checkpoints. It records actor creation and immutable input provenance, atomic enqueue, receive acceptance, validated reply, settlement/caller wake-up, scope closing, drain, and stop. Message IDs derive from the producer state visit and batch index.

The receive-only invariant is unconditional:

1. a message is durable in the FIFO mailbox;
2. the actor is in an explicit `receive()` state;
3. the head is exact-validated and `actor_message.accepted` is durable;
4. one workflow owns it until one valid `reply()`;
5. only after settlement and return to `receive()` can the next head be accepted.

An unsupported FIFO head fails the run—there is no stash, selective receive, dead-letter queue, or silent drop. Normal owner exit closes its actors, rejects new external messages, drains accepted/queued work, resolves waiting calls, and stops idle occurrences before the owner completes.

Any reserved `FAILED` is global fail-fast, never authored routing. The machine durably writes failure intent, starts no successor, requests cancellation of every in-flight phase, records acknowledgements, and terminalizes failed only at quiescence. Domain outcomes such as `REJECTED` are named protocol replies. Explicit `failed()` remains the authored terminal business outcome.

Durability does not make external side effects exactly-once. Replay and rewind reconstruct actor state solely from the semantic log; rewinding cannot undo the outside world.

## Inspector

Static actor declarations are nested under their lexical owner; runtime occurrences remain separate per map item. Actor details show immutable input, protocol schemas, current state, ordered mailbox, current message, producer visit/call correlation, reply validation, drain, cancellation, visits, and actor-local outputs. Fire-and-forget send edges are dashed; call/reply correlation is shown as a wait edge. Large mailboxes use head/count with an expandable ordered list.
