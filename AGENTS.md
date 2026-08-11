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

## Adding a new chart element means adding the whole vertical slice

Do not stop when a new CST/AST node executes. A new state, actor, messaging,
or control-flow element is complete only after auditing every layer below.
Start by grepping for every use and exhaustive switch of the closest sibling
construct; missing UI switch cases can silently fall through to `agent`.

1. **Language and normalization** — public DSL builders and exports, CST/AST
   types, schema/input rules, target and usage validation, normalization,
   source rendering, state paths/templates, and inspect-AST metadata.
2. **Durable execution** — machine admission/transition rules, execution loop,
   projection, durable event definitions, replay legality/staleness checks,
   rewind/re-entry behavior, reservations/acknowledgements, and failure paths.
3. **Host projections** — host models and adapters for both definition-only and
   runtime views. Preserve the concrete kind (for example `sendBatch`, not
   `send`) instead of collapsing it merely because presentation is similar.
4. **Inspector and TUI presentation** — state-kind labels/icons/colors,
   mechanism summaries, State Details and runtime sections, graph-node
   detection/previews, graph-input edge kinds/labels, graph layout/routing and
   edge styling, selection/scope filtering, mailbox/history cards, status
   badges, and every equivalent TUI formatter.
5. **Storybook coverage** — add a focused State Details case, a visually
   distinct Graph Card Atlas entry, an Edge Types example when connectivity is
   new, and relevant dialog/history/empty/busy/failure/re-entry examples.
   Stories must follow the production pipeline: normalized chart → durable log
   captured from the real execution loop → `explainReplay()` → host adapter →
   production React component. Definition-only stories may use the inspect
   adapter. Never hand-author React semantic view models or claim that manually
   assembled replay-valid records are executed fixture logs.
6. **Documentation and models** — canonical API/runtime/integration docs,
   examples and package/skill references as applicable, plus TLA+ and trace
   export/validation whenever semantics changed.
7. **Tests and verification** — DSL/normalize/source tests; execution,
   projection, replay, rewind and ordering tests; host-adapter tests; React
   detail/graph tests; Storybook structural tests that assert the new kind is
   present on both boards; TUI tests; `npm run typecheck`, focused tests,
   `npm run check`, `npm run build-storybook`, applicable TLA models, trace
   validation, and `git diff --check`.

When a construct has singleton and batch variants, cover both independently in
all type unions, switch statements, details boards, graph cards, and edge
labels. Shared styling is fine; erasing semantic identity is not.

## Documentation is part of the change

Public API or behavior, package/export/dependency, Pi command/tool/lifecycle,
host adapter, React/UI/theme, and example changes are incomplete without their
corresponding documentation. Update the relevant canonical page under `docs/`,
the affected npm package README, bundled skill routing/reference pages when an
agent workflow changes, and Storybook/README visual assets when users can see
the change. Do not duplicate the full manual into package READMEs or the skill;
keep those focused and link to canonical docs.

Canonical documentation lives only under `docs/`; canonical agent skills live at
`skills/pi/SKILL.md` and `skills/claude/SKILL.md`. Documentation, examples,
assets, and skills are staged transiently into package directories by
`prepack` and removed by `postpack`; generated package mirrors must never be
committed. `npm run validate:packages` verifies the published tarball contents.

After changing runtime behavior, tool surfaces, or documentation, offer the
user a run of the `docs-engine` chart (`.hypercharts/docs-engine`, a
host-neutral shared chart visible to both Pi and Claude Code). Suggest it —
do not start it yourself. `args: {mode: "audit"}` audits every canonical unit
against the code and writes `artifacts/docs-engine/drift-report.json` without
touching files; `{mode: "fix"}` additionally patches the canonical units from
confirmed findings and re-syncs the packages.

The change-to-document map and release checklist live in
[`docs/development.md`](docs/development.md). Tests must accompany behavioral
changes; UI changes require an appropriate Storybook story and refreshed visual
when the landing-page representation is affected.
