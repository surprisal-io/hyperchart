# `@surprisal-io/hyperchart`

Host-neutral TypeScript statecharts for durable agent and script workflows. Experimental 0.1.0, MIT, ESM, Node >=22.19.

```sh
npm install @surprisal-io/hyperchart
```

```ts
import { agent, final, refs, z } from "@surprisal-io/hyperchart";

const Reply = z.object({ ok: z.boolean() });
type Reply = z.infer<typeof Reply>;

const { chart } = refs<Record<string, never>, { work: Reply }>();

export default chart({
  kind: "chart",
  id: "hello",
  initial: "work",
  states: {
    work: {
      kind: "state",
      action: agent("worker", { task: "Do the work", reply: Reply }),
      transitions: { DONE: "done", FAILED: "failed" },
    },
    done: final(),
    failed: final(),
  },
});
```

Public entry points:

- `.` — authoring, parsing/inspection, machine, projection, replay, and execution loop;
- `./host` — canonical host/inspector models and adapters;
- `./runtime` — runtime contract and generic runtime components.

See the [complete documentation](https://github.com/surprisal-io/hyperchart/tree/main/docs), [core authoring guide](https://github.com/surprisal-io/hyperchart/blob/main/docs/core-authoring.md), and [examples](https://github.com/surprisal-io/hyperchart/tree/main/examples).
