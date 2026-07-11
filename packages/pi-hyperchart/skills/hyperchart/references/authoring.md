# Authoring

## Start with a chart skeleton

```ts
import { chart, final, script } from "@surprisal-io/hyperchart";

export default chart({
  kind: "chart",
  id: "example",
  initial: "work",
  states: {
    work: {
      kind: "state",
      action: script("node", ["-e", "console.log('done')"]),
      transitions: { DONE: "done" },
    },
    done: final(),
  },
});
```

Place project charts in `.pi/hypercharts/<name>.chart.ts`.

## Prefer typed refs

```ts
const { chart, arg, result, input, artifactOf, key, item } = refs<
  Args,
  Results,
  Files,
  Maps,
  Inputs
>();
```

Use `t` for templates and `json(ref)` for object/array interpolation. Use transition input for visit-local handoff and artifacts for large file deliverables.

## Actions

- `agent(name, options)` requires a concrete Pi agent definition.
- `script(command, args, options)` keeps dynamic values in `env`.
- `user(options)` is host-neutral but is not implemented by the current Pi executor.

Declare reply and artifact schemas with `z` where data must be validated.

## Composition

- `compound` — one active child;
- `parallel` — fixed concurrent regions;
- `map` — one pinned instance per key/item from `over`;
- `final` — completes the containing scope.

Use `joinArtifactOf()` after a map to collect one artifact path per instance.

## Validate before running

```json
{
  "chartPath": ".pi/hypercharts/example.chart.ts"
}
```

Call `hyperchart_inspect`. Resolve diagnostics and unavailable agent definitions before execution.

Chart inspection loads executable TypeScript. Review untrusted top-level code before calling it.
