# Hyperchart documentation

Hyperchart is a TypeScript statechart runtime for work that may span scripts, agent sessions, validation, fan-out, and process restarts.

## Start here

- [Run your first chart](quickstart.md) — install the Pi package, run a script-only chart, inspect the result, and find its durable log.
- [Examples](examples.md) — choose a checked-in example by prerequisite and behavior.

## Build charts

- [Author charts](core-authoring.md) — chart structure, actions, events, typed refs, templates, schemas, and artifacts.
- [Compose states](composition.md) — compound, parallel, and map states; validation; deadlines; re-entry; and fan-in.

## Run in Pi

- [Pi extension](pi.md) — discovery, `/hyperchart`, the four agent tools, agent definitions, run files, and troubleshooting.
- [Recovery and safety](safety.md) — executable chart modules, external side effects, replay warnings, rewind, and deletion.

## Embed Hyperchart

- [Runtime and durability](runtime-and-durability.md) — generic runtime, durable facts, projection, status overlays, and replay compatibility.
- [Host and React integration](integration.md) — host adapters, canonical models, React components, CSS, themes, portals, and SSR.

## Reference

- [API reference](api/README.md) — complete reference by public entry point.
- [DSL reference](api/dsl.md) — constructors, typed refs, state fields, schemas, transitions, artifacts, validation, and composition examples.
- [File contracts and limitations](reference.md) — run directory, lifecycle values, and current constraints.
- [Architecture](architecture.md) — package boundary, execution loop, control/data separation, TLA+ model, and trace validation.

## Contribute

- [Development and release](development.md) — repository setup, checks, documentation ownership, package validation, and release order.

> Hyperchart loads chart modules as executable TypeScript. Inspecting a chart does not execute its workflow actions, but loading the module can execute top-level code. Review untrusted source before using `hyperchart_inspect` or starting a run.
