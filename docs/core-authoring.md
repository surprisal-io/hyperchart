# Core authoring guide

This guide covers the public chart-authoring surface of `@surprisal-io/hyperchart`. Hyperchart charts are TypeScript modules whose exported value is plain, normalizable data. Runtime code is supplied by a host such as Pi.

## Install and create a chart

Hyperchart requires Node.js 22.19 or newer and uses ESM.

```sh
npm install @surprisal-io/hyperchart
```

Create `review.chart.ts`:

```ts
import { agent, final, refs, t, z } from "@surprisal-io/hyperchart";

const Research = z.object({ summary: z.string() });
const Plan = z.object({ steps: z.array(z.string()) });

type Research = z.infer<typeof Research>;
type Plan = z.infer<typeof Plan>;

const { chart, arg, result } = refs<
  { topic: string },
  { research: Research; plan: Plan }
>();

export default chart({
  kind: "chart",
  id: "review",
  initial: "research",
  states: {
    research: {
      kind: "state",
      action: agent("researcher", {
        task: t`Research ${arg("topic")}`,
        reply: Research,
      }),
      transitions: { DONE: "plan", FAILED: "failed" },
    },
    plan: {
      kind: "state",
      action: agent("planner", {
        task: t`Plan from ${result("research", "summary")}`,
        reply: Plan,
      }),
      transitions: { DONE: "done", FAILED: "failed" },
    },
    done: final(),
    failed: final(),
  },
});
```

A chart may be the default export or a named export. Pass the export name to the parser, Pi command, or Pi tool when it is not `default`.

## Chart contract

A chart has four required fields:

| Field | Meaning |
|---|---|
| `kind: "chart"` | Identifies the authoring value. |
| `id` | Stable chart identity included in action provenance. |
| `initial` | Top-level state entered first. |
| `states` | Top-level state record. |

