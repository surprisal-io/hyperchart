# Host adapter and React integration

Hyperchart separates canonical inspection models from host discovery and presentation. The core package contains the host-neutral model; the Pi package provides one implementation and React UI.

## Host-neutral snapshot contract

```ts
import type {
  HyperchartHostAdapter,
  HyperchartSessionSnapshot,
} from "@surprisal-io/hyperchart/host";
```

A host implements:

```ts
interface HyperchartHostAdapter {
  readSessionSnapshot(
    cwd: string,
    options?: HyperchartSnapshotOptions,
  ): Promise<HyperchartSessionSnapshot>;
}
```

A snapshot contains discovered chart definitions and concrete runs. Transport `snapshot.hypercharts` and `snapshot.runs` without converting them into a parallel model. The canonical types already distinguish static definition data, runtime status, issues, visits, fan-out progress, and usage.

Host adapters own:

- chart discovery and precedence;
- run storage and metadata;
- runtime/session status sources;
- agent-definition defaults;
- mapping durable facts to canonical host models.

Host adapters do not redefine machine semantics. Use `hyperchartRunFromRuntime()` and exported projection APIs.

## Pi host adapter

```ts
import {
  createPiHyperchartHost,
  piHyperchartHost,
} from "@surprisal-io/pi-hyperchart/pi-host";

const snapshot = await piHyperchartHost.readSessionSnapshot(cwd, {
  runLimit: 50,
});
```

`createPiHyperchartHost(options)` allows an explicit Pi agent directory or custom agent-default resolver. The adapter owns project/user `.pi/hypercharts` discovery, Pi runs, status/session files, and unavailable agent definitions. Failed run inspection is isolated so one damaged run does not prevent the rest of a dashboard snapshot.

Another harness should implement the core interface with its own paths and session metadata instead of importing Pi filesystem conventions.

## Model adapters

`@surprisal-io/hyperchart/host` exports:

- `hyperchartRunFromInfo()` — static run-shaped model from a discovered chart;
- `hyperchartRunFromInspectResult()` — static inspector model from validated inspection;
- `hyperchartRunFromRuntime()` — durable/runtime overlay;
- `hyperchartRunFromToolDetails()` — normalize Pi tool details for UI.

Static inspection remains static: do not inject logs, status, sessions, or usage into the source definition. A concrete run overlay supplies those fields.

## React inspector

Install the Pi package and UI peers in the host application:

```sh
npm install @surprisal-io/pi-hyperchart react react-dom @xyflow/react elkjs react-syntax-highlighter
```

Then import components and one stylesheet:

```tsx
import {
  HyperchartInspectorDialog,
  HyperchartLaunchDialog,
  HyperchartRunStrip,
  HyperchartToolSummary,
  HyperchartUiThemeProvider,
} from "@surprisal-io/pi-hyperchart/react";
import "@surprisal-io/pi-hyperchart/react/styles.css";
```

### Components

| Component | Purpose |
|---|---|
| `HyperchartRunStrip` | Compact discovered-chart/current-run surface. |
| `HyperchartLaunchDialog` | Select chart and submit a JSON-object argument payload. |
| `HyperchartInspectorDialog` | Full graph + side-panel inspector for static or runtime models. |
| `HyperchartInspectorSidePanel` | Embed only the detail panel. |
| `HyperchartGraphPreview` | Embed graph visualization. |
| `HyperchartToolSummary` | Render inspector information returned by Pi tools. |
| `HyperchartPortalProvider` | Supply a host-controlled portal renderer. |
| `HyperchartUiThemeProvider` | Preserve the selected UI theme through portals. |

The package also exports graph construction/filter helpers and display helpers for status, timestamps, usage, progress, and labels.

### Data flow

1. read a snapshot through a host adapter;
2. pass canonical `HyperchartInfo`/`HyperchartRunInfo` models to React;
3. invoke host callbacks for run/open/abort/launch actions;
4. refresh snapshots after host events;
5. never let UI-local state become run truth.

The inspector accepts static definitions as well as runtime runs. Script arguments render only for script states; run arguments are overview data. Operational detail is grouped in a collapsed Runtime section so source definition remains primary.

## Styles and host isolation

`react/styles.css` contains the generated Tailwind utilities, XYFlow CSS, and Hyperchart variables. It does not apply global Tailwind Preflight. Required control/typography resets are scoped under `[data-hyperchart-root]`, so importing the file does not reset the surrounding dashboard.

Import the stylesheet exactly once at application entry. Do not import source CSS directly from the npm package.

## Theme contract

Wrap standalone UI:

```tsx
<HyperchartUiThemeProvider
  theme={{ resolved: "dark", themeName: "base" }}
>
  <HyperchartRunStrip {...props} />
</HyperchartUiThemeProvider>
```

Portaled dialogs inherit this provider. A host-owned portal may instead establish `data-theme="light"` or `data-theme="dark"` at the portal root.

Override the documented variable families to integrate a host theme:

- `--bg-*` — surfaces;
- `--text-*` — primary/secondary/muted text;
- `--border-*` — separators and outlines;
- `--hc-*` — status/accent colors.

Maintain contrast for text, focus rings, validation issues, and graph statuses in both themes.

## Portals, modal behavior, and focus

Use `HyperchartPortalProvider` when the host dashboard owns overlay placement. Hyperchart's modal primitive handles stacked dialogs, focus return, tab containment, and Escape ordering. The host portal renderer must preserve the supplied tree and should not clone/reparent interactive content in a way that breaks focus ownership.

## Large-content behavior

Definition, prompt, command, JSON, and map previews are bounded before React rendering. Truncated content exposes one `Open full` action; full content is not mounted in the initial DOM. Preserve this property when customizing components to avoid large logs/prompts bloating host dashboards.

## Launch arguments

`HyperchartLaunchDialog` accepts an optional JSON object. Scalars, arrays, and free-form instructions are rejected because chart arguments are named contracts. Validate/serialize the object in the host callback and surface parse errors before starting a run.

## SSR and bundlers

The public React entry avoids Node-only runtime imports. Use ESM-aware bundlers and keep the CSS side effect. The Pi host adapter is Node-only and should not be imported into browser bundles; fetch/transport its snapshots from the server side.

## Integration checklist

- Use `@surprisal-io/hyperchart/host` types end to end.
- Keep Pi host code server-side.
- Import the compiled stylesheet once.
- Provide React/React DOM/XYFlow/ELK/syntax-highlighter peers.
- Test light/dark themes and mobile width.
- Preserve portal focus and Escape behavior.
- Keep large preview content lazy.
- Add/update Storybook coverage for visible changes.
