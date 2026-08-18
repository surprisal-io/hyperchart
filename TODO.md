# TODO

## Aggregate terminal semantics as host policy

The multi-branch runner currently aggregates branch outcomes into the run
status: one failed branch marks the whole run `failed` (exitCode 1) once every
branch finishes. That is CI-workflow semantics. For a long-lived research
universe (AutoDiscovery), a failed experiment branch is data, not a process
status: refuted hypotheses should be chart final states, and even genuine
experiment failures (tool crash, context exhaustion) must not mark the
universe run as failed.

Future change: make terminal aggregation a host policy. For research hosts,
the run status reflects "runner alive / stopped"; per-branch outcomes remain
per-branch facts. Default policy keeps today's aggregate behavior for
workflow-style hosts.

## Live rewind

`rewindHyperchartRun` requires a stopped run (`assertStoppedRun`). In a
perpetually live universe process, the human verdict "conclusion is wrong —
cut and rebuild" (a rewind of one branch) currently needs stop-the-world for
the whole runner. Acceptable for v1 (verdicts are rare); later consider a
controller-level rewind that quiesces only the affected branch.
