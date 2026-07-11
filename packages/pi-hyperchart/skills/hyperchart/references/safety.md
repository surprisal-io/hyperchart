# Replay and rewind safety

Read [durability](https://github.com/surprisal-io/hyperchart/blob/main/docs/runtime-and-durability.md) before intervention.

`--ignore-replay-warnings` can continue stale/skipped history under a changed chart. It is not a repair. Prefer a new run unless every affected record is audited.

`hyperchart_rewind` truncates a stopped run after making a backup. Require exactly one reviewed target (`state`, `seqId`, or `to: "compatible"`). External side effects after that point are not undone and may repeat after resume. Never rewind a running process or delete the backup until the replacement history is verified.
