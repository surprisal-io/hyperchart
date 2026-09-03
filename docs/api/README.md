# API reference

This is the canonical reference for the three published packages. Task guides explain workflows; these pages document the complete supported import surface.

## Choose an entry point

| Entry point | Reference |
|---|---|
| `@surprisal/hyperchart` authoring DSL | [DSL reference](dsl.md) |
| `@surprisal/hyperchart` parser, inspector, machine, projection, replay, and utilities | [Core API](core.md) |
| `@surprisal/hyperchart/runtime` | [Runtime API](runtime.md) |
| `@surprisal/hyperchart/runner` | Runner, branch, rewind, and user-interaction controls in [Runtime API](runtime.md) |
| `@surprisal/hyperchart/host` | [Host API](host.md) |
| `@surprisal/hyperchart/inspect` and `/sessions` | [Hosting API](hosting.md) |
| `@surprisal/pi-hyperchart`, `/command`, `/pi-host`, and Pi tools | [Pi API](pi.md) |
| `@surprisal/claude-hyperchart` and the Claude Code plugin surfaces | [Claude Code plugin](../claude-code.md) |
| `@surprisal/hyperchart/react`, `/react/styles.css`, `@surprisal/pi-hyperchart/react`, and `/react/styles.css` | [React API](react.md) |
| All packages' `/package.json` subpaths | Package metadata (`name`, version, exports, engines, and manifest fields) |

## Stability boundary

The supported package entry points are:

```text
@surprisal/hyperchart
@surprisal/hyperchart/host
@surprisal/hyperchart/runtime
@surprisal/hyperchart/runner
@surprisal/hyperchart/inspect
@surprisal/hyperchart/sessions
@surprisal/hyperchart/package.json
@surprisal/pi-hyperchart
@surprisal/pi-hyperchart/command
@surprisal/pi-hyperchart/pi-host
@surprisal/pi-hyperchart/react
@surprisal/pi-hyperchart/react/styles.css
@surprisal/hyperchart/react
@surprisal/hyperchart/react/styles.css
@surprisal/pi-hyperchart/package.json
@surprisal/claude-hyperchart
@surprisal/claude-hyperchart/package.json
```

`@surprisal/hyperchart/internal/core/*` and `@surprisal/hyperchart/internal/utils/*` are available for first-party package wiring. They are not compatibility promises for application code and are intentionally excluded from this reference.

## Conventions

- **CST** types are authoring values accepted by `normalizeChartConfig()`.
- **AST** types are normalized, immutable chart data.
- A **state path** is an absolute template address such as `pipeline.review`.
- A **runtime path** may include map keys, for example `chapters#intro.write`.
- A **visit** is one entry into an action state.
- `FAILED` is the reserved system event.

All examples use public entry points only.
