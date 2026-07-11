# Examples

Examples are executable chart modules and are typechecked by the repository test suite.

## Minimal review workflow

[`examples/api/review.chart.ts`](../examples/api/review.chart.ts) demonstrates:

- scoped package imports;
- typed `refs()` registries;
- agent reply schemas;
- a user-action branch;
- explicit success/failure transitions.

Inspect it in Pi:

```text
hyperchart_inspect({ chartPath: "examples/api/review.chart.ts" })
```

Or copy it to `.pi/hypercharts/review.chart.ts` and run by basename.

## Deck Director workflow

[`examples/deck-director.chart.ts`](../examples/deck-director.chart.ts) demonstrates a production-shaped workflow with:

- run arguments and typed refs;
- agent definitions and model/tool overrides;
- compound, parallel, and map composition;
- bounded concurrency;
- declared artifacts and mapped fan-in;
- script actions and guards;
- validation feedback/retries;
- deadlines and failure paths.

Run with explicit arguments:

```text
/hyperchart run examples/deck-director.chart.ts --args '{"topic":"Durable agent workflows","audience":"engineers","goal":"explain the architecture","style":"analytical","constraints":"cite evidence"}'
```

## Project-local review/fix cycle

[`.pi/hypercharts/code-review-fix-cycle.chart.ts`](../.pi/hypercharts/code-review-fix-cycle.chart.ts) is a project chart that coordinates the repository's reviewer/fixer agent definitions. It is useful as an example of chart discovery and a feedback cycle, but its agents are project-specific.

## Adapting an example

1. Copy the chart under a new stable chart ID.
2. Replace agent names with definitions available in your Pi installation.
3. Keep state IDs stable after a durable run exists.
4. Update `refs()` registries when reply/artifact/map/input contracts change.
5. Inspect the chart and resolve every diagnostic.
6. Run with a small deterministic input first.
7. Add a focused test when the example becomes production workflow code.

Examples are documentation, not compatibility shims. They always use the current scoped package names and supported authoring surface.
