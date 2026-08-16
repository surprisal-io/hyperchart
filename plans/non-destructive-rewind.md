# Недеструктивный rewind через movable leaf

## Context

Сейчас `rewindHyperchartRun()` копирует служебные данные в `rewind-backups/`, физически обрезает `log.jsonl` и продолжает replay от оставшегося префикса (`packages/hyperchart/src/runtime/generic/rewind.ts`). Нужно сохранить весь лог и получить полноценные именованные ветки, между которыми можно переключаться и продолжать работу.

Целевая модель повторяет разделение Pi session storage на immutable tree entries, durable named lanes и выбранный view:

```text
main: A → B → C → D
              └→ E → F :experiment
```

- `DurableLogRecord` — неизменяемый узел дерева с глобальным `seqId`, `parentId` и обязательным `branchId`;
- branch — durable именованный writable pointer `{ branchId, headSeqId }`, то есть публичное имя для Pi-подобного lane; отдельных сущностей branch и lane в Hyperchart нет;
- branches может быть много, у каждой свой movable durable head;
- fork — создаёт новый `branchId` с head в выбранной исторической точке, но **не выбирает и не запускает** его;
- checkout/view — недюрабл выбор branch handle для конкретной команды, runner или UI;
- rewind — durable перемещение head указанной ветки назад/вперёд без удаления прежних records;
- append через branch handle цепляется к head этой ветки и атомарно продвигает только её head.

После rewind `main` с `D` на `B` старый хвост остаётся в дереве:

```text
A → B            ← main head
     └→ C → D    ← сохранённая история
```

Следующий append в `main` создаёт sibling, не вычищая `C → D`:

```text
A → B → E        ← main head
     └→ C → D
```

Вернуться к старому хвосту можно недюрабл выбрать его в UI, затем подтверждённо переставить `main` на `D`, либо создать от `D` отдельный именованный fork. Никаких `branch_activated` machine facts нет: активность — свойство handle/view, не истории исполнения.

## Approach

### Единый append-only storage contract

Сделать `log.jsonl` типизированным append-only журналом storage mutations по модели Pi:

1. **record mutation** — существующий machine fact с `seqId`, `parentId`, `branchId`, `timestamp`;
2. **branch mutation** — служебная операция `create` или `move`, задающая durable head именованной ветки.

Branch mutations не являются `DurableLogRecord`, не участвуют в chart projection и не интерпретируются как научные/chart facts. Они находятся в том же сериализованном журнале, чтобы создание/перемещение head не имело crash window относительно machine records.

При открытии run журнал один раз нормализуется в:

- индекс machine records по `seqId`;
- registry `{ branchId → headSeqId }`;
- ancestry любой ветки;
- полное дерево для inspector;
- labels/metadata веток (имя, optional reason/source provenance) без понятия active branch.

Нормализатор проверяет ссылки и форму дерева один раз на границе чтения; нижележащие projection/runtime функции получают уже корректную структуру и не повторяют эти проверки.

Branch-aware run с самого первого record содержит `branchId` и созданную `main`. Старые линейные runs новым runtime не открываются и получают явную ошибку unsupported format; автоматической миграции, implicit `main` и смешанного старого/нового журнала нет.

### Fork, checkout и rewind

#### Fork

```ts
fork({ runDir, fromSeqId, branchId, reason? })
```

Append-only создаёт durable branch pointer на исторический record. Fork:

- не меняет head исходной ветки;
- не делает новую ветку активной;
- не запускает runner;
- допускает пустую ветку без собственных records;
- отклоняет повторный `branchId` и отсутствующий `fromSeqId`.

#### Checkout/view

```ts
run({ runDir, branchId: "experiment" })
inspect({ runDir, branchId: "main" })
```

Выбор branch handle передаётся явно и ничего не append-ит. UI может переключать отображаемую ветку сколько угодно без durable mutations. `status.json` может отражать branch текущего живого runner как operational status, но не является источником branch history.

#### Rewind

```ts
rewind({ runDir, branchId: "main", seqId: 42, mode: "after" })
```

