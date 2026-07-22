# Author charts

A Hyperchart module exports one chart definition. The definition is normalized into a frozen, serializable AST before a run starts.

Use this page for the authoring contract. For nested, parallel, and map behavior, continue with [Compose states](composition.md).

## Chart anatomy

```ts
import { agent, final, refs, t, z } from "@surprisal/hyperchart";

const Review = z.object({ verdict: z.enum(["pass", "fix"]), notes: z.string() });
type Review = z.infer<typeof Review>;

const { chart, arg } = refs<
  { task: string },
  { review: Review }
>();

export default chart({
  kind: "chart",
  id: "review",
  initial: "review",
  states: {
    review: {
      kind: "state",
      action: agent("reviewer", {
        task: t`Review this task: ${arg("task")}`,
        reply: Review,
      }),
      transitions: {
        PASS: "done",
        FIX: "done",
      },
    },
    done: final(),
  },
});
```

Every chart has:

- `kind: "chart"`;
- a stable `id`;
- an `initial` state name;
- a `states` record;
- optional run-argument schema metadata.

State names are local inside the authoring tree. Normalization assigns absolute paths such as `review` or `pipeline.verify`.

## Use typed refs

`refs()` creates a chart constructor and selectors checked against your registries:

```ts
const { chart, arg, input, result, artifactOf, joinArtifactOf, key, item, event, visit } = refs<
  Args,
  Results,
  Files,
  Maps,
  Inputs
>();
```

The registries mean:

| Registry | Keys | Values |
|---|---|---|
| `Args` | run argument names | argument types |
| `Results` | action state paths | accepted reply types |
| `Files` | artifact-producing state paths | artifact name → file content type |
| `Maps` | map template paths | one map item type |
| `Inputs` | target state paths | named transition-input types |

The `chart()` returned by `refs()` checks that declared replies, artifacts, maps, and inputs match those registries in both directions. Use the root `chart()` helper only when you deliberately do not need typed registries.

### Select values

```ts
arg("task")                         // run argument
result("review")                   // full accepted result
result("review", "notes")          // dot-path selection
input("notes")                     // transition input in the current visit
artifactOf("render")               // path to one declared artifact
artifactOf("render", { artifact: "html" })
joinArtifactOf("chapters.author")  // one artifact path per map instance
key("chapters")                    // current map key
item("chapters", "title")          // current map item selection
event("payload.id")                // current event payload selection
visit("review")                    // visit number
```

Refs are data. They are resolved immediately before an action is dispatched; they are not arbitrary JavaScript callbacks.

## Render templates

Use `t` when text contains refs:

```ts
t`Review ${arg("task")} using ${artifactOf("prepare")}`
```

Use `json()` when a value must be serialized as JSON rather than interpolated as a string:

```ts
t`Items: ${json(result("plan", "items"))}`
```

Hyperchart recognizes only DSL interpolation tokens. Text that happens to contain `${...}` is not evaluated as JavaScript.

## Action states

An action state dispatches one action and waits for an event.

```ts
{
  kind: "state",
  action: agent("reviewer", { task: "Review the change." }),
  transitions: { PASS: "done", FIX: "repair" },
}
```

The action may be an agent, script, or user request.

### Agent actions

```ts
agent("reviewer", {
  task: t`Review ${arg("task")}`,
  reads: [artifactOf("prepare")],
  artifacts: {
    report: artifact("artifacts/review.json", Review),
  },
  reply: Review,
  model: "anthropic/claude-sonnet-4",
  thinking: "high",
  tools: ["read", "grep"],
})
```

The first argument is a Pi agent-definition name. Hyperchart resolves the concrete definition before execution. If it cannot load that definition, the state cannot run. Model, thinking level, tools, and system prompt are not inferred from an absent definition.

`model`, `thinking`, and `tools` in the chart override the resolved agent defaults for that invocation.

### Model roles

Instead of a concrete model, an agent definition can declare a symbolic `role` in its frontmatter:

```markdown
---
description: Reviews changes against the plan.
role: reviewer
model: anthropic/claude-sonnet-4
---
```

Roles are mapped to models once, in `settings.json` next to the charts — `<projectRoot>/<configDir>/hypercharts/settings.json` (project scope) and the user charts directory (user scope); project entries win per role key:

```json
{ "roles": { "reviewer": "anthropic/claude-opus-4-8", "fast": "anthropic/claude-haiku-4-5" } }
```

Model refs use the host's format, so charts stay portable between hosts. Resolution order per invocation: chart `model` override → configured role → definition `model` (the fallback when the role is not configured) → the host default model.

A declared role is a requirement, not a hint: if the role is not configured in settings and the definition declares no fallback `model` (and the chart does not override `model` for that invocation), the action fails with an error instead of silently running on the default model.

### Toolsets

