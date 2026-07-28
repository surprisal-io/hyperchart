# React API

```tsx
import {
  HyperchartInspectorDialog,
  HyperchartPortalProvider,
  HyperchartUiThemeProvider,
  type HyperchartRunInfo,
} from "@surprisal/hyperchart/react";
import "@surprisal/hyperchart/react/styles.css";
```

The React surface ships in the core package; `@surprisal/pi-hyperchart/react` remains as a compatibility re-export.

React is part of `@surprisal/pi-hyperchart`; there is no third package.

## Requirements

The React entry point expects peer dependencies compatible with:

- React 18 or 19;
- React DOM 18 or 19;
- `@xyflow/react` 12;
- ELK.js 0.11;
- `react-syntax-highlighter` 16.

Import only the public stylesheet above. It includes React Flow styles and scopes Tailwind Preflight and component rules under `[data-hyperchart-root]`.

## `HyperchartInspectorDialog`

```tsx
interface HyperchartInspectorDialogProps {
  runs: HyperchartRunInfo[];
  selectedRunId?: string | null;
  onSelectRun?: (runId: string | null) => void;
  onClose: () => void;
  onResume?: (runId: string) => void;
  onAbort?: () => void;
  onSteerSession?: (
    runId: string,
    actionKey: string,
    message: string,
  ) => void | Promise<void>;
  portal?: HyperchartPortalRenderer;
  theme?: HyperchartUiTheme;
}

function HyperchartInspectorDialog(
  props: HyperchartInspectorDialogProps,
): React.ReactElement;
```

The dialog owns run selection, graph navigation, state detail selection, responsive layout, and nested full-content dialogs. The selected state's run-specific `Runtime` section keeps a latest-session card from `state.session` and adds an independent `View session` control to every `visitHistory` entry that has its own `visit.session`; live latest sessions expand `Runtime` by default. This preserves every visit's transcript instead of making repeated visits point at the newest session. Agent cards show declared definition metadata (`role`, `toolset`, fallbacks) and resolved host configuration (`resolvedModel`, `resolvedTools`) but no session controls, so reusing one agent across states or runs cannot make its operational transcript look like static configuration. `View session` opens a compact transcript with its role/model/thinking/toolset/tool launch plan, completed reasoning, throttled live reasoning/text, and current-tool activity. Completed reasoning and tool/read entries start collapsed with a two-line preview and an ellipsis when content is hidden; user and assistant messages stay fully visible, as do currently streaming blocks. Each tool call and its result render as one lifecycle card with loading, complete, or error status. The session dialog grows with its transcript up to its viewport cap rather than reserving a fixed empty height; once assistant text or a tool starts, the preceding live reasoning becomes a normal collapsible reasoning block. Supplying `onSteerSession` enables its steering composer; the host must deliver the message to the matching live session. Historical sessions remain read-only because their status is not live. The component does not fetch data or mutate runs itself. The exported component is memoized; hosts should preserve `runs` and callback references when a poll produces no semantic change so shallow equality can skip the inspector subtree.

```tsx
import { useEffect, useState } from "react";
import type {
  HyperchartHostAdapter,
  HyperchartRunInfo,
} from "@surprisal/hyperchart/host";

function RunInspector({
  host,
  cwd,
  selectedRunId,
  onClose,
}: {
  host: HyperchartHostAdapter;
  cwd: string;
  selectedRunId: string | null; // non-null only while the inspector is open
  onClose: () => void;
}) {
  const [inspectorRun, setInspectorRun] =
    useState<HyperchartRunInfo>();

  useEffect(() => {
    setInspectorRun(undefined);
    if (selectedRunId === null) return;

    let cancelled = false;
    void host.readRunSnapshot(cwd, selectedRunId).then((run) => {
      if (!cancelled) setInspectorRun(run);
    });
    return () => {
      cancelled = true;
    };
  }, [host, cwd, selectedRunId]);

  if (selectedRunId === null || inspectorRun === undefined) return null;
  return (
    <HyperchartInspectorDialog
      runs={[inspectorRun]}
      selectedRunId={selectedRunId}
      onClose={() => {
        setInspectorRun(undefined);
        onClose();
      }}
      portal={(children) => createPortal(children, document.body)}
      theme={{ resolved: "light" }}
    />
  );
}
```

