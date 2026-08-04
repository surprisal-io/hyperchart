# Explicit event-sourced actors

## Context

Нужно добавить в Hyperchart явных actors, которые последовательно выполняют произвольные side-effecting workflows. Главный пример — несколько параллельных веток хотят менять один файл, но операции над этим файлом должны выполняться строго по одной.

Actors используют durable FIFO mailbox. Durable log остаётся единственным источником истины: никаких snapshots или checkpoints не будет. Изменение добавляет actor kernel, последовательную обработку сообщений, `send`, `call` и `reply`.

## Как будет выглядеть API

Ниже сквозной пример: внешний `map` обрабатывает проекты параллельно, но у каждого проекта есть собственный `editor` actor. Поэтому изменения одного проекта сериализуются, а разные проекты остаются независимыми.

### 1. Protocol описывает публичный интерфейс actor-а

```ts
const EditRequest = z.object({
  patch: z.string(),
});

const EditReceipt = z.object({
  commit: z.string(),
});

const EditRejection = z.object({
  reason: z.string(),
});

const EditorProtocol = protocol({
  APPLY: message({
    input: EditRequest,
    replies: {
      APPLIED: EditReceipt,
      REJECTED: EditRejection,
    },
  }),
});
```

Protocol задаётся отдельно от state graph намеренно:

- protocol отвечает, какие сообщения actor вообще поддерживает;
- `receive()` отвечает, какие сообщения actor принимает в текущем состоянии и куда по ним переходит.

Имя `APPLY` встречается в обоих местах, но означает contract и routing соответственно.

Каждое protocol message обязано завершиться `reply()`.

Поддерживаются три формы reply contract.

#### Void reply по умолчанию

```ts
const AuditProtocol = protocol({
  RECORD: message({
    input: AuditRecord,
  }),
});
```

Отсутствующий `reply` означает `void`.

#### Один typed reply

```ts
const ReadProtocol = protocol({
  READ: message({
    input: ReadRequest,
    reply: ReadResult,
  }),
});
```

#### Несколько named replies

```ts
const EditorProtocol = protocol({
  APPLY: message({
    input: EditRequest,
    replies: {
      APPLIED: EditReceipt,
      REJECTED: EditRejection,
    },
  }),
});
```

### 2. `actor()` создаёт authoring-time template

```ts
const EditorInput = z.object({
  projectId: z.string(),
  file: z.string(),
});

const Editor = actor({
  input: EditorInput,
  protocol: EditorProtocol,

  initial: "idle",

  states: {
    idle: receive({
      on: {
        APPLY: "apply",
      },
    }),

    apply: {
      kind: "state",

      action: agent("file-editor", {
        task: t`
          Apply ${messageInput("APPLY", "patch")}
          to ${actorInput("file")}
        `,
        reply: EditReceipt,
      }),

      transitions: {
        APPLIED: "verify",
      },
    },

    verify: {
      kind: "state",

      action: agent("edit-verifier", {
        task: t`Verify ${result("apply", "commit")}`,
        reply: EditReceipt,
      }),

      transitions: {
        VERIFIED: reply({
          target: "idle",
          event: "APPLIED",
          output: result("verify"),
        }),
      },
    },
  },
});
```

`Editor` ещё не является runtime actor. Это типизированная authoring-time функция:

```ts
Editor(input: {
  projectId: ValueExpr<string>;
  file: ValueExpr<string>;
}): StaticActorDeclaration<typeof EditorProtocol>;
```

Весь workflow от принятия `APPLY` до `reply()` принадлежит одному mailbox message. Пока выполняются `apply` и `verify`, actor не может принять следующее сообщение.

### 3. Actor template вызывается с параметрами размещения

```ts
const projectActors = {
  editor: Editor({
    projectId: item("projects", "id"),
    file: item("projects", "sourceFile"),
  }),

  testEditor: Editor({
    projectId: item("projects", "id"),
    file: item("projects", "testFile"),
  }),

  reviewer: Reviewer({
    projectId: item("projects", "id"),
    policy: arg("reviewPolicy"),
  }),
};
```

Отдельного `defineActors()` нет.

