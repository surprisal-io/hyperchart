# DSL reference

Import authoring values from `@surprisal/hyperchart`:

```ts
import {
  agent,
  artifact,
  chart,
  compound,
  event,
  failed,
  final,
  input,
  json,
  map,
  parallel,
  refs,
  resume,
  script,
  t,
  tsImport,
  user,
  visit,
  z,
} from "@surprisal/hyperchart";
```

Use `refs()` for arguments, results, artifacts, map items, and transition inputs. Its selectors are type-checked; the untyped root entry point intentionally does not export `arg()`, `result()`, `artifactOf()`, `joinArtifactOf()`, `key()`, or `item()`.

## Minimal chart

```ts
import { artifact, chart, failed, final, script } from "@surprisal/hyperchart";

export default chart({
  kind: "chart",
  id: "hello",
  initial: "write",
  states: {
    write: {
      kind: "state",
      action: script("node", ["-e", "require('node:fs').writeFileSync('hello.txt', 'hello\\n')"], {
        artifacts: { greeting: artifact("hello.txt") },
      }),
      transitions: { DONE: "done", FAILED: "failed" },
    },
    done: final(),
    failed: failed(),
  },
});
```

`chart()` is an identity helper. Validation happens when the module is normalized, inspected, or run.

## Chart

### `chart()`

```ts
function chart(input: ChartCst): ChartCst;
```

Returns the same chart object. It adds no runtime behavior; use it when you do not need typed registries. `createChart` exists internally but is not exported from the package root.

The `chart()` returned by `refs()` has the same runtime behavior and additionally checks registry consistency at compile time.

```ts
type ChartCst = {
  kind: "chart";
  id: string;
  initial: string;
  states: Record<string, StateCst>;
};
```

| Field | Required | Meaning |
|---|---:|---|
| `kind` | yes | Must be `"chart"`. |
| `id` | yes | Non-empty durable chart identifier. |
| `initial` | yes | Local id of the first top-level state. |
| `states` | yes | Top-level state table. |

State ids use letters, digits, `_`, and `-`. `.`, `#`, and `:` are reserved for paths, map instances, and effect identities.

### `final()` and `failed()`

```ts
function final(options?: TerminalOptions): FinalStateCst;
function failed(options?: TerminalOptions): FinalStateCst;

type TerminalOptions = {
  notify?: {
    prompt?: Templatable;
    artifacts?: readonly (ArtifactOfCst | JoinArtifactOfCst)[];
    scope?: StatePath;
  };
};

type FinalStateCst = {
  kind: "final";
  outcome?: "complete" | "failed";
  notify?: TerminalOptions["notify"];
};
```

Both constructors mark terminal leaves. `final()` records a `complete` run outcome; `failed()` records `failed`. State names and incoming event names never infer failure. Raw `{ kind: "final" }` remains valid and normalizes to `complete`.

A top-level terminal ends the chart. A direct terminal child completes a compound or map instance; a terminal inside a parallel region marks that region complete. The final machine outcome considers all active terminal leaves, including completed parallel regions: if any active leaf is failed, the run fails.

`notify.prompt` is appended to the host's standard terminal message. `notify.artifacts` accepts only declared `artifactOf()`/`joinArtifactOf()` references and surfaces authoritative absolute paths; contents are not inlined. `notify.scope` selects the existing action/map scope used to resolve `input()`, `key()`, and `item()` references and defaults to the terminal path. It does not add inputs to final-state projection. Result and artifact reads must dominate the reached terminal, exactly like action reads.

## `refs()`

```ts
const {
  chart,
  arg,
  event,
  visit,
  input,
  result,
  artifactOf,
  joinArtifactOf,
  key,
  item,
} = refs<Args, Results, Files, Maps, Inputs>();
```

```ts
function refs<
  Args extends Record<string, unknown>,
  Results extends Record<string, unknown>,
  Files extends Record<string, Record<string, unknown>> = Record<never, Record<string, unknown>>,
  Maps extends Record<string, unknown> = Record<never, unknown>,
  Inputs extends Record<string, Record<string, unknown>> = Record<never, Record<string, unknown>>,
>(): Refs<Args, Results, Files, Maps, Inputs>;
```

The registries are compile-time contracts:

| Registry | Keys | Values |
|---|---|---|
| `Args` | run argument names | argument values |
| `Results` | absolute action-state paths | accepted completion output |
| `Files` | artifact-producing action-state paths | artifact name → parsed file content |
| `Maps` | absolute map-state paths | one spawned item |
| `Inputs` | input-declaring state paths | input name → input value |

