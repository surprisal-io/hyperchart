# Architecture, execution semantics, and formal model

![Diagram showing the core chart machine and durable log connected to Pi tools and inspector](../assets/readme/architecture.svg)

## Two-package boundary

### `@surprisal-io/hyperchart`

Host-neutral:

- chart CST/AST types and authoring DSL;
- normalization and module parsing;
- generated definition source and static inspection;
- pure machine, projection, replay explanation, and execution loop;
- generic log/script/artifact/guard/runtime components;
- canonical host/inspector models.

It has no Pi or React dependency.

### `@surprisal-io/pi-hyperchart`

Pi integration:

- package command event API;
- Pi chart/agent/run discovery;
- detached runner and Pi agent executor;
- run status/session progress;
- `/hyperchart` and four agent tools;
- TUI views/widgets;
- React inspector, launch/run components, and styles;
- bundled Hyperchart skill.

It depends on the exact matching core version. This prevents two copies of chart semantics from drifting.

## Definition pipeline

```text
TypeScript chart module
        │
        ▼
authoring CST + Zod values
        │ normalizeChartConfig
        ▼
frozen serializable AST + diagnostics
        │
        ├── static source/contracts/topology inspection
        └── machine/projection execution
```

CST is optimized for TypeScript authoring. AST is flattened and data-first. Zod values are converted to JSON Schema. Paths, transitions, refs, inputs, artifact sources, and structural completion rules are validated during normalization.

## Execution micro-steps

At a high level:

1. load AST and ordered facts;
2. project the current branch, visits, results, map spawns, and pending actions;
3. derive machine output;
4. request durable append and runtime effects;
5. persist requested records;
6. dispatch agent/script/user/timer/validation/cancel work;
7. feed acknowledgements/completions back as machine events;
8. repeat until the root reaches final or the runtime stops.

The engine does not call Pi directly. It asks a `Runtime` to execute effects.

## Why transitions are recomputed

The log stores external and accepted workflow facts, not a mutable state snapshot. Completion records contain events; the current chart determines their targets. This permits limited compatible chart evolution, while invocation and guard provenance lets `explainReplay()` detect definitions that no longer mean the same thing.

Silently storing/restoring an old current-state snapshot would hide these changes and could resume in an impossible branch.

## Hierarchy and fan-out

Nested authoring states are flattened to absolute template paths for O(1) lookup. Projection retains parent/scope relationships.

- compound states enter one initial child and complete through one direct final child;
- parallel states enter all regions and join after every region completes;
- maps persist a spawn set, materialize keyed paths, gate invocation concurrency, and join after every instance completes.

Runtime map paths include keys (`map#key.child`); template paths omit them (`map.child`). A visit is distinct from a state path: re-entry can create multiple visits of the same node.

## Control and data

Control moves through events/transitions. Data moves through explicit channels:

- run arguments;
- accepted reply payloads;
- transition inputs;
- map key/item facts;
- declared artifacts;
- visit identity.

Templates resolve these channels immediately before dispatch. This avoids making prompt strings or ambient files the workflow database.

## Runtime and storage ownership

The generic runtime owns effect interpretation mechanics but receives a host agent executor. Pi adds:

- actual Pi agent sessions and finish tool;
- runner process/heartbeat/status;
- Pi agent definitions/defaults;
- project/user chart locations;
- session progress and TUI.

`log.jsonl` defines semantic history. `status.json` and session progress are operational overlays. React/UI consume canonical models produced by adapters; they do not replay raw facts independently.

## Static versus runtime inspection

Static inspection includes source definition, topology, contracts, schemas, transitions, and source/agent-definition issues. It is repeatable without a run.

Runtime inspection overlays status, visits, resolved invocations, map generations, usage, session failures, validation attempts, artifacts, and replay issues. Keeping this boundary prevents operational state from contaminating the chart definition.

## TLA+ model

`tla/Hyperchart.tla` independently articulates core semantics and fairness. It is not generated from TypeScript and should not be edited merely to make an implementation test pass. A divergence is a correctness finding to investigate.

Model-check scenarios cover review/fix, linear pipeline, validation gate, fan-out, map, and nested behavior:

```sh
for M in MCReviewFix MCPipeline MCGate MCFanout MCMap MCNested; do
  tla/check.sh "$M"
done
```

Read the spec header before changing machine/projection/normalization semantics; it documents fairness, micro-steps, and intentionally unmodeled host behavior.

## Real trace validation

`tla/HyperchartTrace.tla` validates a JSONL trace recorded from the TypeScript engine:

```sh
node tla/trace/record-sample.mjs
tla/trace/validate.sh sample_chart.ts sample-run.jsonl
```

`TRACE ACCEPTED` means that sampled engine behavior is admitted by the spec. `DIVERGENCE` means implementation/export/model disagree; identify which articulation is wrong.

A semantic change is complete only when:

1. TypeScript machine/projection/normalization agree;
2. durable log/replay detection handles old records explicitly;
3. TLA+ models pass;
4. the recorded real trace is accepted;
5. user docs describe the resulting behavior.

A package move or documentation-only change must not alter these semantics or edit the TLA+ model.
