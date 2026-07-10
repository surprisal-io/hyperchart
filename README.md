# Hyperchart

Hyperchart is a TypeScript workflow engine for durable, typed taskflows, built around the statecharts model from the paper [Statecharts: A Visual Formalism for Complex Systems](https://doi.org/10.1016/0167-6423(87)90035-9). It lets you describe multi-step workflows as **charts**: state machines where each state can run an agent, run a script, ask a user, branch into nested states, fan out dynamically, or wait for parallel regions to finish.

The core engine is host-agnostic: it emits effects and consumes events through a runtime interface. This repository currently ships a Pi adapter/extension, but Hyperchart is not meant to be only for Pi.

Hyperchart is inspired by the statechart model and by [XState](https://xstate.js.org/): hierarchical states, explicit transitions, parallel regions, final states, and event-driven execution. It adapts those ideas for durable agent/script workflows, with append-only logs, typed artifacts, validation gates, retries, and host-specific runtime effects.

The project is currently experimental (`0.0.0`), but the core ideas are already in place:

- **TS-first chart authoring** with a small DSL and `zod` schemas.
- **Durable execution** through an append-only JSONL log.
- **Crash/resume semantics**: completed work is replayed from facts instead of rerun.
- **Agent, script, timer, validation, and artifact effects** behind a runtime interface.
- **Adapter-friendly runtime model**: Pi is the first host adapter, not the only possible one.

## Why this exists

Plain prompt chains are easy to start and hard to resume, inspect, validate, or evolve. Hyperchart makes agent workflows explicit:

- every accepted action is logged as data;
- every transition is declared;
- every artifact can have a schema;
- fan-out/fan-in is modeled instead of hand-managed;
- validations can reject an agent's completion and resume/restart it;
- runs can survive process crashes and continue from the durable log.

That makes it a good fit for workflows like review/fix loops, researched reports, multi-agent planning, codebase audits, and other long-running automated taskflows.

## Install and develop

Requirements:

- Node.js `>=22.19`
- npm

```bash
npm install
npm run build
npm run test
# or both:
npm run check
```

Project scripts:

| Command | What it does |
| --- | --- |
| `npm run typecheck` | Type-checks source, tests, examples, extensions, and Storybook without emitting files. |
| `npm run build` | Cleans `dist`, emits the production JavaScript/declarations, and builds the React stylesheet. |
| `npm run test` | Runs the Vitest suite. |
| `npm run check` | Runs type-check + production build + tests. |

The package is ESM (`"type": "module"`) and compiles to `dist/`.

### React inspector

The React entry point ships the inspector components and a compiled stylesheet. Import both:

```tsx
import { HyperchartInspectorDialog } from "pi-hyperchart/react";
import "pi-hyperchart/react/styles.css";
```

The stylesheet contains the Tailwind utilities used by the components and the default dark/light CSS variables. Use `HyperchartUiThemeProvider` around standalone React surfaces so portaled dialogs keep the selected theme:

```tsx
<HyperchartUiThemeProvider theme={{ resolved: "light", themeName: "base" }}>
	<HyperchartRunStrip {...props} />
</HyperchartUiThemeProvider>
```

The inspector also accepts the same `theme` value directly. A document-level `data-theme="light"` or `data-theme="dark"` remains supported when the host owns the portal root. Override the `--bg-*`, `--text-*`, `--border-*`, and `--hc-*` variables to integrate with a host theme.

## Quick start: author a chart

Charts are normal TypeScript modules. Define schemas with the re-exported `z`, create typed references with `refs<...>()`, then export a chart literal.

```ts
import { agent, final, refs, t, z } from "hyperchart";

const Research = z.object({ summary: z.string() });
const Plan = z.object({ steps: z.array(z.string()) });

type Research = z.infer<typeof Research>;
type Plan = z.infer<typeof Plan>;

const { chart, result } = refs<
	Record<string, never>,
	{ research: Research; plan: Plan }
>();

export default chart({
	kind: "chart",
	id: "review-and-fix",
	initial: "research",
	states: {
		research: {
			kind: "state",
			action: agent("researcher", {
				task: "Inspect the current repository and summarize the issue.",
				reply: Research,
			}),
			transitions: { RESEARCH_READY: "plan", FAILED: "failed" },
		},

		plan: {
			kind: "state",
			action: agent("planner", {
				task: t`Create a fix plan from this summary: ${result("research", "summary")}`,
				reply: Plan,
			}),
			transitions: { PLAN_READY: "done", FAILED: "failed" },
		},

		done: final(),
		failed: final(),
	},
});
```

See:

- `examples/api/review.chart.ts` for a minimal agent chain;
- `examples/deck-director.chart.ts` for a full workflow with maps, artifacts, scripts, validations, and deadlines;
- `.pi/hypercharts/code-review-fix-cycle.chart.ts` for a project-local review/fix cycle.

## Runtime adapters

Hyperchart itself is not tied to Pi. The pure core produces effects; a runtime adapter decides how to execute agents, scripts, timers, validations, artifact checks, and user interactions in a particular host.

A host integration can be a Pi extension, a standalone CLI, a server process, a CI orchestrator, or anything else that can persist logs and translate Hyperchart effects into real work. The reusable seam is the runtime contract in `src/runtime/runtime.ts`:

```ts
export interface Runtime {
	runEffects(effects: Effect[]): void;
	eventsQueue(): AsyncIterable<MachineEvent>;
	loadAst(): Promise<ChartAst>;
	loadLogs(): Promise<readonly DurableLogRecord[]>;
}
```

`start(runtime, args)` and `loop(runtime)` drive charts through that interface. The current adapter is Pi-specific and lives under `src/runtime/pi/` plus `extensions/hyperchart.ts`. More adapters or extensions can be added later without changing the chart model.

### Current adapter: Pi

The current package registers the Hyperchart Pi extension from `extensions/` via `package.json`. The directory can host more Pi extensions later; `/hyperchart` is just the current entry point:

```json
{
	"pi": {
		"extensions": ["./extensions"]
	}
}
```

Once loaded by Pi, use the `/hyperchart` command:

```text
/hyperchart run <name|chart.ts> [--args JSON] [--run-dir RUN_ID|DIR] [--export NAME]
/hyperchart resume <runId>
/hyperchart restart <runId>
/hyperchart status
/hyperchart view [runId]
/hyperchart stop <runId>
/hyperchart delete <runId>
```

Examples:

```text
/hyperchart run code-review-fix-cycle
/hyperchart run examples/deck-director.chart.ts --args '{"topic":"AI coding agents","audience":"engineers","goal":"explain tradeoffs","style":"analytical","constraints":"cite sources"}'
/hyperchart view
```

The extension also exposes an agent-callable tool:

```ts
hyperchart_run({
	chartPath: "code-review-fix-cycle",
	args: {},
	wait: true,
});
```

For the Pi adapter, run directories live under the Pi agent directory, in `hypercharts/runs/`. Each run stores metadata, status, sessions, runner logs, and the durable `log.jsonl`.

## Core concepts

### Charts

A chart is a serializable state-machine definition:

```ts
type Chart = {
	kind: "chart";
	id: string;
	initial: string;
	states: Record<string, State>;
};
```

The authoring shape is called the CST; `normalizeChartConfig()` validates it and produces a frozen AST.

### States

Supported state kinds:

| Kind | Purpose |
| --- | --- |
| `state` | Runs one action: agent, script, or user prompt. |
| `compound(...)` | Nested sequential state machine. |
| `parallel(...)` | Runs several regions concurrently and joins when all complete. |
| `map(...)` | Spawns one instance per item/key from runtime data, with optional concurrency. |
| `final()` | Marks completion of a compound/parallel/map/root branch. |

### Actions

`state.action` can be:

| Action | Description |
| --- | --- |
| `agent(name, options)` | Starts an agent action through the active runtime adapter and waits for a typed completion event. In the current Pi adapter, this is a Pi agent session. |
| `script(command, args, options)` | Runs a command as a workflow step or validation guard. |
| `user(options)` | Declares a user interaction step. The current Pi adapter warns because user actions are not implemented there yet. |

Agent options mirror the per-invocation surface: task text, read files, deliverable artifacts, model/thinking/tool overrides, and a `reply` schema for the completion payload.

### Typed refs and templates

`refs<Args, Results, Files, Maps>()` returns type-safe helpers:

- `arg("name")` reads run arguments;
- `result("state", "path.to.value")` reads a previous state's completion payload;
- `artifactOf("state")` reads a declared artifact from a producer;
- `joinArtifactOf("map.state")` fans in artifacts from every map instance;
- `key("map")` / `item("map")` read the current map instance key/item;
- `chart(...)` checks that declared result/artifact/map registries match the chart literal.

Templates are authored with `t\`...\``. Primitive refs interpolate directly; object refs must be wrapped with `json(ref)` so object-to-text conversion is explicit.

### Artifacts

Artifacts are declared where they are produced:

```ts
artifacts: {
	report: artifact("out/report.json", z.object({ title: z.string() })),
}
```

Consumers reference producers instead of hard-coding paths:

```ts
reads: [artifactOf("writeReport", { artifact: "report" })]
```

The runtime can verify existence and shape, and selectors can pass only a field of a validated file to the next step.

### Validation and retries

Action states can declare guards:

```ts
{
	kind: "state",
	action: agent("writer", { reply: z.object({ ok: z.boolean() }) }),
	validate: script("node", ["scripts/check-output.js"]),
	onReject: "resume",
	retries: 2,
	transitions: { DONE: "next", FAILED: "failed" },
}
```

A guard returns accept/reject. Rejections can either:

- `resume` the same agent session with feedback;
- `restart` the action from a fresh attempt.

When the retry budget is exhausted, the workflow transitions through `FAILED`.

### Deadlines

Use `after` to add a timer to a running action:

```ts
after: { delayMs: 120_000, target: "failed" }
```

If the timer fires first, the runtime cancels the action and transitions to the target.

## Architecture

```text
Author chart (.chart.ts)
        │
        ▼
DSL + refs + zod schemas
        │
        ▼
normalizeChartConfig()
        │     validates CST, resolves paths, emits frozen AST
        ▼
Pure core engine
        │     projection + machine + effect generation
        ▼
Execution loop
        │     feeds machine events to runtime effects
        ▼
Runtime
        │     log store, agent executor, script runner, guards, timers
        ▼
Host adapter
        │     current adapter: Pi runner, Pi agent sessions, status, TUI widgets
        ▼
Durable run directory
              log.jsonl, status.json, sessions/, runner logs
```

Important files:

| Path | Role |
| --- | --- |
| `src/index.ts` | Public API exports. |
| `src/core/types.ts` | Chart, state, action, template, event, and artifact types. |
| `src/core/dsl.ts` | Authoring helpers (`agent`, `script`, `map`, `parallel`, `artifact`, `t`, etc.). |
| `src/core/typed.ts` | Compile-time `refs<...>()` registry and typed selectors. |
| `src/core/normalize.ts` | CST validation and AST normalization. |
| `src/core/projection.ts` | Durable log replay into current branch state. |
| `src/core/machine.ts` | Pure state machine and effect production. |
| `src/core/execution_loop.ts` | `start()` / `loop()` runner over a generic runtime. |
| `src/runtime/generic/` | Runtime glue, log store, artifacts, guards, script runner. |
| `src/runtime/pi/` | Current Pi adapter: agent executor, runner process, paths, prompts, status. |
| `src/tui/` | Run widget, run overlay, and run-history UI used by the Pi adapter. |
| `extensions/hyperchart.ts` | Current Pi command/tool registration. |
| `examples/` | Example charts. |
| `tests/` | Unit, integration, extension, and replay-gauntlet tests. |

## Public API overview

Main authoring exports from `src/index.ts`:

```ts
import {
	agent,
	artifact,
	compound,
	final,
	json,
	map,
	parallel,
	refs,
	script,
	t,
	tsImport,
	user,
	z,
} from "hyperchart";
```

Runtime/parser exports include:

- `normalizeChartConfig()`
- `parseChartModule()` / `parseChartExport()` / `parseChartModuleAst()`
- `start()` / `loop()`
- `createMachineOutput()` / `stepMachine()`
- `createBranchProjection()` / `projectBranch()`
- `createAsyncQueue()` and async-iterable helpers

The public surface intentionally encourages `refs()` as the chart entry point. Low-level untyped helpers like raw `chart()`, `arg()`, `result()`, `artifactOf()`, `joinArtifactOf()`, `key()`, and `item()` are not exported directly from `src/index.ts`; they come from `refs()` so selectors stay type-checked.

## Testing philosophy

The test suite covers both small units and workflow-level behavior:

- parser and normalizer behavior;
- typed public exports;
- artifact validation and selectors;
- script actions and guards;
- execution loop and timers;
- compound, parallel, and map semantics;
- JSONL log store behavior;
- current Pi adapter path and extension command behavior;
- TUI run-view projection;
- replay gauntlet scenarios for crash recovery and chart changes.

Run it with:

```bash
npm run test
```

## Current caveats

- The package is experimental and versioned `0.0.0`.
- User-action states are declared in the DSL but not supported by the current Pi adapter yet.
- Chart modules are loaded dynamically through `jiti`; keep chart files importable as local TS/ESM modules.
- Chart definitions should stay data-first. Use `tsImport()` or `script(...)` for guards instead of inline closures.
- The current Pi adapter needs the optional peer dependencies `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`.

## Recommended reading order

If you are new to the codebase:

1. `src/index.ts` — public surface.
2. `examples/api/review.chart.ts` — smallest chart.
3. `examples/deck-director.chart.ts` — full-featured chart.
4. `src/core/types.ts` and `src/core/dsl.ts` — authoring model.
5. `src/core/typed.ts` — type-safe refs.
6. `src/core/normalize.ts` — validation rules.
7. `src/core/projection.ts` and `src/core/machine.ts` — durable state machine.
8. `src/runtime/generic/chart_runtime.ts` — effect interpreter.
9. `src/runtime/pi/pi_agent_executor.ts` and `extensions/hyperchart.ts` — current Pi adapter.
