# Hyperchart documentation

Hyperchart is experimental software for durable TypeScript workflows. Start with the package that matches your job:

| Need | Package | Start |
|---|---|---|
| Author or embed charts in any Node host | `@surprisal-io/hyperchart` | [Core quickstart](core-authoring.md) |
| Run charts as Pi agents; use commands, tools, TUI or React UI | `@surprisal-io/pi-hyperchart` | [Pi quickstart](pi.md) |

## Guides

1. [Core authoring](core-authoring.md) — first chart, states/actions, refs, templates, transitions and inputs.
2. [Composition and reliability](composition.md) — compound/parallel/map, artifacts, validation, retries, deadlines.
3. [Runtime and durability](runtime-and-durability.md) — adapter contract, logs, replay, crash resume and chart changes.
4. [Pi extension](pi.md) — install/discovery, commands, four tools, lifecycle, inspect, rewind, agents and troubleshooting.
5. [Host and React integration](integration.md) — host snapshots, React inspector and theming.
6. [Reference](reference.md) — exports, chart/log shapes, limitations and glossary.
7. [Architecture](architecture.md) — execution semantics, boundaries and TLA+ trace validation.
8. [Examples](examples.md) — runnable charts and adaptation guidance.
9. [Development](development.md) — tests, documentation ownership and release procedure.

Use [examples](../examples/) as executable companions. The package READMEs are intentionally short; these pages are canonical.
