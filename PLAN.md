# План: API для statechart-оркестратора агентов

## Context

Пользователь хочет начать с API для упрощённого XState-подобного оркестратора агентов. Основной таргет — pi extension и TUI, с моделью оркестрации ближе к LangGraph/LangChain Graph, но через statechart-подход.

Текущий репозиторий `pi-hyperchart` пустой, поэтому план исходит из нового standalone-пакета/extension, который затем интегрируется с `../pi`.

Первичные находки:
- В `../pi` есть extension API: extensions могут регистрировать tools/commands, слушать lifecycle events и использовать `ctx.ui` для TUI.
- В `../pi/packages/coding-agent/examples/extensions/subagent/index.ts` уже есть простой subagent tool с режимами `single`, `parallel`, `chain`; его можно использовать как reference для запуска изолированных agent-процессов и TUI rendering.
- В `../pi-flows` уже есть DAG/YAML orchestration с dashboard; новый API должен отличаться более явной state/action/routing-конфигурацией и сериализуемыми snapshots.

Уточнения от пользователя:
- Формат на первом этапе — только TypeScript API, без YAML/JSON DSL.
- `pi-hyperchart` — отдельный пакет, не прямой модуль внутри `../pi`.
- Сейчас проектируем и обсуждаем только API; pi runtime, TUI и durable execution остаются будущими адаптерами/constraints, не частью текущего implementation scope.
- После review плана API намеренно упрощается: главный фокус — конфигурация состояний; каждое non-final состояние имеет ровно один action (`agent`, `script` или `user`).

## Approach

Сделать standalone TypeScript API, но **текущий scope сузить до типов и парсинга TS-конфигурации в нормализованные типы**. Никакого interpreter/runtime, pi adapter, TUI, guards, timers, hierarchy/parallel или durable execution сейчас не делаем.

Authoring format — обычный TypeScript module:

```ts
import { agent, chart, final, jsonSchema, user } from "pi-hyperchart";

export default chart({
  id: "review-and-fix",
  initial: "research",
  states: {
    research: {
      action: agent("researcher", {
        input: ({ input }) => ({ task: input.task }),
        output: jsonSchema({
          type: "object",
          required: ["summary"],
          properties: { summary: { type: "string" } },
        }),
      }),
      transitions: {
        RESEARCH_READY: "plan",
        FAILED: "failed", // reserved system event; runtime emits it on action error
      },
    },

    plan: {
      action: agent("planner", {
        input: ({ input, results }) => ({
          task: input.task,
          research: results.research.output,
        }),
        output: jsonSchema({
          type: "object",
          required: ["steps"],
          properties: { steps: { type: "array", items: { type: "string" } } },
        }),
      }),
      transitions: { PLAN_READY: "implement", FAILED: "failed" },
    },

    implement: {
      action: agent("coder"),
      transitions: { IMPLEMENTED: "verify", FAILED: "failed" },
    },

    approval: {
      action: user({ prompt: "Apply changes?", options: ["APPROVED", "REJECTED"] }),
      transitions: { APPROVED: "done", REJECTED: "implement" },
    },

    done: final(),
    failed: final(),
  },
});
```

API-концепты текущего этапа:
- Главный объект — **state configuration**, а не actor/runtime.
- `chart(config)` / `createChart(config)` возвращает typed authoring config (CST-like object).
- Parser/normalizer превращает TS-exported config в normalized AST-like type с diagnostics.
- State в первом draft: либо action state, либо final state.
- Non-final state имеет ровно один `action`: `agent`, `script` или `user`.
- Action result model типизируется, но исполнение action сейчас не реализуется.
- Agent/script/user могут вернуть `output` и custom `event`; `output` передаётся дальше через `results.<stateId>.output`.
- `FAILED` — reserved system event. Его нельзя эмитить из action result; он зарезервирован для будущего runtime при ошибке action.
- `transitions` сейчас только `Record<eventType, targetStateId>`; guards/conditions пока не делаем.
- Форма `output` задаётся в action descriptor через JSON Schema или schema reference.

### CST/AST type draft

Ниже фиксируем текущие типы authoring CST и normalized AST. Implementation может разнести их по файлам, но shape должен остаться таким на первом этапе.

