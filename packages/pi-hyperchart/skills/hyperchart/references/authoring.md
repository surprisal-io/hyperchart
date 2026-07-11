# Authoring route

Start with the canonical [core authoring guide](https://github.com/surprisal-io/hyperchart/blob/main/docs/core-authoring.md), then [composition and reliability](https://github.com/surprisal-io/hyperchart/blob/main/docs/composition.md).

Checklist: `.pi/hypercharts/*.chart.ts`; scoped `@surprisal-io/hyperchart` imports; stable chart/state/map keys; typed args/results; explicit `FAILED` paths; artifact declarations at producers; bounded retries/deadlines. Run `hyperchart_inspect` before `hyperchart_run`.
