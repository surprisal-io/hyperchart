# Composition, artifacts, validation, and re-entry

This guide covers nested control flow and reliability features. All examples import from `@surprisal-io/hyperchart`.

## Compound states

A compound state is a nested sequential machine:

```ts
compound({
  initial: "draft",
  states: {
    draft: {
      kind: "state",
      action: agent("writer", { task: "Draft the chapter." }),
      transitions: { DONE: "complete", FAILED: "failed" },
    },
    complete: final(),
    failed: final(),
  },
  onDone: "nextTopLevelState",
})
```

Entering a compound recursively enters its `initial` child. A direct final child completes the compound and routes through `onDone`. Events not handled by a child bubble to transitions declared on the compound. Targets declared inside the compound resolve among that compound's children; `onDone` resolves among the compound's siblings.

## Parallel states

A parallel state starts every child region together:

```ts
parallel({
  states: {
    research: compound({
      initial: "collect",
      states: {
        collect: {
          kind: "state",
          action: agent("researcher", { task: "Collect evidence." }),
          transitions: { DONE: "ready", FAILED: "failed" },
        },
        ready: final(),
        failed: final(),
      },
    }),
    design: compound({
      initial: "plan",
      states: {
        plan: {
          kind: "state",
          action: agent("designer", { task: "Plan the visual system." }),
          transitions: { DONE: "ready", FAILED: "failed" },
        },
        ready: final(),
        failed: final(),
      },
    }),
  },
  onDone: "assemble",
})
```

Each child becomes a parallel region. A final state completes only its region. The parallel state completes when every region is final, then takes `onDone`. A transition handled at the parallel or an ancestor exits all regions and cancels still-running work.

Parallel work is not a promise of thread-level simultaneous start. The runtime receives independent effects and may schedule them according to host capacity.

## Dynamic map states

A map materializes one nested instance per entry in its resolved `over` value:

```ts
const { chart, arg, key, item } = refs<
  { chapters: Record<string, { title: string }> },
  Record<never, never>,
  Record<never, Record<string, unknown>>,
  { chapters: { title: string } }
>();

const definition = map({
  over: arg("chapters"),
  concurrency: 3,
  initial: "write",
  states: {
    write: {
      kind: "state",
      action: agent("writer", {
        task: t`Write ${key("chapters")}: ${item("chapters", "title")}`,
      }),
      transitions: { DONE: "complete", FAILED: "failed" },
    },
    complete: final(),
    failed: final(),
  },
  onDone: "join",
});
```

`over` resolves to an array or record. Arrays receive stringified numeric keys; records keep their keys. Hyperchart writes a `spawned` fact containing both keys and values, so an instance's item is pinned even if the original source later changes. `concurrency` limits active invokes, not the persisted spawn set.

Runtime paths include instance keys, for example `chapters#intro.write`; source/template paths use `chapters.write`. Choose stable, deterministic keys. Changing keys creates different durable identities.

Map instances complete independently. The map completes only after every current instance reaches final. The inspector preserves prior visit generations and marks work from older traversals as stale rather than pending.

## Artifacts

Artifacts are declared on the producer:

```ts
const Report = z.object({ title: z.string(), sections: z.array(z.string()) });

action: agent("writer", {
  artifacts: {
    report: artifact("out/report.json", Report),
  },
})
```

A plain path is also accepted when no content schema is available:

```ts
artifacts: { screenshot: "out/screenshot.png" }
```

Consumers refer to producer identity, not duplicated paths:

```ts
reads: [artifactOf("write", { artifact: "report" })]
```

Use `select` to pass one validated field:

```ts
reads: [artifactOf("write", { artifact: "report", select: "sections" })]
```

Use `joinArtifactOf` to collect one artifact from every materialized map instance:

```ts
reads: [joinArtifactOf("chapters.write", { artifact: "chapter" })]
```

For an agent, a joined read expands to one file per instance. For a script environment value, it renders a JSON array of paths. Relative artifact paths resolve under the run work directory. The generic runtime rejects paths that escape the allowed workspace, missing files, and schema-invalid structured artifacts.

Artifacts are deliverables; replies are routing data. Prefer a file for large prose, reports, images, or structured datasets and a reply payload for small status/selection values.

## Validation guards

A validation guard evaluates a claimed completion before Hyperchart accepts it.

### Script guard

```ts
validate: script("node", ["scripts/check-report.mjs"]),
onReject: "resume",
retries: 2,
```

A guard script returns an accepted/rejected outcome according to the generic runtime guard contract. Keep it deterministic and side-effect-free.

### Imported TypeScript guard

```ts
validate: tsImport("./guards/report.ts", "validateReport"),
```

The imported function returns `true`, `false`, or `{ ok: false, reason: string }`. Chart definitions remain data-first: inline closures are rejected because they cannot be serialized, inspected, or fingerprinted reliably.

### Rejection policy and budget

`onReject` applies only when `validate` is present:

- `"resume"` sends rejection feedback to the still-running agent session;
- `"restart"` abandons that attempt and starts fresh.

When omitted, validation rejection defaults to resume. `retries: N` permits `N` rejected retries; the next rejection becomes `FAILED`. Omit `retries` for no configured rejection limit. Always provide an explicit failure route.

Validation attempts and feedback are operational history. Accepted completed work is never silently revalidated during replay.

## Deadlines and cancellation

Use `after` on an action state:

```ts
after: { delayMs: 120_000, target: "timedOut" }
```

The timer races the running action. If it wins, Hyperchart records control progress, emits cancellation for the action, and transitions to the target. The timer does not race post-completion validation. Cancellation is cooperative at external boundaries; a child process or remote API may take time to stop, so design side effects to tolerate late completion.

## Transition input

State and map nodes may declare input schemas:

```ts
input: { feedback: z.string() }
```

A transition binds event payload fields with `event(path?)`. Descendants read them with `input(name, path?)`. Inputs are resolved per visit and displayed with that visit in the runtime inspector. This makes feedback cycles explicit and durable instead of hiding them in mutable prompt text.

## State re-entry

Every entry creates a new visit. With no `onReenter` policy, an action is invoked normally for the new visit. The explicit forms are:

```ts
onReenter: "restart"
// or
onReenter: resume(t`Continue using this feedback: ${input("feedback")}`)
```

Resume re-entry is accepted for agent actions and map containers; non-agent action states cannot resume a conversation. Re-entry policy is experimental in 0.1.0. In particular, session reuse for partially repeated map items and parallel branches is still being specified. Do not assume a prior map key automatically means a prior conversational session will be reused; inspect visit and session history when designing feedback loops.

Validation `onReject` and control-flow `onReenter` are different:

- `onReject` reacts to a validator rejecting the current completion claim;
- `onReenter` applies after control flow leaves a state/scope and later enters it again.

## Reliability checklist

- Use stable state IDs and map keys.
- Give compound/map/parallel containers valid final/join routes.
- Catch `FAILED` deliberately at the right scope.
- Make validators deterministic and side effects idempotent.
- Bound fan-out with `concurrency` when the host has limited capacity.
- Keep large outputs in artifacts and validate their shape.
- Treat explicit re-entry and rewind as advanced features; verify them with runtime inspection.

See [`examples/deck-director.chart.ts`](../examples/deck-director.chart.ts) for an end-to-end composition example.
