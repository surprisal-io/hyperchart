# Host and React integration

Use the core package to produce canonical chart/run models. Use the Pi package when the host is Pi or when you want the bundled React UI.

## Package boundary

| Package | Browser-safe parts | Node/runtime parts |
|---|---|---|
| `@surprisal/hyperchart` | normalized types, inspection models, host models/adapters | module loading, machine, replay, generic runtime |
| `@surprisal/pi-hyperchart` | React entry point and CSS | Pi extension, runner, TUI, Pi host adapter |

Do not import Node-only root or internal modules into browser bundles. The normalized AST inspector is browser-safe; chart module loading is not.

## Host models

Import canonical models from:

```ts
import type {
  HyperchartInfo,
  HyperchartRunInfo,
  HyperchartRunSummaryInfo,
  HyperchartSessionSnapshot,
  HyperchartHostAdapter,
} from "@surprisal/hyperchart/host";
```

`HyperchartInfo` describes a full discovered chart model, including optional serializable launch argument metadata. `HyperchartRunInfo` combines static chart information with optional runtime overlays and keeps that definition metadata in `launchArgs`, separate from concrete run `args`. `HyperchartRunSummaryInfo` is the graph-free scalar list/card model returned in `HyperchartSessionSnapshot`. Its optional `originSessionId` lets harnesses isolate runs by creating session. UI components consume these models instead of reading `log.jsonl` directly.

The boundary is intentional:

- static source, contracts, schemas, and topology come from normalized chart inspection;
- status, visits, resolved invocations, artifacts, usage, and replay issues come from a concrete run;
- active map actions held behind a `concurrency` gate use `waiting`, while only admitted/invoked work uses `running`;
- host-specific files are adapted once, outside React.

## Implement a host adapter

A host adapter separates lightweight session lists from full inspector loads:

```ts
import type {
  HyperchartHostAdapter,
  HyperchartInfo,
  HyperchartRunInfo,
  HyperchartSessionSnapshot,
} from "@surprisal/hyperchart/host";

export class MyHyperchartHost implements HyperchartHostAdapter {
  async readSessionSnapshot(
    cwd: string,
    options?: { runLimit?: number },
  ): Promise<HyperchartSessionSnapshot> {
    const hypercharts = await discoverChartSummaries(cwd);
    const runs = await readRunSummaries(cwd, options?.runLimit);
    return { hypercharts, runs };
  }

  async readChartSnapshot(
    cwd: string,
    chartName: string,
  ): Promise<HyperchartInfo | undefined> {
    return readFullDefinitionForLaunch(cwd, chartName);
  }

  async readRunSnapshot(
    cwd: string,
    runId: string,
  ): Promise<HyperchartRunInfo | undefined> {
    return readFullRunForInspector(cwd, runId);
  }
}
```

The adapter owns discovery and host I/O. It should:

1. resolve charts and runs for the supplied working directory;
2. enforce run ownership/scope;
3. use normalized static inspection;
4. adapt runtime facts and operational files into canonical models;
5. preserve static/runtime separation;
6. surface malformed files as typed issues rather than silently dropping them.

## Use the Pi host adapter

The Pi package exports a ready adapter:

```ts
import {
  createPiHyperchartHost,
  piHyperchartHost,
} from "@surprisal/pi-hyperchart/pi-host";

const snapshot = await piHyperchartHost.readSessionSnapshot(process.cwd(), {
  runLimit: 20,
});
```

`readSessionSnapshot` is intentionally summary-only: it contains no chart launch `args`, chart `states`, runtime state arrays, visit histories, prompts, schemas, session objects, or transcript messages. The Pi adapter statically scans source metadata and reads persisted run metadata/status without evaluating chart modules, constructing graphs, or replaying logs. Literal ids and state counts are included when they are statically visible; graph-derived definition/run fields are omitted when they are not. When launch or definition inspection opens, call `readChartSnapshot(cwd, chartName)` and pass its `args` directly to `HyperchartLaunchDialog`; only that selected module is inspected, using project-over-shared-over-user precedence. When a full embedded run inspector opens, call `readRunSnapshot(cwd, runId)`. Keep either full model scoped to its open UI and discard it on close.

Use `createPiHyperchartHost()` when you need explicit configuration or an isolated instance. Use `piHyperchartHost` for normal process-wide access.

## Adapt existing data

The host entry point exports adapters for common sources:

```ts
import {
  hyperchartRunFromInfo,
  hyperchartRunFromInspectResult,
  hyperchartRunFromRuntime,
  hyperchartRunFromToolDetails,
} from "@surprisal/hyperchart/host";
```

Use the adapter matching the data you actually have. Do not fabricate runtime fields for a static inspect result. `hyperchartRunFromInspectResult()` copies chart metadata to `launchArgs` while leaving concrete `args` empty unless the caller supplies them.

## Install the React UI

Install the Pi package and its UI peers in the host application:

```sh
npm install @surprisal/pi-hyperchart \
  react react-dom @xyflow/react elkjs react-syntax-highlighter
```

Import components from one entry point and one stylesheet:

```tsx
import {
  HyperchartInspectorDialog,
  HyperchartRunStrip,
  HyperchartUiThemeProvider,
} from "@surprisal/hyperchart/react";
import "@surprisal/hyperchart/react/styles.css";
```

