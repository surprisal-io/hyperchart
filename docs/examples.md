# Examples

Each example has different prerequisites. Start with the script-only chart; the larger files are reference implementations to adapt, not zero-configuration demos.

| Example | Runs as checked in? | Requires | Demonstrates |
|---|---:|---|---|
| [`examples/quickstart.chart.ts`](../examples/quickstart.chart.ts) | yes | Node.js, Pi package | script action, implicit successful event, declared artifact, final state |
| [`examples/api/review.chart.ts`](../examples/api/review.chart.ts) | no | project agent definitions; Pi user-action support for the approval state | typed refs, agent replies, transition input, validation/review loop |
| [`examples/deck-director.chart.ts`](../examples/deck-director.chart.ts) | no | named Deck Director agents, scripts under `bin/`, project schemas/artifact conventions | launch argument metadata, large map/parallel pipeline, fan-in, validation, deadlines, artifacts |

## Portable smoke test

Copy the quickstart chart into project discovery:

```sh
mkdir -p .pi/hypercharts
cp examples/quickstart.chart.ts .pi/hypercharts/hello.chart.ts
```

Run it:

```text
/hyperchart run hello
```

Expected result:

- terminal run status `complete`;
- `hello.txt` created in the project;
- one run directory under `~/.pi/agent/hypercharts/runs/` (or `$PI_CODING_AGENT_DIR/hypercharts/runs/` if set);
- an `args` record followed by action invocation/completion facts in `log.jsonl`.

Read [Run your first chart](quickstart.md) for inspection and troubleshooting.

## Review chart

[`examples/api/review.chart.ts`](../examples/api/review.chart.ts) is a compact API example. It shows:

- typed `Args`, `Results`, and transition inputs;
- a user action for structured approval/review;
- routing through named events;
- passing accepted data into another state;
- looping from fix back to review.

Before using it, define every named agent in your Pi configuration. The file also reaches a durable `user()` gate: Pi presents the request to the originating session, treats the user's next ordinary prompt as the answer, and resumes the selected transition after the explicit response is committed.

Use this file to study authoring and the interactive gate flow, not as the first non-interactive installation test.

## Deck Director chart

[`examples/deck-director.chart.ts`](../examples/deck-director.chart.ts) is a large reference chart extracted from a project-specific workflow. It demonstrates:

- serializable launch argument descriptions and defaults for its typed `Args`;
- planning followed by data-driven research fan-out;
- pinned map items and bounded `concurrency`;
- `joinArtifactOf()` fan-in;
- agent and script validators;
- `onReject` and retry budgets;
- deadlines and failure routes;
- nested map/compound structure;
- artifact contracts across a long run.

It refers to agent names, scripts, and project files that are not supplied by this package. To adapt it:

1. list every `agent("...")` name and create concrete Pi definitions;
2. replace each `bin/...` command with a checked-in executable;
3. review every artifact path and schema;
4. make external operations idempotent;
5. keep explicit failure and deadline routes;
6. inspect the normalized chart before starting a run;
7. test with disposable inputs before using real external systems.

## Add an example

A checked-in example should state:

- whether it runs without repository-specific resources;
- required agents, scripts, credentials, and external services;
- expected files and terminal outcome;
- the one behavior it is intended to teach;
- safety implications for external effects and replay.

Examples are typechecked and covered by `tests/examples.test.ts`. If an example is intentionally non-runnable, its missing prerequisites must be explicit here and near the source file.

## Explicit actor pool

[`examples/explicit-actors.chart.ts`](../examples/explicit-actors.chart.ts) is the checked bounded-worker example. A map-owned pool uses `callBatch` with a batch larger than concurrency; workers execute concurrently while the caller receives one input-ordered output array. The same guide also documents singleton actors and named replies: [Explicit actors](explicit-actors.md).