The returned `chart()` checks that declared `reply`, artifact shapes, maps, and inputs agree with those registries in both directions.

```ts
const Plan = z.object({ sections: z.array(z.string()) });
const Review = z.object({ feedback: z.string() });
const ReportFile = z.object({ title: z.string(), body: z.string() });

type Args = { topic: string };
type Results = {
  plan: z.infer<typeof Plan>;
  review: z.infer<typeof Review>;
};
type Files = {
  write: { report: z.infer<typeof ReportFile> };
};
type Maps = Record<never, never>;
type Inputs = {
  revise: { feedback: string };
};

const refsForChart = refs<Args, Results, Files, Maps, Inputs>();
```

### Typed selectors

#### `arg(name)`

```ts
arg<K extends keyof Args & string>(name: K): InputRef<Args[K]>;
```

Reads a value from the run's durable `args` fact.

```ts
t`Write about ${arg("topic")}`
```

#### `result(state, path?)`

```ts
result<S extends keyof Results & string>(state: S): InputRef<Results[S]>;
result<S, P extends Paths<Results[S]>>(state: S, path: P): InputRef<ValueAt<Results[S], P>>;
```

Reads the latest accepted output of an action state. `state` is an absolute template path. `path` is a dot-path into the output.

```ts
t`Sections: ${json(result("plan", "sections"))}`
```

A result producer must dominate its consumer. For a loop or back-edge, pass visit-local data through transition inputs instead.

#### `input(name, path?)`

```ts
input(name): InputRef<InputValue>;
input(name, path): InputRef<SelectedValue>;
```

Reads the nearest enclosing declaration of a transition input. The name must exist in `Inputs`; the optional dot-path is type-checked.

```ts
input: { feedback: z.string() },
action: agent("writer", { task: t`Apply: ${input("feedback")}` }),
```

The package root also exports an untyped `input(name, path?)` constructor.

#### `event(path?)`

```ts
event(path?: string): EventBindingCst;
```

Binds a target input to the completion event's `output`, or to a dot-path inside `output`.

```ts
transitions: {
  BLOCK: {
    target: "revise",
    input: { feedback: event("feedback") },
  },
}
```

`event()` binds the whole `output` value, not the `{ type, output }` envelope.

#### `visit(state?)`

```ts
visit(state?: string): InputRef<number>;
```

Reads the 1-based visit number of the current action state or another action state. The root entry point also exports this untyped constructor.

```ts
t`Revision attempt ${visit()}`
```

#### `artifactOf(state, options?)`

```ts
artifactOf(state, { artifact?, select? }): ArtifactOfCst;
```

Reads a producer's declared artifact. Omit `artifact` only when the producer declares exactly one. `select` is a dot-path into parsed artifact content and requires a declared shape.

```ts
reads: [artifactOf("write", { artifact: "report" })]
```

For an agent action, the runtime provides the selected file/read. For a script environment variable, an unselected artifact resolves to its path; a selected artifact resolves to the serialized selected value.

#### `joinArtifactOf(state, options?)`

```ts
joinArtifactOf(state, { artifact? }): JoinArtifactOfCst;
```

Collects one artifact from every spawned instance of the map enclosing `state`. Agent `reads` receive all files. Script `env` receives a JSON array of paths.

```ts
env: { CHAPTER_FILES: joinArtifactOf("chapters.write", { artifact: "chapter" }) }
```

#### `key(map)` and `item(map, path?)`

```ts
key<M extends keyof Maps & string>(map: M): InputRef<string>;
item<M extends keyof Maps & string>(map: M): InputRef<Maps[M]>;
item<M, P extends Paths<Maps[M]>>(map: M, path: P): InputRef<ValueAt<Maps[M], P>>;
```

Read the key and spawn-pinned item of the current instance of the named map.

```ts
t`Process ${key("chapters")}: ${item("chapters", "title")}`
```

### Exported type utilities

```ts
type Paths<T> = /* valid object dot-paths */;
type ValueAt<T, P extends string> = /* value selected by P */;
type InputsOf<C> = /* input registry inferred from chart type C */;
```

Array indexes are not part of `Paths<T>`. Select the array as a value and use `json()` when embedding it.

## Templates

### `` t`...` ``

```ts
function t(
  strings: TemplateStringsArray,
  ...values: (InputRef<string | number | boolean> | string | number | boolean)[]
): TemplateCst;
```

