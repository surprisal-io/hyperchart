# Hosting API

`@surprisal/hyperchart/inspect` and `@surprisal/hyperchart/sessions` are the host-neutral surfaces a Hyperchart host builds on: run inspection, the localhost browser inspector, and the on-disk session protocols (progress, steering, run status). Both the Pi extension and the Claude Code plugin are implemented on top of them.

## `@surprisal/hyperchart/inspect`

| Export | Purpose |
|---|---|
| `hyperchartRunFromRunDir(runDir, options?)` | Build a `HyperchartRunInfo` from a run directory: meta, parsed chart, durable log, status, session progress, and transcripts. `options.readTranscript` plugs in a host transcript format; `options.agentDefaults` supplies declared agent metadata. When valid `runner.config.json` exists, its persisted role/model and toolset/tool mappings override mutable current settings for `resolvedModel`/`resolvedTools`; an invalid snapshot leaves those resolved fields absent rather than silently using current settings. |
| `readNeutralSessionTranscript(sessionsDir, sessionFile)` | Default transcript reader: header-tagged JSONL of pre-flattened `HyperchartSessionMessageInfo` records. |
| `resolveContainedSessionFile(sessionsDir, sessionFile)` | Realpath containment guard shared by transcript readers. |
| `combineToolLifecycle(messages)` / `truncateTranscriptText(value)` | Shared transcript shaping: fold tool call + result into one lifecycle entry; cap displayed text. |
| `openRunInspector({ runId, loadRun, steerSession?, openBrowser? })` | Register a run with the process-wide localhost inspector and return its tokenized URL. `HYPERCHART_INSPECTOR_PORT` pins the port (falling back to an ephemeral port when it is already taken by another process); `HYPERCHART_INSPECTOR_HOST` sets the bind host (default loopback; `0.0.0.0` advertises the machine's LAN address in URLs). Under SSH no server-side browser is opened. |
| `closeRunInspectorServer()` | Test/shutdown hook for the inspector singleton. |
| Types | `HyperchartRunFromRunDirOptions`, `SessionTranscriptReader`, `NeutralTranscriptHeader`, `RunInspectorSource`, `OpenRunInspectorOptions`, `MAX_TRANSCRIPT_MESSAGES`, `MAX_TRANSCRIPT_TEXT_LENGTH`. |

## `@surprisal/hyperchart/sessions`

| Export | Purpose |
|---|---|
| `readSessionProgress(sessionsDir)` / `updateSessionProgress(sessionsDir, actionUid, patch)` | The `sessions/progress.json` protocol: per-action status, model, turn/tool/token counts, current activity, streamed text. |
| `createThrottledProgressWriter(sessionsDir, actionUid, actionName)` | Buffers streaming text/thinking deltas and writes them at most every 250ms. |
| `queueSessionSteering(sessionsDir, actionKey, message)` / `watchSessionSteering(sessionsDir, deliver)` | The `sessions/steering/` file queue: hosts enqueue, the runner drains into the live executor session. |
| `readRunStatus` / `patchRunStatus` / `writeRunStatus` / `markRunHeartbeat` | The `status.json` protocol with atomic writes and heartbeats. |
| `isRunLive` / `isTerminalRunState` / `isPidAlive` | Liveness checks used by hosts to attach, stop, or fail runs. |
| `actionUidKey` / `sessionProgressPath` / `runStatusPath` | Key and path helpers. |
| Types | `HyperchartSessionProgress`, `HyperchartSessionProgressFile`, `HyperchartSessionStatus`, `SessionSteeringRequest`, `HyperchartRunStatus`, `HyperchartRunState`, `StreamingProgressWriter`. |

Executor-building blocks (`AgentExecutor`, the finish protocol, prompt builders, `runAcceptanceLoop`, `GenerationTracker`, `runHyperchartRunner`, agent-definition loading, `createHostPaths`) are exported from [`@surprisal/hyperchart/runtime`](runtime.md).
