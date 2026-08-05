# Storybook product-surface organization

## Decision

Storybook is organized by the Hyperchart surface a user is inspecting, not by how a story is authored or tested.

- `Hyperchart/Inspector/*` — browser inspector surfaces and their fixed states.
- `Hyperchart/Launch/*` — launch UI.
- `Hyperchart/TUI/*` — terminal UI.

There are no `Components`, `Features`, `Examples`, `Visual Tests`, `Internal`, or `Playground` sections. Complex controls are disabled globally. Every story is a deterministic, named state; a `play` function adds interaction verification to that same story instead of creating a separate test hierarchy.

Actor stories live with the product surface they exercise:

- dialog behavior under `Inspector/Dialog/Actors`;
- actor nodes and edges under `Inspector/Graph/Actors`;
- actor details under `Inspector/State Details`.

Coverage matrices remain visible beside their surface (`Card Atlas`, `Edge Types`, state-detail boards, content preview). Stress stories are the final child of the corresponding Dialog or Graph surface. Adapter-only and editable giant-object playground stories are not part of Storybook.

All semantic Inspector stories render through production boundaries: real chart definitions are normalized and inspected; static stories use `hyperchartRunFromInspectResult`; runtime stories project replay-checked typed durable records through `hyperchartRunFromRuntime`. Hand-authored `HyperchartRunInfo`, state topology/status, actor/mailbox models, and failure issues are forbidden. Card/detail boards may focus adapter-derived models without cloning or mutation. Only presentation-only values (viewport, theme, overflow text, modal interaction, and explicit summary-transport omissions) remain manual.

## Files

Story filenames describe their product surface rather than their test mechanism. Suffixes such as `.features.stories` and `.visual.stories` are not used.

## Stability

Renamed CSF groups retain their previous explicit `meta.id` where a useful existing permalink existed. The visible title can therefore move without unnecessarily invalidating links.

## Verification

- No story title may contain `/Components/`, `/Features/`, `/Examples/`, `/Visual Tests/`, or `/Internal/`.
- No story may be named Playground.
- Storybook must build successfully.
- Interaction stories must run in the browser.
- Representative Inspector, Launch, and TUI stories must be checked in dark and light schemes.
