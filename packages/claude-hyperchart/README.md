# @surprisal/claude-hyperchart

Claude Code plugin for [Hyperchart](https://github.com/surprisal-io/hyperchart): durable, typed statechart workflows whose agent actions run as real Claude sessions via the Claude Agent SDK, with a live localhost browser inspector and session steering.

## What you get

- **`hyperchart_*` MCP tools** — `list`, `inspect`, `run`, `run_inspect`, `steer`, `stop`, `view` — exposed to Claude by a bundled stdio MCP server.
- **Detached background runs** — a chart run is a separate runner process that survives the Claude session; state is durable in the run directory.
- **Agent actions as Claude sessions** — each chart agent runs through `@anthropic-ai/claude-agent-sdk` `query()` headless (permission checks bypassed inside the chart's working directory; the chart's guards and validators are the control surface). Model ids from agent definitions are passed to the SDK verbatim.
- **Live inspector** — `hyperchart_view` returns a tokenized localhost URL with the chart graph, per-state details, declared and resolved role/toolset configuration, live agent transcripts, and a steering composer.
- **SessionStart hook** — live runs for the current directory are surfaced as context when a Claude session starts.

## Install

Local development loop from this repository:

```bash
claude --plugin-dir packages/claude-hyperchart
```

Requires Node.js 22.19+ and a working Claude Code login (the detached runner inherits the environment, so the Agent SDK resolves the same credentials as the host session).

## Locations

| What | Where |
|---|---|
| Project charts | `<projectRoot>/.claude/hypercharts/` (project root = nearest ancestor with `.claude` or `.agents`) |
| User charts | `${CLAUDE_CONFIG_DIR:-~/.claude}/hypercharts/` |
| Run directories | `${HYPERCHART_RUNS_ROOT:-${CLAUDE_CONFIG_DIR:-~/.claude}/hypercharts/runs}` |
| Agent definitions | `<chartDir>/agents`, `<projectRoot>/.claude/agents`, `<projectRoot>/.agents`, `~/.agents`, `~/.claude/agents` |

Agent definitions use the same markdown + frontmatter format as the Pi host (`name`, `description`, `model`, `thinking`, `tools`, `systemPromptMode`; body = system prompt), so charts that ship agents next to the chart file are portable between hosts.

## Remote / SSH

By default the inspector binds `127.0.0.1` on the machine where Claude Code runs. Two ways to reach it from your own machine, configured via environment variables — the supported settings channel is the `env` block in Claude Code's `settings.json`, which the plugin's MCP server and spawned runners inherit:

```json
{
	"env": {
		"HYPERCHART_INSPECTOR_PORT": "8377",
		"HYPERCHART_INSPECTOR_HOST": "127.0.0.1"
	}
}
```

**Option A — SSH tunnel (recommended).** Pin the port and forward it once:

```bash
ssh -L 8377:127.0.0.1:8377 <server>
```

Under SSH the plugin does not try to open a server-side browser; `hyperchart_view` returns the URL — open it locally through the forwarded port.

**Option B — LAN binding (trusted networks only).** Set `HYPERCHART_INSPECTOR_HOST=0.0.0.0`; the inspector then listens on all interfaces and advertises the machine's LAN address in its URLs, so `hyperchart_view` returns a link that opens directly from your machine. The unguessable per-run URL token is the only access control in this mode (including session steering) — use it only on networks you trust (home LAN, VPN); prefer the SSH tunnel otherwise.

## Run layout

Each run directory contains `meta.json`, `status.json` (heartbeat + terminal state), `log.jsonl` (the durable event log), `runner.config.json`, runner stdout/stderr logs, and `sessions/` with per-action session progress, neutral JSONL transcripts, and the steering queue.

## Testing

`npm run check` covers the executor and MCP tools hermetically. An opt-in end-to-end test drives a one-agent chart through the real SDK:

```bash
HYPERCHART_E2E=1 npx vitest run tests/claude_e2e.test.ts
```

## Not yet included

Rewind tooling, marketplace packaging, model-id mapping between hosts, and cross-host run interop (Pi runs and Claude runs use separate run roots) are deliberately out of scope for this first version.
