# `@surprisal/pi-hyperchart`

Pi extension, run manager, agent executor, terminal UI, React inspector, and bundled Hyperchart skill.

## Install in Pi

Run from your shell:

```sh
pi install npm:@surprisal/pi-hyperchart
```

Start Pi after the install, or restart an existing Pi process. The package declares:

- `extensions/hyperchart.ts`;
- `skills/hyperchart/`.

It requires Node.js 22.19 or newer and the exact matching version of `@surprisal/hyperchart`.

## Start a chart

Place a chart in `.pi/hypercharts/name.chart.ts`, then run:

```text
/hyperchart run name          # asynchronous
/hyperchart run name --wait   # synchronous
```

The TUI stays compact: it shows active states and path-aware percentage progress. Run `/hyperchart` to select recent runs; Enter opens the selected run in the full localhost browser inspector.

## Pi tools

- `hyperchart` with `action: "inspect"`
- `hyperchart` with `action: "run"`
- `hyperchart` with `action: "run_inspect"`
- `hyperchart` with `action: "rewind"`

## Application entry points

| Import | Purpose |
|---|---|
| `@surprisal/pi-hyperchart` | same in-process command API as `/command` |
| `@surprisal/pi-hyperchart/command` | in-process `/hyperchart` request event |
| `@surprisal/pi-hyperchart/pi-host` | Pi chart/run host adapter; exposes originating Pi session for new runs |
| `@surprisal/pi-hyperchart/react` | inspector, graph, run strip, launch dialog, UI providers |
| `@surprisal/pi-hyperchart/react/styles.css` | required React stylesheet |
| `@surprisal/pi-hyperchart/package.json` | package metadata and Pi manifest |

## Bundled documentation

The published package includes `docs/`, runnable `examples/`, and the architecture diagram. The bundled skill links to these local, version-matched files so an agent does not need network access for authoring, tool schemas, or recovery guidance.

## Documentation

- [Pi extension](https://github.com/surprisal-io/hyperchart/blob/main/docs/pi.md)
- [Pi API and agent tools](https://github.com/surprisal-io/hyperchart/blob/main/docs/api/pi.md)
- [React API](https://github.com/surprisal-io/hyperchart/blob/main/docs/api/react.md)
- [Run your first chart](https://github.com/surprisal-io/hyperchart/blob/main/docs/quickstart.md)
- [Recovery and safety](https://github.com/surprisal-io/hyperchart/blob/main/docs/safety.md)
- [React and host integration](https://github.com/surprisal-io/hyperchart/blob/main/docs/integration.md)

MIT · experimental `0.1.0`
