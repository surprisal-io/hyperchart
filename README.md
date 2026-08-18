<p align="center"><img src="assets/readme/hyperchart-logo.svg" width="112" alt="Hyperchart logo"></p>
<h1 align="center">Hyperchart</h1>
<p align="center"><strong>Durable, typed statechart workflows for agents and scripts.</strong></p>
<p align="center"><a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-6366f1"></a> <img alt="experimental version 0.5.0" src="https://img.shields.io/badge/status-experimental-f59e0b"> <img alt="Node 22.19 or newer" src="https://img.shields.io/badge/node-%3E%3D22.19-22c55e"></p>

Hyperchart runs long-lived work as an explicit statechart. The chart defines what may run, which event advances it, what data crosses each transition, and how a run can be reconstructed after a crash.

![Calligraphic paths surrounding the Hyperchart mark](assets/readme/hyperchart-hero.svg)

## Choose a package

| Package | Use it for |
|---|---|
| [`@surprisal/hyperchart`](packages/hyperchart) | Chart authoring, the pure machine, replay, the generic runtime, and host-neutral models. |
| [`@surprisal/pi-hyperchart`](packages/pi-hyperchart) | The Pi extension, `/hyperchart`, agent tools, terminal UI, and React inspector. |
| [`@surprisal/claude-hyperchart`](packages/claude-hyperchart) | The Claude Code plugin: `hyperchart_*` MCP tools, agent actions as Claude sessions, browser inspector, steering. |

All packages require Node.js 22.19 or newer. The host packages depend on the same version of the core package.

## Install

### From npm

Install the core package in a TypeScript or Node.js project:

```sh
npm install @surprisal/hyperchart
```

Install the complete Pi integration, including the extension, tools, inspector, and bundled skill:

```sh
pi install npm:@surprisal/pi-hyperchart
```

Pi supplies its host libraries to the extension in-process. On filesystem-backed Node.js installations, Hyperchart passes absolute module entries from that active Pi installation into each detached child bootstrap, so the runner uses the same Pi code instead of resolving or installing a second copy. Compiled Bun Pi binaries do not expose those embedded modules as files and are not currently supported for detached runners.

For durable production runs, pin both packages to the same exact version.

### From a local checkout

```sh
git clone https://github.com/surprisal-io/hyperchart.git
cd hyperchart
npm install
npm run build
pi install "$PWD/packages/pi-hyperchart"
```

Pi loads the local package in place, so later source changes remain available after rebuilding. Use `npm run check` before relying on a local checkout for real runs.

## Run a chart in Claude Code

Load the plugin from a checkout and talk to Claude — charts live in `.claude/hypercharts/`, agent actions run as real Claude sessions, and `hyperchart_view` opens the live browser inspector:

```sh
claude --plugin-dir "$PWD/packages/claude-hyperchart"
```

See the [Claude Code plugin guide](docs/claude-code.md) for tools, locations, steering, and remote setups.

## Run a chart in Pi

After installing the Pi package, create flat `.pi/hypercharts/hello.chart.ts` or bundle entrypoint `.pi/hypercharts/hello/chart.ts`:

```ts
import { artifact, chart, final, script } from "@surprisal/hyperchart";

export default chart({
  kind: "chart",
  id: "hello",
  initial: "write",
  states: {
    write: {
      kind: "state",
      action: script("node", [
        "-e",
        `require("node:fs").writeFileSync("hello.txt", "Hello from Hyperchart\\n")`,
      ], {
        artifacts: { greeting: artifact("hello.txt") },
      }),
      transitions: { DONE: "done" },
    },
    done: final(),
  },
});
```

A successful script with one non-`FAILED` transition emits that event implicitly. Ask Pi to inspect the chart with `hyperchart` with `action: "inspect"`, then start it:

```text
Use hyperchart action=inspect on .pi/hypercharts/hello.chart.ts
/hyperchart run .pi/hypercharts/hello.chart.ts
```

The run writes `hello.txt` and records its history under `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/hypercharts/runs/`.

Self-contained bundles may include chart-private `agents/`, `extensions/<name>/index.ts`, scripts, and guards. See [Pi extension: self-contained bundles](docs/pi.md#self-contained-bundles).

Read [Run your first chart](docs/quickstart.md) for installation checks, expected output, agent setup, and troubleshooting.

## What is durable

A run appends semantic facts to `log.jsonl`: arguments, action invocations, accepted events, map spawns, validation outcomes, and deadline firings. Current state is projected from those facts and the chart definition. It is not restored from a mutable checkpoint.

This makes crash recovery inspectable, but it does not undo external effects. A process may crash after a script or agent caused an external change and before the completion fact was appended. Read [Recovery and safety](docs/safety.md) before overriding replay warnings or rewinding a run.

## Inspector

The Pi package includes a terminal view and a React inspector built from canonical host models. Static chart information and runtime overlays remain separate: reusable agent cards show definition metadata, while a selected run state's `Runtime` section owns its live-session controls. Map actions held behind a `concurrency` limit appear as `waiting`, not as running sessions.

![Hyperchart inspector showing a running map state and its resolved details](assets/readme/inspector.png)

## Architecture

![Hyperchart package and runtime architecture](assets/readme/architecture.svg)

The pure machine requests facts and effects; it does not call Pi directly. The Pi package supplies the runner, agent executor, commands, tools, terminal UI, and React UI. See [Architecture](docs/architecture.md) for the execution loop and formal-model boundary.

## Documentation

- [Run your first chart](docs/quickstart.md)
- [Author charts](docs/core-authoring.md)
- [Compose nested, parallel, and map states](docs/composition.md)
- [Use the Pi extension](docs/pi.md)
- [Operate and recover runs](docs/safety.md)
- [Embed the runtime or React inspector](docs/integration.md)
- [Complete API reference](docs/api/README.md)
- [DSL reference and examples](docs/api/dsl.md)
- [File contracts and limitations](docs/reference.md)
- [Develop and release](docs/development.md)

Hyperchart is experimental. Pin exact package versions for durable runs and keep the chart source that produced each log.

### Explicit event-sourced actors

Use static actor templates and durable FIFO mailboxes to serialize side-effecting workflows globally or per finite map item. Delivery is receive-only, `send` is fire-and-forget, `call` awaits an exact typed reply, and normal exit drains actor scopes. See [docs/explicit-actors.md](docs/explicit-actors.md).

### Named branches and non-destructive rewind

Runs use an append-only v2 tree journal with mandatory record `branchId`, multiple durable named heads, non-durable checkout/view, fork-without-activation, and rewind as an append-only head move. Old linear logs are intentionally unsupported.
