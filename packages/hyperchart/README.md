# `@surprisal/hyperchart`

Host-neutral Hyperchart authoring, machine, replay, runtime, and inspector models.

## Install

```sh
npm install @surprisal/hyperchart
```

Requires Node.js 22.19 or newer.

## Create a chart

```ts
import { chart, final, script } from "@surprisal/hyperchart";

export default chart({
  kind: "chart",
  id: "hello",
  args: {
    message: { description: "Text to print", default: "hello" },
  },
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

Optional chart-level `args` metadata gives hosts serializable descriptions and JSON defaults for on-demand launch forms; it is inspection metadata, not executable validation or automatic runtime input. `refs<Args>().chart()` accepts subset or empty metadata and rejects every key outside `Args`, including typos mixed with valid keys. A script with one successful transition may select it implicitly on exit code `0`. Top-level `final()` and `failed()` terminals explicitly select `complete` or `failed` run outcome; optional terminal notifications can append a scoped prompt and authoritative paths for declared artifacts. Runner/host delivery uses a persist-once outbox and per-session receipts.

## Entry points

| Import | Purpose |
|---|---|
| `@surprisal/hyperchart` | DSL, types, parsing, inspection, machine, projection, replay |
| `@surprisal/hyperchart/runtime` | generic runtime, log stores, scripts, guards, artifacts |
| `@surprisal/hyperchart/host` | canonical chart/run models and adapters |
| `@surprisal/hyperchart/react` | optional React inspector and run surfaces |
| `@surprisal/hyperchart/react/styles.css` | required inspector stylesheet |
| `@surprisal/hyperchart/package.json` | package metadata |
| `@surprisal/hyperchart/inspect` | run inspection, inspector server, and session transcripts |
| `@surprisal/hyperchart/sessions` | session progress, steering, and run status |

The host runtime overlay distinguishes map actions held behind a `concurrency` gate as `waiting`; admitted or invoked actions remain `running`. In the React inspector, agent cards show declared role/toolset metadata and resolved model/tool configuration, while a selected run state's `Runtime` section owns its live-session controls and actual launch-plan summary. `HyperchartRunStrip` accepts the lightweight chart/run summaries from `readSessionSnapshot()` directly and hides progress when its three summary progress fields are omitted or incomplete.

The core package has no Pi dependency. React integrations use the optional peer dependencies declared by the package.

## Documentation

- [Run your first chart](https://github.com/surprisal-io/hyperchart/blob/main/docs/quickstart.md)
- [Author charts](https://github.com/surprisal-io/hyperchart/blob/main/docs/core-authoring.md)
- [Runtime and durability](https://github.com/surprisal-io/hyperchart/blob/main/docs/runtime-and-durability.md)
- [Complete API reference](https://github.com/surprisal-io/hyperchart/tree/main/docs/api)
- [DSL reference and examples](https://github.com/surprisal-io/hyperchart/blob/main/docs/api/dsl.md)

MIT · experimental `0.4.0`