Templates are plain data. Static primitives are folded into the string. Refs are resolved immediately before an action is dispatched.

```ts
t`Prepare these sections for ${arg("topic")}: ${json(result("plan", "sections"))}`
```

A ref resolving to an object or array must be wrapped in `json()`.

### `json(ref)`

```ts
function json<V>(ref: InputRef<V>): InputRef<string>;
```

Marks a value for JSON serialization inside a template.

```ts
t`Plan JSON: ${json(result("plan"))}`
```

Without `json()`, a non-primitive value is a type error with typed refs and a runtime error if it reaches rendering.

### `Templatable`

```ts
type Templatable = string | TemplateCst;
```

Every `Templatable` field accepts either a plain string or `t` template.

## Action states

```ts
type ActionStateCst = {
  kind: "state";
  action: AgentActionCst | ScriptActionCst | UserActionCst;
  input?: Record<string, z.ZodType>;
  transitions?: TransitionMapCst;
  after?: { delayMs: number; target: string };
  validate?: GuardRef;
  onReject?: "resume" | "restart";
  onReenter?: "restart" | ReturnType<typeof resume>;
  retries?: number;
};
```

| Field | Meaning |
|---|---|
| `action` | Work dispatched on entry. |
| `input` | Zod schemas for visit-local transition inputs. |
| `transitions` | Completion-event routes. |
| `after` | Deadline while the action is running. The target is a sibling. |
| `validate` | Acceptance guard for non-`FAILED` completion claims. |
| `onReject` | Continue the current action session or start the action again after rejection. Default: `"resume"`. |
| `onReenter` | Policy for a later visit. `resume()` is meaningful only where the runtime can identify and reuse an agent session. |
| `retries` | Number of rejected rounds allowed. The next rejection emits `FAILED`. Omitted means unbounded. Requires `validate` and a reachable `FAILED` route. |

### `agent(name, options?)`

```ts
function agent(name: string, options?: {
  task?: Templatable;
  artifacts?: Record<string, Templatable | ArtifactCst>;
  reads?: readonly (Templatable | ArtifactOfCst | JoinArtifactOfCst)[];
  model?: string;
  thinking?: string;
  tools?: readonly string[];
  reply?: z.ZodType;
}): AgentActionCst;
```

`name` must resolve to a concrete agent definition in the host. Missing definitions are execution errors.

```ts
const Plan = z.object({ sections: z.array(z.string()) });

action: agent("planner", {
  task: t`Plan a report about ${arg("topic")}`,
  reply: Plan,
}),
transitions: { PLANNED: "write", FAILED: "failed" },
```

`reply` validates the completion event's `output`; it is for small routing data. Put large deliverables in artifacts.

### Exact runtime contracts

Use `contract(id, version, schema)` when a reply or artifact must execute the original Zod value at runtime:

```ts
const Reply = contract("planner-reply", "1", z.object({
  approved: z.boolean(),
}).superRefine(async (value, ctx) => {
  if (!value.approved) ctx.addIssue({ code: "custom", message: "approval required" });
}));
```

The helper returns the same Zod value, so `z.infer<typeof Reply>` remains available. Normalization stores only JSON Schema and `runtimeContract: { id, version }` in the serializable AST; the original schema is retained in a parsed chart's in-memory registry. Runtime paths use async exact validation and fail closed if that registry is not threaded into the runtime. Unmarked Zod schemas retain the JSON Schema fallback behavior.

State and map inputs are replay-derived synchronously, so exact runtime contracts are rejected there; use ordinary Zod input schemas. Runtime contracts validate the supplied value but do not replace it with Zod defaulted or transformed output.

### `script(command, args?, options?)`

```ts
function script(command: string, args?: readonly string[], options?: {
  env?: Record<string, Templatable | ArtifactOfCst | JoinArtifactOfCst>;
  artifacts?: Record<string, Templatable | ArtifactCst>;
  reply?: z.ZodType;
}): ScriptActionCst;
```

`command` and `args` are static. Dynamic values belong in `env`.

```ts
action: script("node", ["scripts/render.mjs"], {
  env: {
    TOPIC: t`${arg("topic")}`,
    PLAN: t`${json(result("plan"))}`,
  },
  artifacts: { report: artifact("out/report.json", ReportFile) },
  reply: z.object({ bytes: z.number().int().nonnegative() }),
}),
```

On success, a script should print a JSON completion envelope as its last non-empty stdout line:

```json
{"type":"DONE","output":{"bytes":1234}}
```

