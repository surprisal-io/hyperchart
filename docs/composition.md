# Compose states

Use composition when a run needs hierarchy, concurrent regions, dynamic fan-out, validation, or controlled re-entry. Composition changes control flow; data still moves through explicit refs, transition inputs, and artifacts.

## Choose a state kind

| State kind | Enter behavior | Complete behavior | Use when |
|---|---|---|---|
| action | dispatch one agent, script, or user action | an event selects a transition | one unit of work produces one completion claim |
| compound | enter one `initial` child | a direct final child completes, then `onDone` exits | work is sequential or nested |
| parallel | enter every child region | every region reaches a final child, then `onDone` exits | a fixed set of branches runs concurrently |
| map | pin keys/items from `over`, then enter one instance per key | every instance reaches a final child, then `onDone` exits | the branch count comes from run data |
| final | no action | completes its containing state | a local branch is finished |

## Compound states

A compound state contains one active child at a time.

```ts
import { agent, compound, final } from "@surprisal/hyperchart";

pipeline: compound({
  initial: "draft",
  states: {
    draft: {
      kind: "state",
      action: agent("writer", { task: "Draft the answer." }),
      transitions: { DRAFTED: "review" },
    },
    review: {
      kind: "state",
      action: agent("reviewer", { task: "Review the draft." }),
      transitions: { PASS: "finished", FIX: "draft" },
    },
    finished: final(),
  },
  onDone: "publish",
})
```

Rules:

- entering `pipeline` follows `initial` until it reaches an action or final state;
- transition targets declared inside `pipeline` resolve among its children;
- an unhandled event bubbles to `pipeline.transitions` and then outward;
- a direct final child requires `onDone` on the compound state;
- leaving the compound state cancels running descendants;
- inspector marks untaken and historical descendants `done` after the scope reaches final and closes; `stale` remains only while re-entry is still active.

Use a final child for local completion. Do not model a compound state as an endless container with no completion path.

## Parallel states

A parallel state enters every child region.

```ts
import { agent, compound, final, parallel, script } from "@surprisal/hyperchart";

checks: parallel({
  states: {
    tests: compound({
      initial: "run",
      states: {
        run: {
          kind: "state",
          action: script("npm", ["test"]),
          transitions: { TESTS_PASS: "done" },
        },
        done: final(),
      },
    }),
    docs: compound({
      initial: "review",
      states: {
        review: {
          kind: "state",
          action: agent("docs-reviewer", { task: "Review documentation changes." }),
          transitions: { DOCS_PASS: "done" },
        },
        done: final(),
      },
    }),
  },
  onDone: "release",
})
```

Each direct child is a region. Regions do not declare `onDone`; their final child marks only that region complete. The parallel state exits after all regions are complete.

If an event bubbles to a transition on the parallel state or an ancestor, the whole parallel scope exits. Hyperchart cancels running actions in every abandoned region.

Use parallel states for a fixed branch set. Use a map when keys come from data.

## Map states

A map resolves `over` to an array or record, persists a spawn fact, and materializes one instance per key.

```ts
import { agent, final, map, refs, t, z } from "@surprisal/hyperchart";

const Plan = z.object({
  chapters: z.array(z.object({ title: z.string(), brief: z.string() })),
});
type Plan = z.infer<typeof Plan>;

const { chart, result, key, item } = refs<
  Record<string, never>,
  { plan: Plan },
  Record<never, Record<string, unknown>>,
  { chapters: Plan["chapters"][number] }
>();

const definition = chart({
  kind: "chart",
  id: "chapters",
  initial: "plan",
  states: {
    plan: {
      kind: "state",
      action: agent("planner", { reply: Plan }),
      transitions: { PLANNED: "chapters" },
    },
    chapters: map({
      over: result("plan", "chapters"),
      concurrency: 3,
      initial: "write",
      states: {
        write: {
          kind: "state",
          action: agent("writer", {
            task: t`Write ${item("chapters", "title")} for key ${key("chapters")}`,
          }),
          transitions: { WRITTEN: "done" },
        },
        done: final(),
      },
      onDone: "done",
    }),
    done: final(),
  },
});
```

Map behavior:

1. resolve `over` on entry;
2. derive stable string keys (`"0"`, `"1"`, … for arrays; property names for records);
3. append one spawn fact containing keys and items;
4. create runtime paths such as `chapters#0.write`;
5. invoke at most `concurrency` instances at once;
6. join after every instance reaches a final child.

`concurrency` gates action invocation, not spawn persistence. Omitting it allows all instances to run.

The spawn fact pins each key/item pair. Replay does not silently substitute a new array from changed upstream code.

## Fan-in artifacts

Inside a map, declare one artifact per instance:

```ts
artifacts: {
  chapter: artifact(t`artifacts/chapters/${key("chapters")}.md`),
}
```