```text
actor({...})      → reusable authoring-time template
Editor({...})     → static declaration/capability с конкретными input expressions
actors: {...}     → lexical placement у owner
owner activation  → runtime actor occurrence
```

Каждый результат вызова template должен быть размещён ровно один раз. Если нужно два одинаковых actors, template вызывается дважды, как `editor` и `testEditor` выше.

### 4. Static declarations размещаются непосредственно у owner

```ts
const workflow = chart({
  initial: "projects",

  states: {
    projects: map({
      over: result("plan", "projects"),

      actors: projectActors,

      initial: "prepare",

      states: {
        prepare: {
          kind: "state",
          action: agent("patch-planner", {
            reply: EditRequest,
          }),
          transitions: {
            READY: "apply",
          },
        },

        apply: call({
          to: projectActors.editor,
          event: "APPLY",
          input: result("prepare"),
          transitions: {
            APPLIED: "done",
            REJECTED: "rework",
          },
        }),

        rework: {
          // Обычный authored business workflow.
        },

        done: final(),
      },

      onDone: "done",
    }),

    done: final(),
  },
});
```

Для map items `a` и `b` runtime создаёт отдельные occurrences:

```text
projects#a.editor
projects#a.testEditor
projects#a.reviewer

projects#b.editor
projects#b.testEditor
projects#b.reviewer
```

`projects#a` может обращаться только к actor declarations из своего lexical scope. Нельзя выбрать `projects#b.editor` по runtime key.

Если serializer нужен на весь run, declaration помещается в `chart.actors`, а не в `map.actors`.

### 5. Любая доставка происходит только через `receive()`

Это безусловный инвариант:

> Любой actor получает любое mailbox message только через явно объявленный `receive()` state.

Нет исключений для service actors, child actors, replay или будущих scheduler constructs. Runtime не может создать actor с уже принятым current message и не может обойти `receive()`.

Порядок обработки:

```text
message находится в durable mailbox
→ actor находится в receive()
→ mailbox head exact-валидируется
→ durable MESSAGE_ACCEPTED
→ переход в handler workflow
→ reply()
→ actor возвращается в receive()
→ только теперь доступно следующее сообщение
```

Если FIFO head не поддерживается текущим `receive`, весь run fails. Нет stash, selective receive, dead letters или silent drop.

### 6. `reply()` завершает текущее сообщение

`reply()` не содержит `for`.

```ts
reply({
  target: "idle",
  event: "APPLIED",
  output: result("verify"),
})
```

Request type выводится из графа:

```text
receive.APPLY → apply → verify → reply
```

Type verifier и normalizer отклоняют reply-state, достижимый от нескольких несовместимых message types. Общие промежуточные states допустимы, но перед typed reply workflows должны разойтись в однозначные reply paths.

Формы DSL соответствуют protocol contract.

#### Void

```ts
reply({
  target: "idle",
})
```

#### Один reply schema

```ts
reply({
  target: "idle",
  output: result("read"),
})
```

#### Named replies

```ts
reply({
  target: "idle",
  event: "REJECTED",
  output: result("verify", "rejection"),
})
```

Перед settlement output проходит exact async validation по выбранной reply schema.

### 7. `send` — fire-and-forget

```ts
audit: send({
  to: rootActors.auditor,
  event: "RECORD",
  input: {
    path: result("prepare", "path"),
  },
  target: "next",
})
```

`send` завершается после durable enqueue и не ждёт receiver reply. Receiver всё равно обязан закончить сообщение через `reply()`; void reply используется как durable settlement mailbox transaction, но sender его не получает.

Batch send остаётся общей mailbox-возможностью:

```ts
enqueue: send({
  to: rootActors.auditor,
  event: "RECORD",
  inputs: result("prepare", "records"),
  target: "next",
})
```

У `send` должен быть ровно один из вариантов:

```ts
input: MessageInput;
inputs: MessageInput[];
```

Весь batch exact-валидируется до enqueue. Validation failure не пишет частичный batch и globally fails run.

### 8. `call` ждёт typed reply

Один typed reply:

```ts
read: call({
  to: rootActors.reader,
  event: "READ",
  input: {
    path: result("prepare", "path"),
  },
  target: "next",
})

result("read"); // ReadResult
```