State IDs and nested paths are durable identity. Renaming a chart or state can invalidate old facts. Read [chart evolution and replay](runtime-and-durability.md#chart-evolution-and-replay-warnings) before changing a chart used by an existing run.

## State kinds

| Kind | Constructor | Purpose |
|---|---|---|
| action | object with `kind: "state"` | Runs one agent, script, or user action. |
| compound | `compound(options)` | Nested sequential state machine. |
| parallel | `parallel(options)` | Enters all regions and joins after every region reaches final. |
| map | `map(options)` | Materializes one nested instance per resolved item/key. |
| final | `final()` | Completes the enclosing chart, compound, region, or map instance. |

The composition rules and full examples are in [Composition, artifacts, and reliability](composition.md).

## Actions

### Agent

```ts
agent("writer", {
  task: "Write the report.",
  reads: ["notes.md"],
  artifacts: { report: artifact("out/report.json", ReportSchema) },
  reply: z.object({ title: z.string() }),
  model: "provider/model",
  thinking: "high",
  tools: ["read", "write"],
})
```

`name` resolves a host agent definition. `task` is the per-invocation user message; it does not replace the agent definition's system prompt. `reads` supplies raw paths or declared producer artifacts. `artifacts` declares files the invocation must produce. `reply` describes the small completion-event payload. `model`, `thinking`, and `tools` are opaque host overrides.

A missing Pi agent definition is a runtime error. The inspector marks it unavailable rather than pretending every tool is allowed.

### Script

```ts
script("node", ["scripts/summarize.mjs"], {
  env: {
    TOPIC: t`${arg("topic")}`,
    SOURCE: artifactOf("research", { artifact: "notes" }),
  },
  artifacts: { summary: artifact("out/summary.json", SummarySchema) },
  reply: z.object({ count: z.number() }),
})
```

The command and argument vector are static. Dynamic values flow through `env`. The generic runtime runs the process in the run work directory, parses structured stdout when a reply schema is declared, and emits `FAILED` for a non-zero exit.

### User

```ts
user({
  prompt: "Approve the release?",
  options: ["approve", "reject"],
  reply: z.object({ approved: z.boolean() }),
})
```

User actions are part of the host-neutral contract. The Pi adapter currently warns because it does not implement them.

## Schemas and completion events

Hyperchart re-exports `z` from Zod so chart modules need one direct package import. A `reply` schema performs three jobs:

1. gives TypeScript a result type through `z.infer`;
2. gives agents a structured completion contract;
3. gives the runtime a JSON Schema representation for validation.

An action completes with an event such as `DONE`, plus an optional payload. `FAILED` is reserved for system failure. Declare every event the action may emit under `transitions` or on an ancestor that intentionally catches it.

## Typed refs

`refs<Args, Results, Files, Maps, Inputs>()` creates typed selectors and a checking `chart` constructor.

| Helper | Reads |
|---|---|
| `arg("name")` | Run argument. |
| `result("state", "path.to.field")` | Accepted completion payload from a producer state. |
| `artifactOf("state", options)` | Declared artifact from one producer. |
| `joinArtifactOf("map.child", options)` | The corresponding artifact from every map instance. |
| `key("map.path")` | Current map instance key. |
| `item("map.path", "field")` | Current map instance item or selected field. |
| `input("name", "field")` | Explicit transition input in the nearest declaring scope. |
| `visit("state")` | Visit number of a state. |
| `event("field")` | Binds a completion-event field into a transition input. |

The generic parameters are registries, not runtime configuration:

```ts
const refsApi = refs<
  { topic: string },
  { research: Research },
  { research: { notes: NotesFile } },
  { chapters: Chapter },
  { "chapters.write": { feedback: string } }
>();
```

The `chart` constructor verifies that declared reply, artifact, map, and input registries match the chart literal. Paths are checked at compile time where the value type is known. Runtime normalization still verifies that referenced states and scopes exist.

Untyped helpers (`arg`, `result`, `artifactOf`, `joinArtifactOf`, `key`, `item`) are available for low-level use, but `refs()` is the recommended authoring entry point.

## Templates and JSON

Use `t` for values resolved immediately before dispatch:

```ts
const task = t`Summarize ${result("research", "summary")} for ${arg("audience")}`;
```

Strings, numbers, and booleans interpolate directly. Object and array refs must be explicit:

```ts
const task = t`Use this plan: ${json(result("plan"))}`;
```

This avoids accidental `"[object Object]"` output. Templates are stored as strings plus typed ref nodes; Hyperchart does not parse a placeholder language out of arbitrary braces.

## Transitions and explicit input

A short transition contains only a target:

```ts
transitions: { DONE: "next", FAILED: "failed" }
```

Use the object form to bind event data into declared input:

```ts
review: {
  kind: "state",
  input: { feedback: z.string() },
  action: agent("reviewer", { task: t`Review: ${input("feedback")}` }),
  transitions: { DONE: "done", FAILED: "failed" },
}

// On the producer:
transitions: {
  NEEDS_REVIEW: {
    target: "review",
    input: { feedback: event("reason") },
  },
}
```

Targets are local IDs resolved among siblings at the declaration level. Nested topology is flattened to absolute state paths during normalization. Events bubble from the active state through enclosing compound/map/parallel scopes until handled.

## Parsing, normalization, and inspection

The main package exports:

- `normalizeChartConfig(value, source?)` — validate CST and produce a frozen AST or diagnostics;
- `parseChartExport(value, source?)` — normalize one already-loaded value;
- `parseChartModule(path, options?)` / `parseChartModuleAst(...)` — asynchronously load a module;
- `parseChartModuleSync(path, options?)` — load TypeScript through Jiti;
- `inspectChartAst(ast, options?)` / `inspectChartModuleSync(...)` — produce static source, contract, and graph information without running work;
- `hyperchartSource(ast)` / `hyperchartStateSources(ast)` — generate validated DSL source views.

Treat diagnostics as errors to fix, not as reasons to cast through `any`. Static inspection never contains runtime status, logs, usage, sessions, or visits; those belong to a run overlay.

## Authoring checklist

- Use stable chart/state IDs and stable map keys.
- Give every failure path an explicit `FAILED` route.
- Keep completion payloads small; put deliverables in artifacts.
- Use typed refs instead of ambient mutable files where possible.
- Make scripts and external side effects idempotent.
- Inspect and typecheck charts before running them.
- Read [durability](runtime-and-durability.md) before evolving a chart with existing runs.

## Examples

- [`examples/api/review.chart.ts`](../examples/api/review.chart.ts) — small typed chain.
- [`examples/deck-director.chart.ts`](../examples/deck-director.chart.ts) — maps, artifacts, scripts, validation, and deadlines.
- [Examples guide](examples.md) — how to run and adapt the included charts.
