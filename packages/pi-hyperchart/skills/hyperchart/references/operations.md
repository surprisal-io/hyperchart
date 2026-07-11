# Operations route

See the canonical [Pi guide](https://github.com/surprisal-io/hyperchart/blob/main/docs/pi.md).

- Static shape/diagnostics: `hyperchart_inspect`.
- Start or resume: `hyperchart_run` (`chartPath` for new work, `runDir` for existing work).
- Runtime state: `hyperchart_run_inspect`.
- Recovery only: `hyperchart_rewind`.

Runs are under the Pi agent directory in `hypercharts/runs/`; project definitions are discovered from `.pi/hypercharts/`. Prefer inspecting runtime state over reading private status/log files.