Несколько named replies:

```ts
apply: call({
  to: projectActors.editor,
  event: "APPLY",
  input: result("prepare"),
  transitions: {
    APPLIED: "done",
    REJECTED: "rework",
  },
})

result("apply"); // EditReceipt | EditRejection
```

`call` отправляет ровно одно сообщение.

## Type-system plan

### Protocol inference

Из Zod schemas выводятся:

```ts
type MessageTypes<P> = keyof P;
type MessageInput<P, M>;
type ReplyEvents<P, M>;
type ReplyOutput<P, M, R>;
type ReplyUnion<P, M>;
```

Protocol и input schema сохраняются в phantom type actor template и каждого static declaration.

### Typed target и event

```ts
call({
  to: projectActors.editor,
  event: "APPLY",
  // ...
})
```

`event` не является произвольной строкой. Его тип выводится через `to`:

```ts
type StaticActorDeclaration<Protocol, Input, DeclarationBrand>;
```

TypeScript отклоняет unknown event, неверный input и reply transitions, не принадлежащие выбранному message.

### Actor-local references

- `actorInput(path)` проверяется относительно actor input schema.
- `messageInput(message, path)` проверяется относительно конкретного message input schema.
- `result()`/`artifactOf()` внутри actor не могут читать parent или sibling actor data.
- Actor declaration не может быть помещён в message, artifact, schema output или template value.

Как и существующий `refs()`, typed actor builder должен решить circular inference для actor-local results через mutual verification actor literal. Реализация может использовать внутренний checked builder, но не должна возвращать автору прежний дополнительный `defineActors()` слой.

### Reply inference from graph

`actor(...)` анализирует literal state graph:

1. берёт target каждого `receive.on.MESSAGE`;
2. распространяет message context по переходам;
3. на каждом `reply()` требует ровно один совместимый message context;
4. проверяет event/output по replies этого message;
5. проверяет возврат в valid `receive()` state.

Normalizer повторяет анализ для JavaScript и untyped DSL. Runtime сверяет выведенный message type с фактическим `currentMessage.type`.

### Compile-time tests

В `tests/typed.test.ts` добавляются positive cases и `@ts-expect-error` для:

- неизвестного protocol event;
- неправильного single/batch input;
- одновременно `input` и `inputs`;
- неправильного single reply output;
- missing/extra named reply transitions;
- reply event от другого message;
- ambiguous reply reachability;
- неправильного `actorInput`/`messageInput` selector;
- parent/sibling actor-local result;
- dynamic string вместо static declaration;
- actor declaration внутри runtime data;
- повторного placement одного declaration;
- authored `FAILED` transition.

Clean-consumer fixture проверяет сохранение phantom types в опубликованных `.d.ts`.

## Inspector and Storybook design

Inspector support is part of actor semantics, not a follow-up JSON dump. Before wiring live runtime data, design the actor experience against deterministic Storybook fixtures.

### Graph presentation

The graph must show:

- actor declarations nested inside their lexical owner boundary;
- separate runtime occurrences for map owners without suggesting that another item can address them;
- `send` and `call` edges to the static actor declaration;
- the active `receive()` state and current message workflow;
- the reply edge back to an awaiting call without representing fire-and-forget send as a waiting edge;
- closing, draining, failed and stopped actor states.

Actor internals remain inspectable as their ordinary state graph. The default owner graph may render actors compactly, with an explicit expand action, so a large chart does not become unreadable.

### Actor details

Selecting an actor declaration or occurrence must expose:

- static declaration path and owner path;
- input schema and resolved immutable input;
- protocol message/input/reply contracts;
- current state configuration;
- FIFO mailbox count and ordered entries;
- current message, producer visit and optional `callId`;
- queued/accepted/replied/failed status per message;
- reply validation provenance;
- pending caller and wait reason;
- closing/drain progress and cancellation status;
- visit history and actor-local results/artifacts using existing detail components.

Large mailboxes use a compact head/count presentation with an expandable ordered list rather than rendering every payload in the graph.

### Storybook-first workflow

Add mocked definition/projection fixtures and dedicated stories for:

1. a root serializer actor at idle;
2. a busy actor with multiple FIFO messages;
3. a map-local actor shown for two owner occurrences;
4. a pending typed `call` and its eventual reply;
5. fire-and-forget `send` with void settlement;
6. named reply variants;
7. actor closing while mailbox work drains;
8. validation/global failure and cancellation;
9. a stress case with many declarations and queued messages;
10. stale/broken replay compatibility diagnostics.

Review and settle layout, labels, navigation and information hierarchy in Storybook before connecting the components to live inspector adapters. The approved stories become visual regression fixtures and the contract for inspect AST/runtime models.

## Runtime semantics

### Static topology

- Actor templates вызываются только во время authoring.
- Результат template call — static declaration/capability, а не runtime `ActorRef`.
- Declaration размещается ровно один раз в `actors` одного lexical owner.
- Normalizer присваивает declaration статический path и стирает object identity из normalized AST.
- `send`/`call` могут ссылаться только на actor из того же или ancestor lexical scope.
- Actor occurrences из descendant/sibling map items недоступны.
- Все static `call` graph cycles запрещены normalization error.

### Actor isolation

Actor видит только:

- immutable actor input;
- current message input;
- собственные state inputs, results и artifacts.

Parent results, sibling actor results и concrete runtime actor occurrences недоступны.

### Durable mailbox transaction

Лог должен выражать следующие факты:

- actor occurrence создан с immutable validated input и definition provenance;
- single message или authored-order batch enqueued;
- FIFO head принят в конкретном `receive()` visit;
- message стал current;
- reply exact-валидирован;
- message settled;
- waiting call разбужен, если он существует;
- actor вернулся в receive state;
- actor scope начал closing и остановился.

Message IDs детерминированы producer actor/state visit и batch index. Runtime callbacks не пишут log напрямую; ordering принадлежит одному machine runner.

### Send и call correlation

Envelope содержит optional engine-owned `callId`.

- Для `send` callId отсутствует; `reply()` только settlement-ит сообщение.
- Для `call` callId указывает точный caller state visit; `reply()` дополнительно доставляет typed result caller-у.

Actor никогда не называет получателя reply.

### Normal owner exit

Когда owner достигает normal exit:

1. durable-записывается `scope_closing`;
2. новые внешние send/call в closing scope запрещаются;
3. уже принятые message workflows продолжаются;
4. существующий mailbox полностью обрабатывается;
5. waiting calls получают replies;
6. idle actors останавливаются;
7. owner выходит после полного drain.

Actor не может молча выйти или вернуться в `receive()` с unsettled current message.

### Global fail-fast

Любой reserved `FAILED` от agent, script, user, validation, actor protocol или runtime:

1. durable-записывает failure intent;
2. запрещает новые effects/messages;
3. запрашивает cancellation agent/script/user/validation/rejection/timer/actor phases;
4. ждёт quiescence acknowledgements;
5. terminalizes run как failed.

`FAILED` нельзя маршрутизировать в authored chart. Business outcomes выражаются protocol replies вроде `REJECTED`. Явный `failed()` остаётся authored terminal outcome.

Если log повреждён или failure intent невозможно записать, run считается operationally broken, а не replayable failed.

### Replay и rewind

Projection восстанавливает только из durable log:

- actor hierarchy/generations;
- actor state configurations;
- FIFO mailboxes;
- current messages;
- pending calls;
- closing/drain;
- failure/cancellation.

Replay compatibility проверяет actor ownership, input/protocol schemas, behavior, placements, send/call targets и reply contracts.

Rewind удаляет полный semantic suffix вместе с actor messages, calls, sessions и artifacts. Внешние side effects не откатываются.

## Map migration

После стабилизации explicit actor kernel существующие finite map items переводятся на тот же occurrence/projection machinery без изменения публичной `map(...)` семантики:

- один pinned `spawned` set;
- `{ key, item }` становится immutable child input;
- concurrency и join остаются прежними;
- map не растёт;
- parent refs, пересекающие actor boundary, становятся явными captured inputs.

Это не добавляет dynamic actor creation: количество map occurrences по-прежнему определяется одним durable finite spawn fact.

## Files to modify

### Core