If exactly one non-`FAILED` event is reachable, exit code 0 may omit the envelope. With multiple possible events, the envelope is required. A non-zero exit becomes `FAILED`.

The same `script(command, args, { env, artifacts, reply })` value can be used as a validation guard. Guard scripts use the same env renderer and artifact/reply validation as script actions. Guard reply output is validation-only and is not stored as the action result; guard-produced artifacts become downstream-declarable artifacts of the containing state. Stdin remains the plain ChartEvent; no guard-only artifacts field or TypeScript context artifacts are injected. Missing or invalid reads reject closed.

### `user(options)`

```ts
function user(options: {
  prompt: Templatable;
  options?: readonly string[];
  reply?: z.ZodType;
}): UserActionCst;
```

Declares a durable host-mediated input gate. `prompt` is rendered when the action phase begins, and `options` supplies the choices shown by the host. Allowed response events still come from the action's reachable transitions; when options represent routing choices, use the transition event names as in the example below. `FAILED` is reserved and cannot be a user option or human response.

```ts
action: user({
  prompt: "Approve the report?",
  options: ["APPROVED", "BLOCK"],
  reply: z.object({ feedback: z.string().optional() }),
}),
transitions: {
  APPROVED: "publish",
  BLOCK: "revise",
  FAILED: "failed",
},
```

Each reached user phase receives a durable numeric `seqId`. The public coordinate is exactly `(runId, seqId)`; internal runtime callback ids are not part of the response contract. A host presents one owned gate at a time and commits an explicit envelope:

```json
{"runId":"review-20260723-120000","seqId":14,"event":"BLOCK","output":{"feedback":"Clarify the risks."}}
```

The event must be an allowed non-`FAILED` event, and `output` must satisfy `reply` when a schema is declared. An invalid claim is rejected without consuming the gate so the human can retry. An identical committed retry is idempotent; a different retry conflicts. Timeouts and cancellation still participate in normal machine ordering: whichever completion wins closes the phase, and later duplicate responses cannot resume it.

The detached runner remains alive while waiting, and only the branch containing the gate blocks. Other `parallel` regions and admitted `map` instances continue. Pi and Claude Code implement this protocol; a custom host can use the generic file-backed user executor and mailbox APIs.

## Transitions and inputs

```ts
type TransitionMapCst = Record<
  string,
  string | {
    target: string;
    input?: Record<string, EventBindingCst>;
  }
>;
```

Targets are sibling ids at the level where the transition is declared. Events bubble from the action leaf to its nearest ancestor handler. They are not broadcast between parallel regions.

```ts
review: {
  kind: "state",
  action: agent("reviewer", { reply: z.object({ feedback: z.string() }) }),
  transitions: {
    PASS: "done",
    BLOCK: {
      target: "revise",
      input: { feedback: event("feedback") },
    },
    FAILED: "failed",
  },
},
revise: {
  kind: "state",
  input: { feedback: z.string() },
  action: agent("writer", { task: t`Fix: ${input("feedback")}` }),
  transitions: { DONE: "review", FAILED: "failed" },
},
```

A required input must be bound by every incoming route that can enter the state. A Zod default supplies an unbound value:

```ts
input: { attempt: z.number().int().default(1) }
```

## Artifacts

### `artifact(path, shape?)`

```ts
function artifact(path: Templatable): ArtifactCst;
function artifact(path: Templatable, shape: z.ZodType): ArtifactCst;
```

Declares a named deliverable under an agent or script action.

```ts
artifacts: {
  report: artifact(t`out/${arg("topic")}.json`, ReportFile),
}
```

A shape means the file contains JSON matching the Zod schema. Without a shape, the runtime only requires a readable file. Artifact paths are resolved from the run working directory; the generic runtime rejects paths escaping that directory.

A validation guard returns only a verdict, but a script guard supports the complete script option surface: `env`, `artifacts`, and `reply`. Its `reply` validates the guard script's optional completion-envelope output and is not stored as the containing action's result. Guard artifacts are validated after exit and become declared artifacts of the containing action state for downstream `artifactOf()`/Files references; duplicate names with action artifacts are rejected. Env values use the same args/results/input/map-item/key/visit renderer as script actions. `artifactOf()` values without a selector become paths; selected values are read, shape-validated, and serialized exactly like script-action env. A guard may read the validated action's own artifact because that file exists before the verdict. `joinArtifactOf()` becomes a JSON array of rendered paths. Missing or invalid reads reject closed. Values are resolved only while validation is pending, never placed in stdin/context or durable facts.

## Compound states

