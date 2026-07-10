# Agent notes

## Changing execution semantics? Update the log contract and the model.

The execution semantics live in three places that MUST stay in sync. A change
to how the machine behaves (machine.ts, projection.ts, execution_loop.ts, or
the semantic rules in normalize.ts) is not done until all three agree:

1. **The durable log contract** (durable_events.ts, replay_check.ts).
   The log is the source of truth for replay: facts only, transitions are
   recomputed from the chart. If the change alters which facts are written or
   how they project, old logs must either replay identically or be *detected*
   as stale/broken by explainReplay — never silently reinterpreted. Extend
   replay_check tests when the contract moves.

2. **The TLA+ model** (tla/Hyperchart.tla).
   The spec is an independent second articulation of the semantics — a
   divergence from machine.ts is a finding, not a spec bug. Mirror the change
   in the spec (and in MC* models/cfgs if constants change), then re-check
   every model:

   ```bash
   for M in MCReviewFix MCPipeline MCGate MCFanout MCMap MCNested; do tla/check.sh $M; done
   ```

3. **Trace validation** (tla/HyperchartTrace.tla, tla/trace/).
   Re-record the sample run against the real machine and check the log is
   still a behavior of the spec:

   ```bash
   node tla/trace/record-sample.mjs
   tla/trace/validate.sh sample_chart.ts sample-run.jsonl
   ```

   "TRACE ACCEPTED" means engine and spec agree on a real run; DIVERGENCE
   means one of them is wrong — find out which before merging. If the change
   adds a new fact kind or construct, extend record-sample/export-trace so
   the sample run exercises it.

Key spec decisions (fairness doctrine, micro-steps, what is deliberately not
modeled) are documented in the header of tla/Hyperchart.tla — read it before
editing either side.