`rewind` остаётся stopped-only и сохраняет selectors `state`, `seqId`, `to: "compatible"`, `mode`, но selector разрешается относительно ancestry указанной ветки. Операция append-only перемещает head этой ветки на target и:

- не создаёт новую ветку;
- не выбирает ветку для caller;
- не удаляет, не обрезает, не перемещает и не переписывает records, sessions, mailbox или artifacts;
- не создаёт `rewind-backups`;
- оставляет run остановленным;
- при `start: true` явно запускает именно `branchId` после успешного move.

### Replay, append и identity

Runtime получает обязательный branch handle (`main` используется как явный default при создании нового run), строит `head → parentId → root`, разворачивает ancestry и передаёт только её в `projectBranch()`/`explainReplay()`. Sibling records остаются доступны full-tree read side, но не влияют на projection выбранной ветки.

Stamping нельзя оставлять на `projection.seqId` (`packages/hyperchart/src/core/machine.ts:416–421`): после rewind projection заканчивается старым id, а физический журнал уже содержит большие ids. Serialized writer должен:

- брать следующий `seqId` из полного нормализованного журнала, а не из укороченной branch projection;
- ставить первому record batch `parentId = branches[branchId].headSeqId`;
- ставить каждому record `branchId` выбранного handle;
- сцеплять остальные records batch друг с другом;
- одним сериализованным commit append-ить records и продвижение head ветки;
- никогда не переиспользовать ids при rewind/fork/checkout.

Все изменения журнала проходят через одну очередь writer’а: пока один append/fork/rewind записывается, следующий ждёт. Если процесс упал посередине последней JSON-строки, при следующем открытии storage сохраняет последний полностью записанный перевод строки и отбрасывает только незавершённый хвост. Уже завершённые строки не переписываются. Затем журнал один раз нормализуется: resolver строит индекс и ancestry, проверяет ссылки `parentId`, существование branches и корректность `create`/`move`/append-from-head. После этого replay работает с готовой нормализованной веткой. Sibling records не считаются replay warning только потому, что не входят в выбранную ancestry.

`explainReplay()` проверяет только совместимость выбранной ancestry с текущим chart; проверку storage structure он не дублирует.

### Sessions, gates, notifications и artifacts

Ничего downstream не удаляется. Read-side связывает sessions и visits с `branchId` и invocation `seqId`, а не только с порядковым visit внутри линейного массива. Pending user gates, steering, terminal notifications и ответы валидируются относительно branch живого runner; gate из sibling ancestry остаётся инспектируемым, но не считается активным для другого branch handle.

External gate identity становится `(runId, branchId, seqId)`. Старый двухкомпонентный формат не поддерживается. Это исключает неоднозначность tooling/UI и позволяет явно отказать response не той ветке.

Artifact paths сохраняют существующую authored mutable-file семантику. Ветвление machine log само по себе не версионирует bytes артефактов: sibling executions могут перезаписать один путь. Это ограничение документируется и сохраняется как отдельная задача будущего artifact versioning; временный branch-safe path store не вводится. Rewind не обещает rollback файлов или внешних side effects; `cleanupSessions` и `cleanupArtifacts` удаляются из API.

### Concurrency and durability

Fork, rewind, branch append и runner start используют единый exclusive run-writer claim. Fork/rewind требуют stopped run. Writer открывает уже нормализованный журнал, последовательно выполняет одну mutation/batch и только затем допускает следующую. Поэтому два процесса не могут одновременно продвинуть один branch head или вычислить один и тот же следующий `seqId`.

Несколько branches (то есть named lanes) могут существовать и инспектироваться одновременно, но один run directory исполняется только одним runner process: runner получает один branch handle и двигает head только этой ветки. Branch и lane не моделируются двумя реестрами или двумя API.

## Files to modify

Критический core/runtime:

- `packages/hyperchart/src/core/durable_events.ts` — добавить `branchId` к новым machine records; отделить machine payload от storage mutation envelope.
- `packages/hyperchart/src/runtime/generic/log_store.ts` — append-only reducer, одноразовая нормализация, branch registry, ancestry/full-tree queries, record numbering, batch/head commit, writer claim и восстановление незавершённой последней строки.
- `packages/hyperchart/src/core/machine.ts` — убрать branch-local stamping и выдавать writer’у unstamped drafts.
- `packages/hyperchart/src/core/execution_loop.ts` — replay выбранного branch ancestry.
- `packages/hyperchart/src/core/replay_check.ts` — chart compatibility только для выбранной ancestry с корректными record coordinates.
- `packages/hyperchart/src/runtime/generic/rewind.ts` — branch-aware selector и durable head move вместо backup/truncate/cleanup.
- Новый generic branch runtime module рядом с `rewind.ts` — create/list/get branch operations и общий target resolver.
- `packages/hyperchart/src/runtime/generic/runner_main.ts`, `chart_runtime.ts`, `runtime/runtime.ts` — обязательный branch handle, нормализованный tree input и writer-backed append.
- `packages/hyperchart/src/inspect/run_inspect.ts` и host adapters — выбранная projection плюс full branch/tree metadata.
- Session progress, user interaction и terminal notification modules под `packages/hyperchart/src/runtime/generic/` — branch-scoped identity/activity.

Host/UI:

- `packages/pi-hyperchart/extensions/hyperchart.ts` — `branchId` у run/inspect/rewind, branch list/fork operations, убрать destructive cleanup wording/options.
- `packages/claude-hyperchart/src/mcp/tools.ts` — тот же MCP contract.
- React inspector под `packages/hyperchart/src/react/` — full tree, branch heads, недюрабл branch selection, explicit fork/rewind confirmation.
- TUI под `packages/pi-hyperchart/src/tui/` — branch list/current runner branch и навигация по tips.
- `packages/hyperchart/src/runtime/index.ts` и package public exports.

Tests/formal/docs:

- `tests/log_store.test.ts`, `tests/rewind.test.ts`, `tests/replay_check.test.ts`, `tests/hyperchart_runner_replay.test.ts`.
- `tests/user_interactions.test.ts`, `tests/hyperchart_extension.test.ts`, Claude MCP tests, run inspection/host adapter tests.
- Storybook fixtures/stories, которые предполагают `parentId = seqId - 1`.
- `tla/Hyperchart.tla`, `tla/HyperchartTrace.tla`, `tla/trace/export-trace.mjs`, `tla/trace/validate.sh` и model-check fixtures.
- `docs/safety.md`, `docs/reference.md`, `docs/api/{core,runtime,host,pi}.md`, `docs/pi.md`, `README.md`, package READMEs и `skills/pi/SKILL.md`.
- `autodiscovery-storage-notes.md` и canonical `/Users/vyacheslavshebanov/Work/surprisal/autodiscovery/AUTODISCOVERY-DESIGN.md`.

## Reuse

- Существующий `parentId` в `packages/hyperchart/src/core/durable_events.ts` остаётся ancestry edge.
- `findRewindMatch()` и `semanticStatesForRecord()` из `runtime/generic/rewind.ts` переиспользуются над выбранной ancestry.
- `createBranchProjection()`/`projectBranch()` не получают storage mutations; меняется подготовка input chain, а не chart DSL.
- `explainReplay()` остаётся chart compatibility checker.
- Run ownership/liveness checks текущего rewind сохраняются и усиливаются writer claim.
- Pi `SessionStorage` используется как прямой архитектурный образец: named lanes, `createLane`, `moveLane`, `view(lane)`, `findEntriesOnBranch`, последовательная JSONL-запись и восстановление незавершённой последней строки. В Hyperchart эта сущность называется только `branch`: `fork` соответствует созданию named lane, `rewind` — move её head, checkout — `view(branchId)`. Hyperchart также добавляет обязательный `branchId` к machine records для provenance, инспекции и branch-scoped внешних сущностей.

## Steps