```ts
function compound(options: {
  initial: string;
  states: Record<string, StateCst>;
  transitions?: TransitionMapCst;
  onDone?: string;
}): CompoundStateCst;
```

A compound has one active child. It must contain a direct final child. Outside a parallel region it must route completion through `onDone`.

```ts
pipeline: compound({
  initial: "work",
  states: {
    work: {
      kind: "state",
      action: script("node", ["scripts/work.mjs"]),
      transitions: { DONE: "finished" },
    },
    finished: final(),
  },
  transitions: { FAILED: "failed" },
  onDone: "publish",
}),
```

A transition declared on the compound catches events left unhandled by descendants.

## Parallel states

```ts
function parallel(options: {
  states: Record<string, CompoundStateCst>;
  transitions?: TransitionMapCst;
  onDone?: string;
}): ParallelStateCst;
```

Every child is a region entered concurrently. A region is authored with `compound()` but must not declare `onDone`; reaching its direct final child marks that region complete. The parallel exits through its own `onDone` after all regions complete.

```ts
fanout: parallel({
  states: {
    facts: compound({
      initial: "collect",
      states: {
        collect: {
          kind: "state",
          action: agent("fact-finder"),
          transitions: { DONE: "ready" },
        },
        ready: final(),
      },
    }),
    outline: compound({
      initial: "draft",
      states: {
        draft: {
          kind: "state",
          action: agent("outliner"),
          transitions: { DONE: "ready" },
        },
        ready: final(),
      },
    }),
  },
  onDone: "merge",
  transitions: { FAILED: "failed" },
}),
```

A transition handled at the parallel level exits all regions and cancels abandoned work.

## Map states

```ts
function map(options: {
  input?: Record<string, z.ZodType>;
  over: InputRef;
  concurrency?: number;
  onReenter?: OnReenterCst;
  initial: string;
  states: Record<string, StateCst>;
  transitions?: TransitionMapCst;
  onDone?: string;
}): MapStateCst;
```

`over` must resolve to an array or object. Arrays use stringified indexes as keys. Object keys must match `[A-Za-z0-9_-]+`. The runtime writes a `spawned` fact containing the keys and items; replay never re-resolves that generation.

```ts
const Item = z.object({ title: z.string() });
const ItemFile = z.object({ title: z.string(), text: z.string() });

type Args = { items: z.infer<typeof Item>[] };
type Results = Record<never, never>;
type Files = { "items.write": { item: z.infer<typeof ItemFile> } };
type Maps = { items: z.infer<typeof Item> };

const { chart, arg, key, item, joinArtifactOf } = refs<
  Args,
  Results,
  Files,
  Maps
>();

const definition = chart({
  kind: "chart",
  id: "map-example",
  initial: "items",
  states: {
    items: map({
      over: arg("items"),
      concurrency: 4,
      initial: "write",
      states: {
        write: {
          kind: "state",
          action: agent("writer", {
            task: t`Write ${key("items")}: ${item("items", "title")}`,
            artifacts: {
              item: artifact(t`out/${key("items")}.json`, ItemFile),
            },
          }),
          transitions: { DONE: "done" },
        },
        done: final(),
      },
      onDone: "merge",
      transitions: { FAILED: "failed" },
    }),
    merge: {
      kind: "state",
      action: script("node", ["scripts/merge.mjs"], {
        env: { ITEM_FILES: joinArtifactOf("items.write") },
      }),
      transitions: { DONE: "done", FAILED: "failed" },
    },
    done: final(),
    failed: failed(),
  },
});
```

See [`examples/deck-director.chart.ts`](../../examples/deck-director.chart.ts) for a larger checked-in map and fan-in.

`concurrency` limits active invocations, not the durable spawn set.

## Validation

### `tsImport(module, exportName)`

```ts
function tsImport(module: string, exportName: string): GuardRef;
```

The export receives the completion event and returns:

```ts
type GuardOutcome = boolean | { ok: false; reason: string };
```

Relative modules resolve from the chart directory.

```ts
validate: tsImport("./validators/report.ts", "acceptReport")
```

### Script guard

```ts
validate: script("node", ["validators/report.mjs"], {
  env: {
    RESULT: t`${result("draft", "path")}`,
    REPORT: artifactOf("draft", { select: "approved" }),
    ALL_REPORTS: joinArtifactOf("map.review"),
    VISIT: t`${visit()}`,
  },
  artifacts: { diagnostic: artifact("out/diagnostic.json", DiagnosticFile) },
  reply: z.object({ approved: z.boolean() }),
})
```