- `packages/hyperchart/src/core/types.ts`
- `packages/hyperchart/src/core/dsl.ts`
- `packages/hyperchart/src/core/typed.ts`
- `packages/hyperchart/src/core/normalize.ts`
- `packages/hyperchart/src/core/paths.ts`
- `packages/hyperchart/src/core/durable_events.ts`
- `packages/hyperchart/src/core/projection.ts`
- `packages/hyperchart/src/core/machine.ts`
- `packages/hyperchart/src/core/execution_loop.ts`
- `packages/hyperchart/src/core/replay_check.ts`
- `packages/hyperchart/src/core/inspect_ast.ts`
- `packages/hyperchart/src/core/source.ts`
- public export barrels

### Runtime/hosts

- `packages/hyperchart/src/runtime/runtime.ts`
- `packages/hyperchart/src/runtime/generic/chart_runtime.ts`
- `packages/hyperchart/src/runtime/generic/schema.ts`
- `packages/hyperchart/src/runtime/generic/run_outcome.ts`
- executor paths for cancellation acknowledgements
- `packages/hyperchart/src/runtime/generic/rewind.ts`
- affected Pi and Claude executor adapters
- `packages/hyperchart/src/host/models.ts`
- `packages/hyperchart/src/host/adapters.ts`
- `packages/hyperchart/src/host/summarize.ts`
- run progress/status handling

Do not overwrite unrelated dirty changes in:

- `packages/hyperchart/src/runtime/generic/executor_helpers.ts`
- `packages/pi-hyperchart/src/runtime/pi/pi_agent_executor.ts`
- `tests/pi_executor_helpers.test.ts`

### UI/formal/docs

- `packages/hyperchart/src/react/components/inspector/graph/graphInput.ts`
- `packages/hyperchart/src/react/components/inspector/graph/graphModel.ts`
- `packages/hyperchart/src/react/components/inspector/graph/HyperchartGraphPreview.tsx`
- `packages/hyperchart/src/react/components/inspector/graph/HyperchartStateGraphNode.tsx`
- `packages/hyperchart/src/react/components/inspector/graph/HyperchartTransitionEdge.tsx`
- new actor declaration/occurrence/mailbox graph components
- `packages/hyperchart/src/react/components/inspector/details/DefinitionSection.tsx`
- `packages/hyperchart/src/react/components/inspector/details/RuntimeSection.tsx`
- `packages/hyperchart/src/react/components/inspector/details/StateDetails.tsx`
- new actor protocol, mailbox and call-correlation detail components
- `packages/hyperchart/src/react/components/inspector/types.ts`
- `packages/hyperchart/src/react/stories/InspectorDialogActors.stories.tsx`
- `packages/hyperchart/src/react/stories/InspectorGraph.stories.tsx`
- `packages/hyperchart/src/react/stories/HyperchartInspectorStress.visual.stories.tsx`
- focused actor inspector stories/fixtures
- `tla/Hyperchart.tla`
- new bounded actor/mailbox MC models
- `tla/HyperchartTrace.tla`
- trace export/record/sample files
- `docs/core-authoring.md`
- `docs/composition.md`
- `docs/runtime-and-durability.md`
- `docs/safety.md`
- `docs/architecture.md`
- relevant API/integration docs, package README/examples and canonical skills

### Tests

- `tests/typed.test.ts`
- `tests/normalize.test.ts`
- `tests/execution_loop.test.ts`
- `tests/chart_runtime.test.ts`
- `tests/runtime_contract.test.ts`
- `tests/run_outcome.test.ts`
- `tests/gauntlet.test.ts`
- `tests/replay_check.test.ts`
- `tests/hyperchart_runner_replay.test.ts`
- `tests/react_runtime_adapter.test.ts`
- affected rewind/extension/MCP tests
- new focused actor/mailbox/call suites

## Reuse

- `core/typed.ts`: existing phantom refs, flattened state paths and mutual chart registries.
- `core/paths.ts`: template/concrete map path rebasing.
- Existing durable `spawned` facts: pinned map inputs and deterministic order.
- `machine.ts`/`projection.ts`: desired effects, pending phases and fact-derived transitions.
- Runtime schema registry: exact sync/async Zod validation.
- `replay_check.ts`: provenance/stale/broken reporting.
- Existing TLA+ and real-trace harness.