Do not import component files or React Flow CSS separately. `styles.css` contains the complete public stylesheet contract, including scoped React Flow styles.

## Render a run strip from the session snapshot

```tsx
import { HyperchartRunStrip } from "@surprisal/hyperchart/react";
import type { HyperchartSessionSnapshot } from "@surprisal/hyperchart/host";

export function WorkflowStrip({
  snapshot,
  openInspector,
}: {
  snapshot: HyperchartSessionSnapshot;
  openInspector: (runId: string) => void;
}) {
  return (
    <HyperchartRunStrip
      hypercharts={snapshot.hypercharts}
      runs={snapshot.runs}
      onOpenInspector={(runId) => {
        if (runId !== null && runId !== undefined) openInspector(runId);
      }}
    />
  );
}
```

Pass the canonical summary arrays directly; `HyperchartSummaryInfo.stateCount` and all run progress fields may be absent. The strip hides progress unless `progressDone`, `progressTotal`, and `progressPercent` are all present, while preserving independently known status and running-state labels. When `openInspector` runs, call `readRunSnapshot(cwd, runId)` and give that full result to `HyperchartInspectorDialog`; do not pass the summary run to the inspector.

Supply `onResume`, `onAbort`, or launch callbacks only when the host implements those operations. The inspector renders concurrency-gated map states and items as `waiting`; they do not expose a session until the runtime admits and invokes them. Agent cards render declared `role`/`toolset` plus `resolvedModel`/`resolvedTools` from the host snapshot, but no session controls. When a concrete run snapshot includes `state.session`, the selected state's `Runtime` section exposes the live-session dialog and expands automatically while the session is live. Provide `onSteerSession` to enable the dialog composer and route `(runId, actionKey, message)` to the matching active agent; without it, the transcript remains read-only. The UI does not mutate run files by itself.

## Public React components

| Export | Purpose |
|---|---|
| `HyperchartInspectorDialog` | full modal inspector for one or more runs, including live agent sessions and optional steering |
| `HyperchartInspectorSidePanel` | details panel without the surrounding dialog |
| `HyperchartGraphPreview` | chart graph and runtime overlay |
| `HyperchartRunStrip` | compact list of active/recent runs |
| `HyperchartToolSummary` | summary for Hyperchart tool results |
| `HyperchartLaunchDialog` | launch form for discovered charts |
| `HyperchartPortalProvider` | portal target for nested host modal stacks |
| `HyperchartUiThemeProvider` | explicit light/dark theme contract |

Graph helpers such as `buildGraph`, `immediateMapScopeId`, and `visibleStateIdsForScope` are also public from the React entry point.

## Theme

Wrap the UI when the host already owns theme state:

```tsx
<HyperchartUiThemeProvider
  theme={{ resolved: "light", themeName: "base" }}
>
  <WorkflowView runs={runs} />
</HyperchartUiThemeProvider>
```

`resolved` is `"light"` or `"dark"`. The provider avoids relying on global body classes that may belong to another application.

Tailwind Preflight is scoped to `[data-hyperchart-root]`. Hyperchart does not reset the rest of the host page.

## Portals and modal stacks

By default, dialogs portal to the document. In an application with its own modal layer, provide a portal renderer:

```tsx
import { createPortal } from "react-dom";

<HyperchartPortalProvider
  portal={(children) => createPortal(children, modalLayerElement)}
>
  <WorkflowView runs={runs} />
</HyperchartPortalProvider>
```

Use one portal boundary around the Hyperchart subtree. Nested dialogs, full-content previews, and launch/inspector overlays inherit it.

## Server rendering

The public React entry point is safe to import during SSR. Browser-dependent behavior is deferred until render/effect time.

Practical rules:

- import the stylesheet from the client application entry;
- render dialogs only when the host has a DOM;
- avoid reading run directories in React components;
- perform Node discovery and adaptation on the server/host side;
- pass serializable canonical models to the client.

## Content previews

The inspector bounds large prompts, command text, JSON, schemas, and definitions before syntax rendering. Truncated content shows `Open full`; the full value is mounted only after the user opens the dialog.

For an open inspector, hosts should request and pass complete canonical data through `readRunSnapshot` (or `hyperchartRunFromRunDir(..., { includeTranscripts: true })` inside a host adapter). Do not pre-truncate fields unless the transport itself requires a limit, because the inspector owns display truncation and full-content access. Routine background/session snapshots must use only the summary list API and must not retain any full run model.

## Accessibility and responsive behavior

The components provide dialog semantics, keyboard close behavior, labelled graph controls, and responsive graph/detail layouts. The host remains responsible for:

- placing focus into the surrounding application correctly;
- selecting a portal layer with the expected z-index;
- ensuring callbacks do not close unrelated host dialogs;
- testing at the host's actual breakpoints and font scale.

The repository's Storybook boards cover light/dark themes, mobile layouts, long content, validation issues, maps, parallel states, and runtime history.

## Next steps

- [Host-neutral runtime contract](runtime-and-durability.md)
- [Pi commands and run files](pi.md)
- [Host API](api/host.md)
- [React API](api/react.md)