Keep the full `HyperchartRunInfo` in inspector-local state as above. Do not pass `readSessionSnapshot().runs` summaries to the inspector; load the full run only after it opens and discard it on close.

Historical `HyperchartRunInfo` values are treated as immutable snapshots. While the modal inspector is open, the public stylesheet pauses CSS animations in sibling application roots under `body`; visible animations inside the inspector continue normally.

## `HyperchartInspectorSidePanel`

```tsx
interface HyperchartInspectorSidePanelProps {
  run: HyperchartRunInfo;
  selectedStateId?: string | null;
  onClearSelection?: () => void;
  onOpenScope?: (stateId: string) => void;
  onSteerSession?: (
    actionKey: string,
    message: string,
  ) => void | Promise<void>;
  className?: string;
  definitionSource?: string;
}

function HyperchartInspectorSidePanel(
  props: HyperchartInspectorSidePanelProps,
): React.ReactElement;
```

Renders run overview or one selected state's full details without the outer dialog or graph. `Agents in scope` keeps first state for each unique `state.agent` name, preserving source order across map and parallel instances. Compound selections omit aggregated descendant `Contracts in scope`; selecting an action state still shows its own contracts. `definitionSource` overrides generated source for the active view.

## `HyperchartGraphPreview`

```tsx
function HyperchartGraphPreview(props: {
  run: HyperchartRunInfo;
  className?: string;
}): React.ReactElement;
```

Renders a read-only, auto-laid-out React Flow graph. The default class is `h-72`.

```tsx
<HyperchartGraphPreview run={run} className="h-[36rem]" />
```

## `HyperchartRunStrip`

```tsx
interface HyperchartRunStripProps {
  hypercharts: HyperchartSummaryInfo[];
  runs: Array<HyperchartRunInfo | HyperchartRunSummaryInfo>;
  selectedRunId?: string | null;
  onSelectRun?: (runId: string | null) => void;
  onRun?: (chartName: string) => void;
  onOpenDefinition?: (chart: HyperchartSummaryInfo) => void;
  onResume?: (runId: string) => void;
  onAbort?: () => void;
  onOpenInspector?: (runId?: string | null) => void;
}

function HyperchartRunStrip(
  props: HyperchartRunStripProps,
): React.ReactElement | null;
```

Shows the selected or running run, available progress/usage/active-state metadata, up to five recent runs, and a dialog for additional runs/definitions. Pass `readSessionSnapshot().hypercharts` directly: the strip and its More dialog type chart entries as canonical `HyperchartSummaryInfo`, including summaries whose optional `stateCount` is absent. Full `HyperchartInfo` values remain structurally assignable, but the callbacks expose only the summary contract.

It accepts lightweight `HyperchartRunSummaryInfo` values directly, including metadata-only summaries where graph-derived fields are absent, so dashboard session state does not need a full graph/runtime snapshot. Summary progress is rendered only when `progressDone`, `progressTotal`, and `progressPercent` are all present; omitted or partial metadata hides the bar rather than implying 0%. Independently known status and active-state labels remain visible. Fetch a separate `HyperchartRunInfo` only when opening the inspector. Returns `null` when no run is available. The component is memoized and follows the same immutable-array and stable-callback reference contract as the inspector.

## `HyperchartToolSummary`

```tsx
interface HyperchartToolSummaryProps {
  toolName: string;
  args?: Record<string, unknown>;
  status: "running" | "done" | "error" | string;
  details?: unknown;
  runs?: HyperchartRunInfo[];
  onOpenRun?: (runId: string) => void;
}

function HyperchartToolSummary(
  props: HyperchartToolSummaryProps,
): React.ReactElement;
```

