# API reference

This is the canonical reference for the two published packages. Task guides explain workflows; these pages document the complete supported import surface.

## Choose an entry point

| Entry point | Reference |
|---|---|
| `@surprisal-io/hyperchart` authoring DSL | [DSL reference](dsl.md) |
| `@surprisal-io/hyperchart` parser, inspector, machine, projection, replay, and utilities | [Core API](core.md) |
| `@surprisal-io/hyperchart/runtime` | [Runtime API](runtime.md) |
| `@surprisal-io/hyperchart/host` | [Host API](host.md) |
| `@surprisal-io/pi-hyperchart`, `/command`, `/pi-host`, and Pi tools | [Pi API](pi.md) |
| `@surprisal-io/pi-hyperchart/react` and `/react/styles.css` | [React API](react.md) |
| Both packages' `/package.json` subpaths | Package metadata (`name`, version, exports, engines, and manifest fields) |

## Stability boundary

The supported package entry points are:

```text
@surprisal-io/hyperchart
@surprisal-io/hyperchart/host
@surprisal-io/hyperchart/runtime
@surprisal-io/hyperchart/package.json
@surprisal-io/pi-hyperchart
@surprisal-io/pi-hyperchart/command
@surprisal-io/pi-hyperchart/pi-host
@surprisal-io/pi-hyperchart/react
@surprisal-io/pi-hyperchart/react/styles.css
@surprisal-io/pi-hyperchart/package.json
```

`@surprisal-io/hyperchart/internal/core/*` and `@surprisal-io/hyperchart/internal/utils/*` are available for first-party package wiring. They are not compatibility promises for application code and are intentionally excluded from this reference.

## Conventions

- **CST** types are authoring values accepted by `normalizeChartConfig()`.
- **AST** types are normalized, immutable chart data.
- A **state path** is an absolute template address such as `pipeline.review`.
- A **runtime path** may include map keys, for example `chapters#intro.write`.
- A **visit** is one entry into an action state.
- `FAILED` is the reserved system event.

All examples use public entry points only.
