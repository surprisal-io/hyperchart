<p align="center"><img src="assets/readme/hyperchart-logo.svg" width="112" alt="Hyperchart logo"></p>
<h1 align="center">Hyperchart</h1>
<p align="center"><strong>Durable, typed statechart workflows for agents and scripts.</strong></p>
<p align="center"><a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-6366f1"></a> <img alt="experimental version 0.1.0" src="https://img.shields.io/badge/status-experimental-f59e0b"> <img alt="Node 22.19 or newer" src="https://img.shields.io/badge/node-%3E%3D22.19-22c55e"></p>

![Abstract visualization of connected durable workflow states](assets/readme/hyperchart-hero.svg)

Hyperchart turns long-running agent work into explicit statecharts with typed handoffs, append-only facts, crash resume, validation, fan-out and inspection. The pure engine is host-neutral; the first complete integration is a Pi extension with commands, tools, terminal views and a React inspector.

> **Experimental 0.1.0:** useful and tested, but APIs and chart-migration tooling may change. Do not use replay overrides or rewind without reviewing their safety documentation.

## Choose a package

| Package | Choose it when… |
|---|---|
| [`@surprisal-io/hyperchart`](packages/hyperchart) | You author charts or embed the engine/runtime contract in any Node host. |
| [`@surprisal-io/pi-hyperchart`](packages/pi-hyperchart) | You want the Pi extension, four agent tools, TUI, React inspector and bundled skill. |

## Core in 60 seconds

```sh
npm install @surprisal-io/hyperchart
```

```ts
import { agent, final, refs, t, z } from "@surprisal-io/hyperchart";

const Reply = z.object({ answer: z.string() });
type Reply = z.infer<typeof Reply>;

const { chart, arg } = refs<
  { question: string },
  { work: Reply }
>();

export default chart({
  kind: "chart",
  id: "answer",
  initial: "work",
  states: {
    work: {
      kind: "state",
      action: agent("researcher", {
        task: t`Answer ${arg("question")}`,
        reply: Reply,
      }),
      transitions: { DONE: "done", FAILED: "failed" },
    },
    done: final(),
    failed: final(),
  },
});
```

Continue with [first chart and authoring](docs/core-authoring.md).

## Pi in 60 seconds

```sh
pi install npm:@surprisal-io/pi-hyperchart
mkdir -p .pi/hypercharts
# save the chart above as .pi/hypercharts/answer.chart.ts
```

```text
/hyperchart run answer --args '{"question":"Why do durable logs matter?"}'
```

Or let an agent call `hyperchart_inspect`, `hyperchart_run`, `hyperchart_run_inspect`, and—only for reviewed recovery—`hyperchart_rewind`. See the [Pi operations guide](docs/pi.md).

## Why Hyperchart

- **Resume rather than repeat:** project append-only facts after crashes.
- **Typed contracts:** Zod replies, typed refs/templates and validated artifacts.
- **Structure at scale:** nested states, parallel regions and bounded dynamic maps.
- **Operational control:** retries, rejection feedback, deadlines and explicit failure paths.
- **Inspectable runs:** definitions, active states, visits, usage and validation in one UI.
- **Host boundaries:** a pure machine/runtime contract, with Pi kept in its own package.

## Inspector

![Hyperchart inspector showing a real workflow graph, selected state and runtime details](assets/readme/inspector.png)

## Architecture

![Hyperchart architecture: typed charts and pure core write durable JSONL facts while the Pi package supplies tools, agents, TUI and React inspector](assets/readme/architecture.svg)

Execution semantics are independently articulated in TLA+ and checked against a trace recorded from the engine. Read [architecture and semantics](docs/architecture.md) and [durability/replay](docs/runtime-and-durability.md).

## Learn and contribute

- [Documentation index](docs/README.md) · [Examples](examples/) · [Public exports](docs/reference.md)
- [Host/React integration](docs/integration.md) · [Development and release](docs/development.md)
- [Contributing contract](AGENTS.md) · [MIT license](LICENSE)

Build locally with `npm install && npm run check`. Package validation inspects both tarballs and their links/import boundaries; nothing publishes automatically.
