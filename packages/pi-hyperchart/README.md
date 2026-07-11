# `@surprisal-io/pi-hyperchart`

Pi extension, tools, TUI and React inspector for [`@surprisal-io/hyperchart`](https://www.npmjs.com/package/@surprisal-io/hyperchart). Experimental 0.1.0, MIT, ESM, Node >=22.19.

```sh
pi install npm:@surprisal-io/pi-hyperchart
```

Put a chart in `.pi/hypercharts/review.chart.ts`, then:

```text
/hyperchart run review --args '{"topic":"durable agents"}'
```

Tools: `hyperchart_run`, `hyperchart_inspect`, `hyperchart_run_inspect`, `hyperchart_rewind`. **Rewind and `--ignore-replay-warnings` are dangerous recovery operations; inspect and back up first.**

React hosts import `@surprisal-io/pi-hyperchart/react` and `@surprisal-io/pi-hyperchart/react/styles.css`. See the [Pi guide](https://github.com/surprisal-io/hyperchart/blob/main/docs/pi.md) and [integration guide](https://github.com/surprisal-io/hyperchart/blob/main/docs/integration.md).
