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

It requires Node.js 22.19 or newer and the exact matching version of `@surprisal/hyperchart`. Pi host libraries remain optional peers supplied by Pi's extension loader. On filesystem-backed Node.js installations, detached runners receive absolute module entries from the active Pi process and therefore use that same Pi installation rather than a separately resolved copy. Compiled Bun Pi binaries do not expose their embedded host modules as files and are not currently supported for detached runners.

## Start a chart

Place a chart in `.pi/hypercharts/name.chart.ts`, then run:

```text
/hyperchart run name          # asynchronous
/hyperchart run name --wait   # synchronous
```

The TUI stays compact: it shows active states and path-aware percentage progress. Run `/hyperchart` to select recent runs; Enter opens the selected run in the full localhost browser inspector. Map actions held behind a `concurrency` limit appear as `waiting`; only admitted work appears as `running` and can expose an active session. Agent cards show declared role/toolset names and their resolved model/tool allowlists; the selected state's run-specific `Runtime` section shows the actual launch plan plus transcript/current-tool polling and steering.

Asynchronous runs inject only a compact terminal boundary notice into the exact originating Pi session/workDir.
`--wait`/`wait: true` waits for terminal status or a user boundary and returns bounded identifiers/status only. Gate response identities remain exact; bounded prompt/option labels carry original/omitted character counts and are separate from exact option values. Structured user gates carry a bounded recursive, non-executable output contract; if any identity or contract cannot remain sufficient within its caps, delivery fails closed and directs the operator to the browser inspector.
Delivery uses at-least-once semantics.
Durable request IDs and recoverable claims prevent permanent suppression after crash.
Host may redeliver same request after crash between delivery and confirmation.
Treat each `requestId` idempotently.

## Pi agent tool

The consolidated `hyperchart` tool supports bounded responses only. Full definitions, schemas, runtime snapshots, visit histories, and transcripts never enter Pi tool results/session JSONL; `action: "view"` is the sole full inspection surface and returns exactly `{ "url": string }`. Deprecated `verbose: true` inspection calls are rejected.

Supported actions:

- `action: "list"`
- `action: "inspect"`
- `action: "run"`
- `action: "run_inspect"`
- `action: "view"` — open the localhost inspector and return its URL; pass `open: false` to return the URL only
- `action: "stop"`
- `action: "rewind"`

## Application entry points

| Import | Purpose |
|---|---|
| `@surprisal/pi-hyperchart` | same in-process command API as `/command` |
| `@surprisal/pi-hyperchart/command` | in-process `/hyperchart` request event |
| `@surprisal/pi-hyperchart/pi-host` | Pi host adapter: summary-only session lists plus on-demand full chart definitions (including launch metadata) and inspector runs; exposes originating Pi session for new runs |
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

MIT · experimental `0.4.1`

## Named branches

The consolidated `hyperchart` tool accepts explicit `branchId` for run, run inspection, view, response, and rewind; `action: "branches"` lists heads and `action: "fork"` creates a head without selecting or starting it. Rewind preserves all history and downstream files.