Adapts `hyperchart_*` tool details through `hyperchartRunFromToolDetails()`, falls back to matching persisted runs, and lazily loads the inspector only when opened.

## `HyperchartLaunchDialog`

```tsx
interface HyperchartLaunchDialogProps {
  chartName: string;
  description?: string;
  args?: Readonly<Record<string, HyperchartLaunchArgumentInfo>>;
  submitLabel?: string;
  placeholder?: string;
  onSubmit: (argsText: string) => void;
  onCancel: () => void;
  onOpenGraph?: () => void;
  portal?: HyperchartPortalRenderer;
}

function HyperchartLaunchDialog(
  props: HyperchartLaunchDialogProps,
): React.ReactElement;
```

Collects JSON argument text and returns the raw text through `onSubmit`; the host owns parsing, validation, and execution. Each `args` entry may contain a serializable `description` and JSON `default`. The current JSON editor uses defaults to build its placeholder; custom host forms may also render descriptions. Do not pass concrete `HyperchartRunInfo.args` here.

Load metadata only when launch opens:

```tsx
const definition = await host.readChartSnapshot(cwd, chartName);
<HyperchartLaunchDialog
  chartName={chartName}
  args={definition?.args}
  onSubmit={launch}
  onCancel={close}
/>;
```

This is the minimal dashboard integration: no CST parsing or chart-module export convention is required.

## Portals

```ts
type HyperchartPortalRenderer = (
  children: React.ReactNode,
) => React.ReactPortal | React.ReactNode;
```

### `HyperchartPortalProvider`

```tsx
function HyperchartPortalProvider(props: {
  children: React.ReactNode;
  portal?: HyperchartPortalRenderer;
}): React.ReactElement;
```

Provides portal rendering to all nested Hyperchart dialogs. When omitted, it inherits the nearest provider.

```tsx
<HyperchartPortalProvider portal={(children) => createPortal(children, overlayRoot)}>
  <HyperchartInspectorSidePanel run={run} />
</HyperchartPortalProvider>
```

`HyperchartInspectorDialog` and `HyperchartLaunchDialog` also accept `portal` directly and create the provider internally.

## Theme

```ts
interface HyperchartUiTheme {
  resolved?: "light" | "dark";
  themeName?: string;
}
```

### `HyperchartUiThemeProvider`

```tsx
function HyperchartUiThemeProvider(props: {
  children: React.ReactNode;
  theme?: HyperchartUiTheme;
}): React.ReactElement;
```

Merges provided values with the nearest provider. `resolved` controls the inspector palette through `data-theme`; `themeName` is available to host integrations.

```tsx
<HyperchartUiThemeProvider theme={{ resolved: "dark", themeName: "app-dark" }}>
  <HyperchartGraphPreview run={run} />
</HyperchartUiThemeProvider>
```

## Graph helpers

### `buildGraph()`

```ts
function buildGraph(
  run: HyperchartRunInfo,
  visibleIds: Set<string>,
  layoutPositions?: Map<string, { x: number; y: number }>,
  layoutRoutes?: Map<string, Array<{ x: number; y: number }>>,
): {
  nodes: import("@xyflow/react").Node[];
  edges: import("@xyflow/react").Edge[];
};
```

Builds React Flow nodes and transition edges. Without layout positions it uses a deterministic vertical fallback. The inspector's hook applies ELK layout separately. States selected by a root or nested `initial` declaration display an `initial` badge independently from their runtime status; final nodes remain `pending` until reached. Concurrency-gated map actions use the amber `waiting` status until their invoke is admitted, instead of presenting them as active sessions. Running transitions keep the SVG path static and move a separate HTML marker with precomputed `transform` keyframes, avoiding React Flow's repaint-heavy `stroke-dashoffset` animation.