Tool lists work the same way: a definition can declare a symbolic `toolset` instead of enumerating tools, with `tools` as the fallback when the toolset is not configured:

```markdown
---
description: Reviews changes against the plan.
toolset: reading
tools: read, grep
---
```

Toolsets live in the same `settings.json`, in the host's tool vocabulary (tool names differ between hosts, which is exactly why a symbolic name keeps the chart portable):

```json
{ "toolsets": { "reading": ["read", "grep"], "coding": ["read", "edit", "bash"] } }
```

Resolution order per invocation: chart `tools` override → configured toolset → definition `tools`. Same strictness as roles: an unconfigured toolset with no fallback `tools` (and no chart override) fails the action with an error.

Inspection preserves both layers: `role`/`toolset` are the declared symbolic names, while `resolvedModel`/`resolvedTools` are the effective host mapping. Static inspection uses current host settings. Concrete run inspection uses the mappings captured in that run's `runner.config.json`; live session progress records the actual model and explicit tool allowlist used at launch. If no tool list or toolset is declared, the host default tool configuration applies — this is not equivalent to allowing every installed tool.

### Script actions

```ts
script("python3", ["bin/build.py"], {
  env: {
    INPUT_JSON: t`${json(result("plan"))}`,
    OUTPUT_PATH: "artifacts/output.json",
  },
  artifacts: {
    output: artifact("artifacts/output.json", Output),
  },
  reply: Output,
})
```

Commands and arguments are static. Dynamic values enter through `env`; this avoids shell interpolation and keeps invocations inspectable.

A script completes as follows:

1. non-zero exit → `FAILED`;
2. otherwise, parse the last non-empty stdout line as `{ "type": "EVENT", "output": ... }`;
3. if there is exactly one allowed non-`FAILED` event, exit `0` may select it implicitly;
4. validate the event type, reply schema, and declared artifacts.

### User actions

```ts
user({
  prompt: "Approve the release?",
  reply: z.object({ approved: z.boolean() }),
})
```

User actions are part of the host-neutral DSL. The current Pi executor does not yet implement them. A chart containing one can be inspected but will fail if execution reaches it in Pi.

## Events and transitions

A transition can be a target string:

```ts
transitions: { PASS: "done" }
```

or an object with target input:

```ts
transitions: {
  FIX: {
    target: "repair",
    input: {
      notes: event("output.notes"),
      attempt: visit("review"),
    },
  },
}
```

Declare target input schemas on the destination state:

```ts
repair: {
  kind: "state",
  input: {
    notes: z.string(),
    attempt: z.number(),
  },
  action: agent("fixer", {
    task: t`Attempt ${input("attempt")}: ${input("notes")}`,
  }),
  transitions: { FIXED: "review" },
}
```

Input is bound to a visit, not permanently to a state path. Re-entering the same state creates a new visit and a new input binding.

Reserved system events include `FAILED`, validation outcomes, timer events, and scope cancellation. Do not invent application events that collide with reserved names.

## Replies and schemas

`reply` validates accepted event output:

```ts
const Decision = z.object({
  verdict: z.enum(["pass", "fix"]),
  notes: z.string(),
});

agent("reviewer", { task: "Review.", reply: Decision })
```

Hyperchart converts Zod schemas to JSON Schema for normalized source and inspection. Runtime validation still occurs before the result is accepted into the durable log.

The package re-exports `z` so charts can use the same Zod dependency:

```ts
import { z } from "@surprisal/hyperchart";
```

## Artifacts

Declare files that an action must produce:

```ts
artifacts: {
  report: artifact("artifacts/report.json", Report),
}
```

The path may be a template. A shape is optional; when present, Hyperchart validates file content before accepting completion.

Read artifacts through declared refs:

```ts
reads: [artifactOf("build", { artifact: "report" })]
```

Artifacts are files owned by the run or working directory. The durable log records the accepted declaration and invocation; it does not embed arbitrary file contents.

## Module loading and trust

Chart files are executable TypeScript modules loaded through Jiti. Importing, parsing, or inspecting a module may execute top-level JavaScript with the current user's permissions.

Keep chart modules declarative:

- no top-level network calls;
- no top-level writes;
- no timers or background processes;
- no environment-dependent mutation.

Review untrusted chart source before inspection. The word “static” in static inspection means “without runtime overlays,” not “safe evaluation without code execution.”

## Normalize before execution

`normalizeChartConfig()` validates structure and produces the AST used by the machine. It rejects unknown paths, invalid transition bindings, malformed composition, mismatched refs, and unsupported declarations.

The Pi runner normalizes automatically. Hosts embedding the core package should treat normalization errors as startup errors, not runtime branches.

## Next steps

- [Compose states](composition.md)
- [Runtime and durable facts](runtime-and-durability.md)
- [DSL reference](api/dsl.md)