Guard env, artifacts, reply parsing, schema checks, and process execution use the exact same helpers as script actions. A declared reply validates the guard completion envelope but is not stored as the action result; declared guard artifacts are checked after exit and become downstream artifacts of the containing state. The event is written unchanged as plain `ChartEvent` JSON to stdin (no special `artifacts` field). Exit 0 accepts only after optional reply/artifact checks pass. A non-zero exit rejects; stderr becomes the rejection reason.

### Rejection and retries

```ts
validate: tsImport("./validators/report.ts", "acceptReport"),
onReject: "resume",
retries: 2,
transitions: {
  DONE: "done",
  FAILED: "failed",
},
```

Accepted verdicts are durable facts and are not re-run during replay. A changed guard is reported by `explainReplay()` as stale provenance.

## Re-entry

### `resume(message)`

```ts
function resume(message: Templatable): OnReenterCst;
```

Use in `onReenter` to request reuse of an existing agent session on a later visit:

```ts
onReenter: resume(t`Re-entered on visit ${visit()}; continue with the updated context.`)
```

`"restart"` requests a fresh invocation. Session reuse is runtime-dependent. The current contract does not define general identity for partially re-entered map or parallel work; do not assume arbitrary worker-session reuse.

## Zod schemas

`z` is re-exported from the package:

```ts
import { z } from "@surprisal/hyperchart";
```

Zod values are accepted in:

- action `reply`;
- state and map `input`;
- artifact `shape`;
- user-action `reply`.

Normalization converts Zod to plain JSON Schema in the AST. Runtime validation uses that normalized schema.

## Normalization diagnostics

`normalizeChartConfig()` returns diagnostics instead of throwing. Common codes include:

| Code | Meaning |
|---|---|
| `INVALID_CHART_KIND` | Root `kind` is not `"chart"`. |
| `INVALID_CHART_ID` | Chart id is missing or empty. |
| `INVALID_STATE_ID` | State id uses a reserved character. |
| `UNKNOWN_INITIAL_STATE` | `initial` does not name a child. |
| `MISSING_ACTION` | An action state has no action. |
| `MISSING_FINAL` | A compound, region, or map has no direct final child. |
| `MISSING_ON_DONE` | A completable container has no exit target. |
| `UNKNOWN_TRANSITION_TARGET` | Transition target is not a sibling at its declaration level. |
| `UNKNOWN_ON_DONE_TARGET` | `onDone` target does not exist. |
| `UNKNOWN_INPUT_RESULT` | `result()` does not name an action state. |
| `NON_DOMINATED_REF` | A result or artifact producer does not dominate its consumer. |
| `UNKNOWN_INPUT` | `input()` has no visible declaration. |
| `MISSING_INPUT` | A required input is not bound on an incoming route. |
| `UNKNOWN_FILE_SOURCE` | `artifactOf()` names a state with no artifacts. |
| `UNKNOWN_ARTIFACT` | The requested artifact name does not exist. |
| `AMBIGUOUS_ARTIFACT` | Artifact name was omitted for a multi-artifact producer. |
| `INVALID_MAP_REF` | A map-only ref is used outside a valid map scope. |
| `INVALID_VISIT_REF` | `visit()` does not name an action state. |
| `MISSING_FAILED_ROUTE` | A state can emit terminal `FAILED` but no route handles it. |
| `ON_DONE_CYCLE` | Initial/final/onDone entry cannot settle on an action or final leaf. |
| `TS_MODULE_LOAD_FAILED` | The chart module could not be loaded. |

Inspect a chart before execution to obtain the complete diagnostics for that definition.

## Complete authoring export inventory

Values:

```text
chart, agent, artifact, compound, contract, event, final, input, json,
map, parallel, refs, resume, script, t, tsImport, user, visit, z
```

The argument, result, artifact-read, map-key, and map-item constructors are methods returned by `refs()`.

Authoring types:

```text
ActionStateCst, AgentActionCst, ArtifactCst, ArtifactOfCst, AfterCst,
ChartCst, CompoundStateCst, EventBindingCst, FinalStateCst, InputRef,
JoinArtifactOfCst, MapStateCst, OnReject, OnReenterCst,
ParallelStateCst, SchemaCst, ScriptActionCst, StateActionCst, StateCst,
TemplateCst, Templatable, TransitionCst, TransitionMapCst,
UserActionCst, GuardOutcome, GuardRef, InputsOf, Paths, ValueAt
```
