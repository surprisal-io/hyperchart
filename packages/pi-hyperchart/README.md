# `@surprisal-io/pi-hyperchart`

Pi extension, run manager, agent executor, terminal UI, React inspector, and bundled Hyperchart skill.

## Install in Pi

Run from your shell:

```sh
pi install npm:@surprisal-io/pi-hyperchart
```

Start Pi after the install, or restart an existing Pi process. The package declares:

- `extensions/hyperchart.ts`;
- `skills/hyperchart/`.

It requires Node.js 22.19 or newer and the exact matching version of `@surprisal-io/hyperchart`.

## Start a chart

Place a chart in `.pi/hypercharts/name.chart.ts`, then run:

```text
/hyperchart run name
```

Run `/hyperchart` with no arguments to list recent runs for the current project.

## Pi tools

- `hyperchart_inspect`
- `hyperchart_run`
- `hyperchart_run_inspect`
- `hyperchart_rewind`

## Application entry points

| Import | Purpose |
|---|---|
| `@surprisal-io/pi-hyperchart` | same in-process command API as `/command` |
| `@surprisal-io/pi-hyperchart/command` | in-process `/hyperchart` request event |
| `@surprisal-io/pi-hyperchart/pi-host` | Pi chart/run host adapter |
| `@surprisal-io/pi-hyperchart/react` | inspector, graph, run strip, launch dialog, UI providers |
| `@surprisal-io/pi-hyperchart/react/styles.css` | required React stylesheet |
| `@surprisal-io/pi-hyperchart/package.json` | package metadata and Pi manifest |

## Documentation

- [Pi extension](https://github.com/surprisal-io/hyperchart/blob/main/docs/pi.md)
- [Pi API and agent tools](https://github.com/surprisal-io/hyperchart/blob/main/docs/api/pi.md)
- [React API](https://github.com/surprisal-io/hyperchart/blob/main/docs/api/react.md)
- [Run your first chart](https://github.com/surprisal-io/hyperchart/blob/main/docs/quickstart.md)
- [Recovery and safety](https://github.com/surprisal-io/hyperchart/blob/main/docs/safety.md)
- [React and host integration](https://github.com/surprisal-io/hyperchart/blob/main/docs/integration.md)

MIT · experimental `0.1.0`