```ts
type StateId = string;
type EventType = string;
type ReservedSystemEventType = "FAILED";
type JsonSchema = Record<string, unknown>;

type InputMapper<TInput = unknown> = (args: {
  input: TInput;
  results: Record<StateId, StateResult>;
}) => unknown;

// ---------------------------------------------------------------------------
// Authoring CST: what TS users create via chart()/agent()/final() helpers.
// ---------------------------------------------------------------------------

type ChartCst<TInput = unknown> = {
  kind: "chart";
  id: string;
  initial: StateId;
  states: Record<StateId, StateCst<TInput>>;
};

type StateCst<TInput = unknown> =
  | ActionStateCst<TInput>
  | FinalStateCst;

type ActionStateCst<TInput = unknown> = {
  kind: "state";
  action: StateActionCst<TInput>;
  transitions?: TransitionMapCst;
};

type FinalStateCst = {
  kind: "final";
};

type TransitionMapCst = Record<EventType, StateId>;

type StateActionCst<TInput = unknown> =
  | AgentActionCst<TInput>
  | ScriptActionCst<TInput>
  | UserActionCst<TInput>;

type AgentActionCst<TInput = unknown> = {
  kind: "agent";
  name: string;
  input?: InputMapper<TInput>;
  output?: OutputSpecCst;
};

type ScriptActionCst<TInput = unknown> = {
  kind: "script";
  command: string | InputMapper<TInput>;
  output?: OutputSpecCst;
};

type UserActionCst<TInput = unknown> = {
  kind: "user";
  prompt: string | InputMapper<TInput>;
  options?: readonly string[];
  output?: OutputSpecCst;
};

type OutputSpecCst =
  | JsonSchemaOutputCst
  | SchemaRefCst
  | TsImportSchemaRefCst;

type JsonSchemaOutputCst = {
  kind: "jsonSchema";
  schema: JsonSchema;
};

type SchemaRefCst = {
  kind: "schemaRef";
  name: string;
};

type TsImportSchemaRefCst = {
  kind: "tsImport";
  module: string;
  export: string;
};

// ---------------------------------------------------------------------------
// Normalized AST: parser/normalizer output. IDs are explicit; optional maps are
// defaulted; objects are deeply frozen by implementation.
// ---------------------------------------------------------------------------

type ChartAst<TInput = unknown> = {
  kind: "chart";
  id: string;
  initial: StateId;
  states: Readonly<Record<StateId, StateAst<TInput>>>;
};

type StateAst<TInput = unknown> =
  | ActionStateAst<TInput>
  | FinalStateAst;

type ActionStateAst<TInput = unknown> = {
  kind: "state";
  id: StateId;
  action: StateActionAst<TInput>;
  transitions: Readonly<Record<EventType, StateId>>;
};

type FinalStateAst = {
  kind: "final";
  id: StateId;
};

type StateActionAst<TInput = unknown> =
  | AgentActionAst<TInput>
  | ScriptActionAst<TInput>
  | UserActionAst<TInput>;

type AgentActionAst<TInput = unknown> = {
  kind: "agent";
  name: string;
  input?: InputMapper<TInput>;
  output?: OutputSpecAst;
};

type ScriptActionAst<TInput = unknown> = {
  kind: "script";
  command: string | InputMapper<TInput>;
  output?: OutputSpecAst;
};

type UserActionAst<TInput = unknown> = {
  kind: "user";
  prompt: string | InputMapper<TInput>;
  options: readonly string[];
  output?: OutputSpecAst;
};

type OutputSpecAst =
  | JsonSchemaOutputAst
  | SchemaRefAst
  | TsImportSchemaRefAst;

type JsonSchemaOutputAst = {
  kind: "jsonSchema";
  schema: Readonly<JsonSchema>;
};

type SchemaRefAst = {
  kind: "schemaRef";
  name: string;
};

type TsImportSchemaRefAst = {
  kind: "tsImport";
  module: string;
  export: string;
};

// ---------------------------------------------------------------------------
// Events/results are type contracts only in this phase. No executor yet.
// ---------------------------------------------------------------------------

type ActionEvent<TPayload = unknown> = {
  type: string;
  payload?: TPayload;
};

type SystemEvent = {
  type: ReservedSystemEventType;
  error: unknown;
};

type ChartEvent = ActionEvent | SystemEvent;

type StateResult<TOutput = unknown> = {
  status: "ok" | "error" | "cancelled";
  output?: TOutput;
  event?: ActionEvent;
  error?: unknown;
};

// ---------------------------------------------------------------------------
// Parser result and diagnostics.
// ---------------------------------------------------------------------------

type ParsedChart<TInput = unknown> =
  | {
      ok: true;
      source: ChartSource;
      cst: ChartCst<TInput>;
      ast: ChartAst<TInput>;
      diagnostics: readonly [];
    }
  | {
      ok: false;
      source: ChartSource;
      cst?: ChartCst<TInput>;
      diagnostics: readonly AuthoringDiagnostic[];
    };

type ChartSource = {
  path?: string;
  exportName?: string;
  line?: number;
  column?: number;
};

type AuthoringDiagnostic = {
  code: string;
  message: string;
  path?: string;
  source?: ChartSource;
};
```

