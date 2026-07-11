# `@surprisal-io/hyperchart`

Host-neutral Hyperchart authoring, machine, replay, runtime, and inspector models.

## Install

```sh
npm install @surprisal-io/hyperchart
```

Requires Node.js 22.19 or newer.

## Create a chart

```ts
import { chart, final, script } from "@surprisal-io/hyperchart";

export default chart({
  kind: "chart",
  id: "hello",
  initial: "run",
  states: {
    run: {
      kind: "state",
      action: script("node", ["-e", "console.log('done')"]),
      transitions: { DONE: "done" },
    },
    done: final(),
  },
});
```

A script with one successful transition may select it implicitly on exit code `0`.

## Entry points

| Import | Purpose |
|---|---|
| `@surprisal-io/hyperchart` | DSL, types, parsing, inspection, machine, projection, replay |
| `@surprisal-io/hyperchart/runtime` | generic runtime, log stores, scripts, guards, artifacts |
| `@surprisal-io/hyperchart/host` | canonical chart/run models and adapters |
| `@surprisal-io/hyperchart/package.json` | package metadata |

This package has no Pi or React dependency.

## Documentation

- [Run your first chart](https://github.com/surprisal-io/hyperchart/blob/main/docs/quickstart.md)
- [Author charts](https://github.com/surprisal-io/hyperchart/blob/main/docs/core-authoring.md)
- [Runtime and durability](https://github.com/surprisal-io/hyperchart/blob/main/docs/runtime-and-durability.md)
- [Complete API reference](https://github.com/surprisal-io/hyperchart/tree/main/docs/api)
- [DSL reference and examples](https://github.com/surprisal-io/hyperchart/blob/main/docs/api/dsl.md)

MIT · experimental `0.1.0`