After the map, collect those paths in spawn order:

```ts
reads: [joinArtifactOf("chapters.write", { artifact: "chapter" })]
```

For an agent, `joinArtifactOf()` becomes a list of files to read. For a script environment variable, it becomes a JSON array of paths.

Use artifacts for large deliverables. Keep reply payloads small and suitable for routing.

## Validation

A validator checks a completion claim before it becomes an accepted result fact.

```ts
review: {
  kind: "state",
  action: agent("reviewer", { reply: Review }),
  validate: script("node", ["bin/check-review.mjs"]),
  onReject: "resume",
  retries: 2,
  transitions: {
    PASS: "done",
  },
}
```

Validators are serializable references:

```ts
validate: script("python3", ["bin/check.py"])
```

or:

```ts
validate: tsImport("./guards/review.ts", "validateReview")
```

A guard returns `true` or `{ ok: false, reason }`.

A script guard accepts the complete script option surface (`env`, `artifacts`, and `reply`) as a script action:

```ts
validate: script("node", ["bin/check.mjs"], {
  env: {
    INPUT: t`${input("review")}`,
    SELF: artifactOf("review", { select: "approved" }),
    ALL: joinArtifactOf("items.produce"),
    VISIT: t`${visit()}`,
  },
})
```

Env templates resolve from the same args/results/input/item/key/visit projection scope and through the same renderer as script actions. `artifactOf()` without a selector passes a path; selected refs read and shape-validate the exact declared file; `joinArtifactOf()` passes a JSON array of paths. A validating action may read its own declared artifact. Prior refs retain normal dominance and ambiguity/name/select/shape checks. Missing or invalid reads reject closed. TypeScript guards receive only `(event, { chartDir, workDir })`; script stdin is the unchanged plain `ChartEvent`, with no special artifacts field.

A declared guard `reply` validates the guard completion envelope but is not stored as the action result. Guard-produced artifacts are validated after exit, unioned into the containing state's Files/artifact registry, and can be read by downstream `artifactOf()` refs; duplicate names with action artifacts are rejected. Env values are resolved only while validation is pending. Definitions and provenance remain in the AST/log, while accepted durable verdicts are replayed without re-running the guard.

### Rejection policy

| Setting | Behavior |
|---|---|
| `onReject: "resume"` | send the rejection reason back to the existing action/session |
| `onReject: "restart"` | abandon the rejected action and invoke a fresh one |
| omitted | defaults to `resume` when validation is present |

`retries` is the number of rejected rounds that may be retried. The next rejection records global failure intent and terminalizes the run; pending actions receive best-effort runtime cancellation. Omitting `retries` permits unbounded rejection rounds; use that only when another policy bounds the run.

Accepted facts are not revalidated during replay. Changing validator code can therefore make an old accepted claim incompatible; `explainReplay()` reports the mismatch instead of silently reinterpreting it.

## Deadlines

Add a deadline to an action state:

```ts
after: {
  delayMs: 120_000,
  target: "timed-out",
}
```

The timer begins when the action invoke fact is accepted. If the action is still running when the deadline fires, the chart transitions to the target and asks the runtime to cancel the action.

The timer covers action execution, not validation after a completion claim has arrived.

Cancellation is best effort at the external boundary. A process or agent may already have caused effects that Hyperchart cannot undo.

## Re-entry

By default, entering an action state again starts a new invocation.

```ts
onReenter: "restart"
```

An agent state may request session reuse:

```ts
onReenter: resume(t`Address this new input: ${input("notes")}`)
```

Session reuse is intentionally narrow. Map and parallel session identity becomes ambiguous when only part of a fan-out is revisited. Do not rely on partial fan-out reuse unless the chart and host define that identity explicitly.

A repeated state path is not the same visit. Runtime history records visits independently so the inspector can show resolved inputs, invocations, artifacts, validation attempts, and stale completions from older traversals.

## Failure and scope exit

`FAILED` is reserved global fail-fast. It cannot be authored in a transition: the machine records failure intent, starts no successor, terminalizes immediately, and emits best-effort runtime cancellation for pending actions. Model recoverable business outcomes with ordinary events or typed actor replies such as `REJECTED`; use `failed()` when the chart deliberately reaches a failed business terminal.

Leaving a compound, parallel, or map scope asks the runtime to cancel active descendant actions. Scope-exit and failure cancellation are best-effort effects derived from durable control-flow facts; cancellation itself is not recorded in the semantic log.

## Next steps

- [Pi run operations](pi.md)
- [Recovery and safety](safety.md)
- [Runtime and durability](runtime-and-durability.md)

## Lexical actors

[Explicit actors](./explicit-actors.md) are lexically scoped capabilities. Root actors serialize across the run; actors owned by a finite map have one isolated occurrence per pinned item. A caller can address only declarations in its own or an ancestor scope.