- [ ] 1. Зафиксировать публичные types storage mutations, `BranchId`, branch metadata/head и selected branch handle; новый формат не принимает старые линейные runs.
- [ ] 2. Реализовать append-only log reducer с одноразовой нормализацией, registry нескольких именованных branches и ancestry/full-tree queries.
- [ ] 3. Добавить exclusive writer claim, numbering от полного журнала, record-batch/head commit и восстановление незавершённой последней строки.
- [ ] 4. Перенести stamping из machine в writer; новые records получают обязательный `branchId` и parent от durable head выбранной ветки.
- [ ] 5. Перевести execution loop, runner, replay diagnostics и terminal outcome на явно выбранную branch ancestry.
- [ ] 6. Реализовать branch list/get/fork: fork создаёт durable branch pointer и никогда не меняет caller selection или source head.
- [ ] 7. Переписать rewind как durable move head указанной ветки без удаления/backup/cleanup; поддержать возврат к sibling tip.
- [ ] 8. Сделать sessions, visit counting, gates, steering и notifications branch-scoped; старые identity formats не поддерживать.
- [ ] 9. Зафиксировать ограничение: артефакты пока не версионируются и сохраняют authored mutable paths; не вводить временный branch-safe artifact store.
- [ ] 10. Обновить Pi/Claude tool contracts и public exports: explicit `branchId`, list/fork/rewind/run/inspect, без `branch_activated` и cleanup API.
- [ ] 11. Добавить Inspector/TUI navigation: именованные heads, full tree, недюрабл checkout и отдельные подтверждаемые fork/rewind actions.
- [ ] 12. Обновить TLA+/trace contract: named branch registry, movable heads, numbering от полного журнала, append-from-head и non-durable selection.
- [ ] 13. Обновить docs, skill и AutoDiscovery design; полностью удалить утверждения о truncate/backups как актуальной rewind semantics.

## Verification

- Format boundary: старый линейный run отклоняется явной unsupported-format ошибкой; новый run с первого record имеет `main` и `branchId`.
- Fork: `main A→B→C`; fork `experiment` from `B` не меняет `main`, не меняет selected UI branch и существует до первого собственного record.
- Branch execution: явный run `experiment` создаёт `D(branchId=experiment,parent=B)`, а `main` продолжает replay `A,B,C`.
- Rewind: move `main` from `C` to `B`, append `E`, затем move `main` обратно на `C` и append `F`; все records сохранены, обе проекции корректны.
- Checkout: многократное переключение Inspector между `main`/`experiment` не меняет bytes `log.jsonl`; только fork/rewind/append создают storage mutations.
- Crash/concurrency: незавершённая последняя строка отбрасывается до нормализации; два competing writers выполняются последовательно и не теряют branch head.
- Replay: несовместимый sibling не блокирует совместимую выбранную ветку; storage corruption блокирует запуск до chart replay.
- Sessions/gates: sibling transcripts видимы, но gate response принимается только с точным `(runId, branchId, seqId)` и branch живого runner.
- Artifacts: runtime не меняет authored paths; документация явно предупреждает, что sibling invocations могут перезаписывать файлы до реализации полноценного artifact versioning.
- UI/Storybook: отображаются дерево и несколько named heads; fork не переключает selection; checkout не пишет; rewind явно двигает только выбранный branch head.
- Formal: `tla/check.sh` и `tla/trace/validate.sh` проходят для branch creation/move, append-from-head и fork-without-activation; structural references проверяются нормализатором один раз при чтении.
- Full repository: `npm run check` и `npm run build-storybook`.

## Design boundaries

- В публичной и внутренней модели Hyperchart branch и lane — одна сущность; термин `lane` отдельно не экспортируется.
- `branchId` обязателен для всех новых machine records и является durable provenance.
- Branches может быть много, у каждой durable movable head; текущий selected/visible branch недюрабл.
- Fork создаёт ветку, но никогда не активирует её.
- Rewind двигает head существующей ветки, сохраняя весь прежний хвост.
- В run допускается много branches, но только один live runner process одновременно.
- External side effects не объявляются откаченными и требуют idempotency/reconciliation.
- Rewind никогда не удаляет и не GC-ит sibling history.
