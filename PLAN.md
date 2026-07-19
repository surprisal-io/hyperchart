# Storybook organization plan

## Context

The current Storybook mixes three concerns: editable component examples, product scenarios, and large visual/regression boards. The component stories have begun moving to typed CSF3 `args`, but `HyperchartBoards.stories.tsx` is still a 1,043-line fixture/generation/story file and the sidebar does not communicate which stories are public examples versus internal visual tests.

The goal is to adopt the organization used by projects such as GitHub Primer: a small default playground per component, separate feature/example stories, and clearly isolated development/visual-test boards. Existing visual coverage and fixture fidelity must be preserved.

## Approach

1. Establish a predictable sidebar taxonomy:
   - `Hyperchart/Components/*` — component API, default state, and Controls.
   - `Hyperchart/Features/*` — supported product states and interactive scenarios.
   - `Hyperchart/Examples/*` — realistic composed workflows/adapters.
   - `Hyperchart/Visual Tests/*` — atlases, state matrices, panel boards, and stress cases.
2. Keep CSF3 `Meta<typeof Component>` + `StoryObj<typeof meta>` and `args` as the default for direct component props. Use `render` only for composition or a controlled harness.
3. Split the inspector-panel monolith into story declarations, deterministic specs/fixtures, and runtime-to-view-model builders. Keep the existing story helper components rather than recreating board UI.
4. Preserve one focused playground per public component; hide non-editable fixture objects and callback props from Controls where editing them is not useful. Continue using `fn()` for observable actions.
5. Add small `play` interaction checks to the launch and inspector feature stories so their key behaviors are executable examples, without introducing a visual-regression service in this change.
6. Keep all story data deterministic and local. Replace story-time `Date.now()` usage with a stable fixture clock or a shared fixture factory that accepts `now`.

## Files to modify

### Storybook configuration

- `.storybook/preview.tsx` — deterministic story ordering matching the new taxonomy; retain the existing theme decorator and global color-scheme toolbar.
- `.storybook/main.ts` — only adjust story discovery if the split file naming requires it; retain React/Vite and Tailwind setup.

### Component and scenario stories

- `packages/pi-hyperchart/src/react/stories/HyperchartLaunchDialog.stories.tsx` — component playground and args-driven variants; add interaction coverage.
- `packages/pi-hyperchart/src/react/stories/HyperchartInspectorDialog.stories.tsx` — component playground only.
- `packages/pi-hyperchart/src/react/stories/HyperchartInspectorDialog.features.stories.tsx` — running, static-inspect, failed-validation, and controlled selection scenarios.
- `packages/pi-hyperchart/src/react/stories/Adapters.stories.tsx` — move under the Examples hierarchy while retaining the inspect-result adapter example.
- `packages/pi-hyperchart/src/react/stories/harnesses/InteractiveInspector.tsx` — retain as the controlled Storybook adapter and keep callback forwarding.

### Visual boards

- `packages/pi-hyperchart/src/react/stories/HyperchartGeneralBoards.stories.tsx` — split/rename into focused visual-test files for run-strip/content states, graph atlas/edges, and stress inspector.
- `packages/pi-hyperchart/src/react/stories/HyperchartBoards.stories.tsx` — replace with a thin inspector-panel story/index file.
- `packages/pi-hyperchart/src/react/stories/inspector-panel/specs.ts` — extracted panel groups, chart specs, and fixture definitions.
- `packages/pi-hyperchart/src/react/stories/inspector-panel/runtime.ts` — extracted AST/runtime generation and tile-prop builders.
- Existing files in `packages/pi-hyperchart/src/react/stories/components/` — update imports only as needed; preserve their rendering behavior.

### Fixtures

- `packages/pi-hyperchart/src/react/fixtures/hyperchart-fixtures.ts`
- `packages/pi-hyperchart/src/react/fixtures/hyperchart-board-fixtures.ts`

Make timestamps deterministic while preserving the same displayed relative ages and run states.

## Reuse

- `InteractiveInspector` in `packages/pi-hyperchart/src/react/stories/harnesses/InteractiveInspector.tsx` for controlled run selection.
- `BoardPage`, `BoardSection`, `GraphTile`, `InspectorPanelGroupBoard`, `ContentPreviewBoard`, and `RunStripBoardInner` from `packages/pi-hyperchart/src/react/stories/components/` for all visual boards.
- `singleStateRun` from `packages/pi-hyperchart/src/react/stories/components/singleStateRun.ts` for card-atlas cases.
- Existing run fixtures from `packages/pi-hyperchart/src/react/fixtures/` rather than creating parallel mock formats.
- Existing theme/provider decorator in `.storybook/preview.tsx`.
- `fn`, `userEvent`, `within`, and `expect` from the already available `storybook/test` entry point.

## Steps

- [x] Define the sidebar naming/order convention in `.storybook/preview.tsx` and update story titles to Components, Features, Examples, and Visual Tests.
- [x] Finalize Launch Dialog as an args-driven component playground, keep structured/freeform variants concise, configure useful Controls, and add a `play` check for submission/cancellation.
- [x] Keep Inspector Dialog’s default story focused on editable component inputs; move running/static/failed scenarios into `HyperchartInspectorDialog.features.stories.tsx` and reuse `InteractiveInspector` for controlled selection.
- [x] Move the adapter graph story into the Examples hierarchy and keep its generated `run` fixture non-editable in Controls.
- [x] Split general boards into focused visual-test story files without changing rendered layouts or fixture coverage.
- [x] Extract inspector-panel chart/spec data and runtime builders from the 1,043-line story file, leaving story exports as thin mappings over the existing `InspectorPanelGroupBoard`.
- [x] Stabilize fixture clocks/IDs so screenshots and interaction checks do not depend on wall-clock time.
- [x] Add story-level descriptions and disable irrelevant Controls on visual-test stories; retain Controls on component playgrounds.
- [x] Confirm every existing story state has a destination in the new hierarchy and remove obsolete story files only after parity is verified.

## Verification

- Run `npx tsc -p tsconfig.json --noEmit`.
- Run `npm run build-storybook` and confirm no story index/import errors.
- Run `npm run storybook -- --host 0.0.0.0` and manually verify both dark/light themes.
- Exercise Launch Dialog Controls and confirm submit/cancel/open-graph callbacks appear in Actions and the `play` interaction passes.
- Exercise Inspector Dialog run selection and failed-run resume; confirm the controlled harness updates the selected run and Actions receive callbacks.
- Compare the reorganized visual boards against the existing Card Atlas, edge matrix, run-strip states, content-preview states, stress inspector, and all eight inspector-panel groups.
- Reload representative stories to confirm timestamps and rendered fixture data remain stable.