### `immediateMapScopeId()`

```ts
function immediateMapScopeId(stateId: string): string | undefined;
```

Returns the immediate containing scope:

- `chapters#intro.write` → `chapters`;
- `pipeline.review` → `pipeline`;
- `root` → `undefined`.

Despite the historical name, it also returns the immediate dotted parent for non-map nested states.

### `visibleStateIdsForScope()`

```ts
function visibleStateIdsForScope(
  states: HyperchartStateInfo[],
  options?: {
    scopeId?: string | null;
    showDone?: boolean;
    showPending?: boolean;
    showSkipped?: boolean;
    showMapWorkers?: boolean;
  },
): Set<string>;
```

Defaults:

```ts
{
  scopeId: null,
  showDone: true,
  showPending: true,
  showSkipped: false,
  showMapWorkers: false,
}
```

Implicit failure-final nodes are always hidden.

## Display helpers

```ts
function hyperchartStatusClasses(status: string): string;
function hyperchartStatusDotClass(status: string): string;
function hyperchartStatusIcon(status: string): React.ComponentType;
function formatHyperchartTime(timestamp?: number): string;
function formatHyperchartDateTime(timestamp?: number): string;
function summarizeHyperchartProgress(
  run?: HyperchartRunInfo,
): { done: number; total: number; pct: number };
function runningHyperchartStates(
  run?: HyperchartRunInfo,
): HyperchartStateInfo[];
function formatHyperchartUsage(
  usage?: HyperchartUsageInfo,
): string | null;
function hyperchartChartName(run: HyperchartRunInfo): string;
function hyperchartRunLabel(run: HyperchartRunInfo): string;
```

Time formatters return `—` for missing/zero timestamps and use host locale. Progress for a full run combines completed visits on the actual run path with the shortest remaining transition path from the current state to any final state. Reaching any final outcome forces `pct: 100`, including failure finals. For lightweight run summaries, the run strip renders progress only when `progressDone`, `progressTotal`, and `progressPercent` are all authoritative and present; partial or omitted progress metadata renders no bar or counts. Inspector and run strip render progress bars without `done/total states` counters. Usage displays total tokens and cost when positive.

## Data adapters and model types

The React entry point re-exports:

```text
hyperchartRunFromInfo
hyperchartRunFromInspectResult
hyperchartRunFromRuntime
hyperchartRunFromToolDetails
```

It also re-exports every type from `@surprisal/hyperchart/host`, including `HyperchartInfo`, `HyperchartSummaryInfo`, `HyperchartLaunchArgumentInfo`, `HyperchartRunInfo`, `HyperchartRunSummaryInfo`, and `HyperchartStateInfo`. See [Host API](host.md).

## Complete React export inventory

```text
HyperchartInspectorDialog, HyperchartInspectorDialogProps
HyperchartInspectorSidePanel, HyperchartInspectorSidePanelProps
HyperchartGraphPreview, buildGraph
immediateMapScopeId, visibleStateIdsForScope
HyperchartRunStrip, HyperchartRunStripInfo, HyperchartRunStripProps
HyperchartToolSummary, HyperchartToolSummaryProps
HyperchartLaunchDialog, HyperchartLaunchDialogProps
HyperchartPortalProvider, HyperchartPortalRenderer
HyperchartUiThemeProvider, HyperchartUiTheme
hyperchartChartName, hyperchartRunLabel
hyperchartStatusClasses, hyperchartStatusDotClass, hyperchartStatusIcon
formatHyperchartDateTime, formatHyperchartTime, formatHyperchartUsage
runningHyperchartStates, summarizeHyperchartProgress
all host model types and the four host adapter functions
HyperchartRunFromInspectOptions, HyperchartRunFromRuntimeOptions
HyperchartRuntimeSessionProgressFile, HyperchartRuntimeSessionProgressInfo
```
