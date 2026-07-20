# React API

```tsx
import {
  HyperchartInspectorDialog,
  HyperchartPortalProvider,
  HyperchartUiThemeProvider,
  type HyperchartRunInfo,
} from "@surprisal/pi-hyperchart/react";
import "@surprisal/pi-hyperchart/react/styles.css";
```

React is part of `@surprisal/pi-hyperchart`; there is no third package.

## Requirements

The React entry point expects peer dependencies compatible with:

- React 19;
- React DOM 19;
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

The dialog owns run selection, graph navigation, state detail selection, responsive layout, and nested full-content dialogs. Agent cards with `state.session` show `View session`, which opens a compact transcript with completed reasoning, throttled live reasoning/text, and current-tool activity. Completed reasoning and tool/read entries start collapsed with a two-line preview and an ellipsis when content is hidden; user and assistant messages stay fully visible, as do currently streaming blocks. Each tool call and its result render as one lifecycle card with loading, complete, or error status. The session dialog grows with its transcript up to its viewport cap rather than reserving a fixed empty height; once assistant text or a tool starts, the preceding live reasoning becomes a normal collapsible reasoning block. Supplying `onSteerSession` enables its steering composer; the host must deliver the message to the matching live session. The component does not fetch data or mutate runs itself. The exported component is memoized; hosts should preserve `runs` and callback references when a poll produces no semantic change so shallow equality can skip the inspector subtree.

```tsx
<HyperchartInspectorDialog
  runs={snapshot.runs}
  selectedRunId={selectedRunId}
  onSelectRun={setSelectedRunId}
  onClose={() => setOpen(false)}
  onResume={(runId) => resumeRun(runId)}
  portal={(children) => createPortal(children, document.body)}
  theme={{ resolved: "light" }}
/>
```

Historical `HyperchartRunInfo` values are treated as immutable snapshots. While the modal inspector is open, the public stylesheet pauses CSS animations in sibling application roots under `body`; visible animations inside the inspector continue normally.

## `HyperchartInspectorSidePanel`

```tsx
interface HyperchartInspectorSidePanelProps {
  run: HyperchartRunInfo;
  selectedStateId?: string | null;
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
  hypercharts: HyperchartInfo[];
  runs: HyperchartRunInfo[];
  selectedRunId?: string | null;
  onSelectRun?: (runId: string | null) => void;
  onRun?: (chartName: string) => void;
  onOpenDefinition?: (chart: HyperchartInfo) => void;
  onResume?: (runId: string) => void;
  onAbort?: () => void;
  onOpenInspector?: (runId?: string | null) => void;
}

function HyperchartRunStrip(
  props: HyperchartRunStripProps,
): React.ReactElement | null;
```

Shows the selected or running run, progress, usage, active states, up to five recent runs, and a dialog for additional runs/definitions. Returns `null` when no run is available. The component is memoized and follows the same immutable-array and stable-callback reference contract as the inspector.

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
  args?: Record<string, unknown>;
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

Collects JSON argument text and returns the raw text through `onSubmit`; the host owns parsing, validation, and execution.

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

Builds React Flow nodes and transition edges. Without layout positions it uses a deterministic vertical fallback. The inspector's hook applies ELK layout separately. States selected by a root or nested `initial` declaration display an `initial` badge independently from their runtime status; final nodes remain `pending` until reached. Running transitions keep the SVG path static and move a separate HTML marker with precomputed `transform` keyframes, avoiding React Flow's repaint-heavy `stroke-dashoffset` animation.

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

Time formatters return `—` for missing/zero timestamps and use host locale. Progress combines completed visits on actual run path with shortest remaining transition path from current state to any final state. Reaching any final outcome forces `pct: 100`, including failure finals. Inspector and run strip render progress bar without `done/total states` counters. Usage displays total tokens and cost when positive.

## Data adapters and model types

The React entry point re-exports:

```text
hyperchartRunFromInfo
hyperchartRunFromInspectResult
hyperchartRunFromRuntime
hyperchartRunFromToolDetails
```

It also re-exports every type from `@surprisal/hyperchart/host`, including `HyperchartInfo`, `HyperchartRunInfo`, and `HyperchartStateInfo`. See [Host API](host.md).

## Complete React export inventory

```text
HyperchartInspectorDialog, HyperchartInspectorDialogProps
HyperchartInspectorSidePanel, HyperchartInspectorSidePanelProps
HyperchartGraphPreview, buildGraph
immediateMapScopeId, visibleStateIdsForScope
HyperchartRunStrip, HyperchartRunStripProps
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