## Steps

- [x] **Freeze the actor contract.** Finalize the API shown above, template/placement identity, `message` reply overloads, `receive`, `send`, `call`, `reply`, IDs, durable records and normalization diagnostics.
- [x] **Design the inspector in Storybook.** Build deterministic actor definition/runtime fixtures, graph/detail variants and stress stories; review the visual hierarchy and interactions before live runtime integration. Treat the approved stories as the inspect-model and visual-regression contract.
- [x] **Build failure/quiescence infrastructure.** Add durable failure intent and cancellation request/ack coverage before switching reserved `FAILED` to global fail-fast.
- [x] **Implement the actor kernel.** Add static actor placements, immutable inputs, strict isolation, occurrence projection, FIFO mailboxes, explicit receive-only delivery, current-message ownership, reply settlement and structured drain without snapshots.
- [x] **Implement messaging and typing.** Add exact send/call validation, atomic send batch, optional call correlation, graph-inferred replies, typed call results, call-cycle rejection and declaration export types.
- [x] **Integrate replay and tooling.** Add compatibility checks, rewind, status/progress, inspector/Storybook support and host adapters.
- [x] **Synchronize semantics.** Update TLA+, model checking and a real trace in the same stage as each runtime semantic change.
- [x] **Migrate finite map internals.** Reuse actor occurrence machinery while preserving public pinned map semantics.
- [x] **Update documentation and examples.** Keep docs, package exports and canonical skills synchronized with checked examples.

## Verification

- Every actor message is accepted only from an explicit `receive()` state.
- Actor never overlaps two message workflows.
- Actor cannot return to `receive()` before exactly one valid `reply()`.
- Void, single and named reply contracts validate and infer correctly.
- `send` never waits for reply; `call` receives the exact inferred type.
- Batch send is atomic and all-or-nothing under async validation.
- Static declarations cannot be dynamically selected, duplicated in topology or embedded in runtime data.
- Inspector stories clearly distinguish static declarations, runtime occurrences, mailbox order, current messages and call correlations.
- Storybook visual/stress fixtures pass before and after live inspector adapter wiring.
- Map item actors remain lexically isolated by owner occurrence.
- Normal owner exit drains mailbox and pending calls.
- Failure starts no successor and terminalizes only after quiescence.
- Crash tests cover actor creation, enqueue, accept, action invoke/complete, reply validation/settlement, caller wake-up, closing and cancellation acknowledgement.
- Replay reconstructs the complete actor system without reading a snapshot.
- All old/new TLA+ models pass.
- Real sample covers local/global actors, single/batch send, call/reply, drain and failure cancellation; require `TRACE ACCEPTED`.
- `npm run check`, package validation, clean-consumer type tests, docs sync and Storybook checks pass.
- After implementation, offer but do not automatically launch the required `docs-engine` audit.

## Основные принципы реализации

1. **Лог — единственная истина.** Никаких snapshots или checkpoints.
2. **Protocol принадлежит actor-у, но отделён от routing.** Contract описывается независимо от текущего receive state.
3. **Любая доставка идёт только через явный `receive()`.** Исключений нет.
4. **Один actor обрабатывает одно current message до `reply()`.**
5. **Каждое protocol message обязано завершиться `reply()`.** Void reply краток и является default contract.
6. **`send` не ждёт, `call` ждёт.** Оба используют один protocol и одну mailbox семантику.
7. **Request для `reply()` выводится из state graph.** Ручного `for` нет; неоднозначные reply paths запрещены.
8. **Topology статична.** Actor template вызывается authoring-time; declaration размещается один раз и служит typed capability.
9. **Actors изолированы.** Только immutable actor input, current message и собственные данные.
10. **Все reserved failures глобальны.** Domain outcomes выражаются обычными typed replies.
11. **Normal exit structured.** Owner drains messages и calls перед остановкой.
12. **TypeScript, durable semantics, TLA+ и real trace меняются вместе.**
13. **Exactly-once внешних side effects не обещаем.** Durable scheduling не делает внешний мир транзакционным.