Parser rules:
- Input TS module must export default `chart({...})` or a compatible `ChartCst` object.
- Parser evaluates only trusted local TS modules, then validates/normalizes the exported object. It does not run agents/scripts/users.
- Normalizer freezes normalized AST to keep parse output deterministic.
- `initial` must reference an existing state.
- Each non-final state must have exactly one action.
- Each transition target must reference an existing state.
- Transition key `FAILED` is allowed only as reserved system event; custom action events named `FAILED` are invalid.
- Guards are intentionally absent: no route predicates, no `when`, no `always`, no timers.
- Output schema is preserved as `OutputSpecAst`; full JSON Schema validation can be a separate adapter/hook later.

## Files to modify

Предполагаемые новые файлы в `pi-hyperchart` для текущего types/parser этапа:
- `package.json` — package metadata/scripts.
- `tsconfig.json` — TS config.
- `src/index.ts` — public exports.
- `src/core/types.ts` — authoring config, normalized AST, diagnostics, schema refs, event/result types.
- `src/core/dsl.ts` — helpers: `chart`, `agent`, `script`, `user`, `final`, `jsonSchema`, `schemaRef`, `tsImportSchema`.
- `src/core/normalize.ts` — config -> normalized AST + diagnostics.
- `src/core/parser.ts` — load/parse trusted TS module default export into `ParsedChart`.
- `examples/api/*.chart.ts` — TS authoring examples.
- `tests/*.test.ts` — type/normalizer/parser tests.

Future, not current scope:
- `src/core/interpreter.ts` — execution loop.
- `src/pi/*` — pi runtime adapter/extension wrapper.
- `src/tui/*` — TUI snapshot renderer.

## Reuse

- `../pi/packages/coding-agent/src/core/extensions/types.ts` — future reference for `ExtensionAPI`, `ExtensionContext`, UI/actions model.
- `../pi/packages/coding-agent/docs/extensions.md` — future extension packaging and UI capabilities.
- `../pi/packages/coding-agent/examples/extensions/subagent/index.ts` — future reference for isolated agent invocation and streaming updates.
- `../pi/packages/coding-agent/examples/extensions/todo.ts` — future reference for state persistence patterns.
- `../pi-flows/extensions/flow-engine/types.ts` и `../pi-flows/docs/public-api.md` — contrast/reference for DAG flow API and agent result model.

## What to take from `../pi-hyperchart-back` (critically)

Useful ideas to reuse:
- CST vs normalized AST separation from `packages/core/src/dsl.ts`: keep authoring input separate from normalized parsed output.
- Deterministic normalized/frozen AST objects and stable parser snapshots from `parser.test.ts`.
- Diagnostic style with `code`, `message`, `path`, `source` from validator/parser code.
- Schema reference idea (`schemaRef` / `tsImport`) for output forms, but simplify it and focus on action `output`.
- Parser fixture strategy: valid/broken examples plus snapshot tests.

Things to avoid from `../pi-hyperchart-back`:
- Scope creep: runtime, event log, replayability, MDX parser, guards, timers, parallel states, HITL/TUI all landed too early.
- MDX/protocol parser complexity and `new Function` evaluation model; for now prefer trusted TS module loading + object normalization.
- Entry arrays, `invoke`, `onDone/onError`, guards, `always`, `after`, parallel regions — they violate the current one-action-per-state API.
- Runtime/reducer/checkpoint abstractions are not needed while we are only defining types and TS parsing.

## Steps

- [x] Зафиксировать текущий scope: только TypeScript types + parsing TS config into normalized types.
- [x] Упростить API: flat state graph, one action per state, no context/entry/exit/invoke/meta/guards.
- [x] Зафиксировать draft типов CST/AST прямо в плане.
- [x] Перенести CST/AST contracts в `src/core/types.ts` без расширения scope.
- [x] Реализовать DSL helpers (`chart`, `agent`, `script`, `user`, `final`, schema helpers), которые возвращают typed plain CST objects.
- [x] Реализовать `normalizeChartConfig()` с validation: initial, state shape, one action, transition targets, reserved `FAILED`.
- [x] Реализовать TS parser/loader для trusted local chart modules and default export normalization.
- [x] Добавить fixtures/examples for valid and broken `.chart.ts` files.

## Verification

- TypeScript compile/type tests for authoring examples.
- Unit tests for normalization diagnostics: invalid initial, missing action, duplicate/unknown target, custom `FAILED` misuse, invalid output schema shape.
- Parser tests for valid/broken TS chart modules and stable normalized AST snapshots.
- No runtime/pi/TUI tests in this phase.

## Deferred decisions

- Runtime/interpreter execution semantics.
- pi extension and TUI integration.
- Durable resume/snapshots/event log.
- Guards/conditional transitions.
- Hierarchy/parallel/history.
- External `send` events, timers, and XState-like target syntax.
