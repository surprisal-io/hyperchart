# Claude Code plugin

`@surprisal/claude-hyperchart` runs Hyperchart workflows from Claude Code. Chart agent actions execute as real Claude sessions through the Claude Agent SDK; runs are detached background processes with durable state, a live browser inspector, and session steering.

## Install and launch

The plugin is loaded per session from a checkout:

```sh
claude --plugin-dir /path/to/hyperchart/packages/claude-hyperchart
```

Requires Node.js 22.19+ and a working Claude Code login: the detached runner inherits the environment, so agent sessions resolve the same credentials as the host session. A SessionStart hook lists this directory's live runs as context whenever a session starts.

## Tools

The bundled MCP server exposes seven tools. Claude picks them up through the `hyperchart` skill; in conversation you normally just describe what you want.

| Task | Tool |
|---|---|
| List chart definitions and this directory's runs | `hyperchart_list` |
| Validate and inspect a chart definition | `hyperchart_inspect` |
| Start a chart or resume an existing run | `hyperchart_run` |
| Inspect durable state for one run | `hyperchart_run_inspect` |
| Queue a steering message for a live agent session | `hyperchart_steer` |
| Stop one or all active runs | `hyperchart_stop` |
| Back up and truncate a stopped run's log for recovery | `hyperchart_rewind` |
| Open the browser inspector and return its URL | `hyperchart_view` |

`hyperchart_run` is asynchronous by default: the runner is a detached process that survives the Claude session. Pass `wait: true` only when the current task must block until a terminal status.

## Locations

| What | Where |
|---|---|
| Project charts | `<projectRoot>/.claude/hypercharts/` (project root = nearest ancestor with `.claude` or `.agents`) |
| User charts | `${CLAUDE_CONFIG_DIR:-~/.claude}/hypercharts/` |
| Run directories | `${HYPERCHART_RUNS_ROOT:-${CLAUDE_CONFIG_DIR:-~/.claude}/hypercharts/runs}` |
| Agent definitions | `<chartDir>/agents`, `<projectRoot>/.claude/agents`, `<projectRoot>/.agents`, `~/.agents`, `~/.claude/agents` |

Agent definitions use the same markdown + frontmatter format as the Pi host (`name`, `description`, `role`, `toolset`, `model`, `thinking`, `tools`, `systemPromptMode`; body = system prompt), so charts that ship agents next to the chart file are portable between hosts. Model ids are passed to the Claude Agent SDK verbatim (for example `claude-sonnet-5`, `claude-opus-4-8`); `thinking` levels map onto the SDK's effort control.

A `role` in frontmatter names a symbolic model tier and a `toolset` a symbolic tool list, both resolved through `settings.json` in the charts directories (`<projectRoot>/.claude/hypercharts/settings.json` and `~/.claude/hypercharts/settings.json`, project entries winning per key): `{ "roles": { "reviewer": "opus" }, "toolsets": { "reading": ["Read", "Grep"] } }`. Because each host maps these names in its own settings, a chart declaring them is portable even though model ids and tool names differ between hosts. An unconfigured role falls back to the frontmatter `model`, and an unconfigured toolset to the frontmatter `tools`; with no fallback declared (and no chart-level override) the action fails with an error instead of silently running on defaults. See [Core authoring](core-authoring.md) for the resolution order.

## How agent sessions run

Each agent action becomes one SDK `query()` session in the run's working directory. Sessions run headless with permission checks bypassed and without user or project settings, so chart behavior does not depend on the machine's Claude configuration; the chart's guards and validators are the control surface. The executor streams text and thinking deltas into session progress, writes a neutral JSONL transcript per session into the run directory, and delivers steering messages into the live turn after the current tool call. If the runner restarts, an already-captured `finish` is recovered from the transcript instead of re-prompting the agent.

## Inspector

`hyperchart_view` registers the run with a localhost inspector server (it lives inside the long-running MCP server process) and returns a tokenized URL: chart graph with runtime overlay, per-state details, live agent transcripts, and a steering composer.

Remote setups are configured through environment variables — set them in the `env` block of Claude Code's `settings.json` so the MCP server and runners inherit them:

- `HYPERCHART_INSPECTOR_PORT` — fixed port, so an `ssh -L <port>:127.0.0.1:<port>` tunnel can be configured once. Under SSH the server does not attempt to open a remote browser; open the returned URL locally through the tunnel.
- `HYPERCHART_INSPECTOR_HOST=0.0.0.0` — bind all interfaces and advertise the machine's LAN address in inspector URLs, so links open directly from another device. The unguessable per-run URL token is the only access control in this mode (including steering); use it on trusted networks only and prefer the SSH tunnel otherwise.

## Safety

- Chart modules are executable TypeScript; loading one can execute top-level code.
- Agent sessions can act anywhere the runner's process can inside the working directory — start runs only in directories you trust, and put substantial results into declared artifacts with schemas so invalid output is caught and retried at the runtime boundary.
- Stop and deletion do not undo external side effects. See [Recovery and safety](safety.md).

## Not yet included

Rewind tooling from the Claude host, marketplace packaging, model-id mapping between hosts, and cross-host run interop (Pi and Claude use separate run roots).
