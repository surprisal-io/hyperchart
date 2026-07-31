# Development and release

This repository is an npm workspace with three publishable packages and shared tests, examples, Storybook, documentation, and formal models.

## Requirements

- Node.js 22.19 or newer
- npm
- Java, for TLA+ model checking
- Pi, for extension and TUI testing

Install dependencies:

```sh
npm install
```

## Repository layout

```text
packages/
├── hyperchart/
│   ├── src/core/
│   ├── src/runtime/
│   └── src/host/
├── claude-hyperchart/
│   ├── src/
│   │   ├── mcp/
│   │   └── claude/
│   ├── bin/
│   ├── hooks/
│   └── skills/
└── pi-hyperchart/
    ├── extensions/
    ├── skills/
    ├── docs/              generated bundled documentation mirror
    └── src/
        ├── runtime/pi/
        ├── tui/
        └── react/

docs/                 canonical user documentation
examples/             checked-in chart examples
tests/                cross-package tests
assets/readme/         README and documentation visuals
tla/                   independent semantics and trace model
scripts/               build and package validation
```

## Build and test

Build both packages:

```sh
npm run build
```

Run TypeScript checks:

```sh
npm run typecheck
```

Run tests:

```sh
npm test
```

Run the standard gate:

```sh
npm run check
```

`check` builds, typechecks, runs Vitest, validates package contents and links, packs both workspaces, installs the tarballs in a clean project, tests runtime and type imports, loads the packed Pi extension through Jiti, and verifies the bundled skill.

## Storybook

Start Storybook:

```sh
npm run storybook
```

Build the static site:

```sh
npm run build-storybook
```

React changes need a story that shows the affected state. Test both light and dark schemes, narrow layouts, long content, modal stacking, and keyboard behavior where relevant.

TUI stories live under `Hyperchart/TUI`. They render the real compact `RunWidget` and selection-only `RunHistoryOverlay` through xterm.js; detailed run inspection belongs exclusively to the React browser inspector. The widget must use the shared path-aware percentage estimator rather than graph-node counts. Its stories include both a single active state and eight concurrent map instances at 60, 80, and 120 columns. The development server keeps a live Node-side component instance so keyboard input exercises the actual component state machine, while the static Storybook build contains deterministic initial/preset frames. The production picker materializes the real `deck-director` chart, durable JSONL records, and `sessions/progress.json` into a temporary run directory. Keep browser stories free of Node-only imports; fixture loading and TUI instances belong in the Storybook Vite plugin.

The core package build bundles the standalone inspector client into `packages/hyperchart/dist/inspector-web/`. If browser inspector behavior or React dependencies change, run the full package build and verify both `client.js` and `styles.css` are present.

The README inspector image must be captured from a deterministic Storybook fixture, not assembled as a mockup.

## Package boundaries

`@surprisal/hyperchart` must remain independent of Pi and React.

`@surprisal/pi-hyperchart` may depend on the core package and Pi/React peers. Browser code must not import Node-only modules.

Check boundaries with:

```sh
npm run validate:packages
```

The validator rejects cross-package relative imports and verifies packed export maps. Do not bypass it with development-only aliases that disappear from the tarball.

## Change execution semantics

A change to `machine.ts`, `projection.ts`, `execution_loop.ts`, durable records, or semantic normalization is not complete when TypeScript tests pass.

Keep three articulations in sync:

1. implementation and durable log/replay contract;
2. `tla/Hyperchart.tla` and model-check configurations;
3. a real trace exported from the TypeScript engine and checked by `tla/HyperchartTrace.tla`.

Run all models:

```sh
for M in MCReviewFix MCPipeline MCGate MCFanout MCMap MCNested; do
  tla/check.sh "$M"
done
```

Record and validate the sample trace:

```sh
node tla/trace/record-sample.mjs
tla/trace/validate.sh sample_chart.ts sample-run.jsonl
```

Read the header of `tla/Hyperchart.tla` before editing either implementation or model. A divergence is a finding to investigate, not permission to change the model until it passes.

## Documentation ownership

Documentation is part of the change.

| Change | Required documentation |
|---|---|
| DSL, schemas, refs, actions | `docs/core-authoring.md`, `docs/api/dsl.md`, core package README |
| compound/parallel/map/validation/re-entry | `docs/composition.md`, `docs/api/dsl.md`, semantic/replay notes where applicable |
| runtime, log, projection, replay | `docs/runtime-and-durability.md`, `docs/api/core.md`, `docs/api/runtime.md`, `docs/safety.md`, `docs/architecture.md` |
| Pi command, tool, lifecycle, discovery | `docs/pi.md`, `docs/api/pi.md`, bundled agent skill |
| rewind, delete, override behavior | `docs/safety.md`, `docs/api/pi.md`, skill safety rules |
| host models or adapters | `docs/integration.md`, `docs/api/host.md` |
| React components, CSS, themes, portals | `docs/integration.md`, `docs/api/react.md`, Storybook, package README |
| examples | `docs/examples.md`, runnable source/test |
| package exports/dependencies | root README, affected package README, matching page under `docs/api/` |
| visible product identity | README assets and their surrounding alt text/copy |

Do not rewrite or abbreviate the manual inside package READMEs or the skill. Package READMEs own installation and entry-point routing. The Pi skill uses the consolidated `hyperchart` tool with action parameters; the Claude skill uses individual `hyperchart_*` MCP tools. Both skills call tools directly rather than routing through slash commands.

The repository-root `docs/`, `examples/`, and referenced documentation assets are canonical. `packages/pi-hyperchart/docs/`, `examples/`, and `assets/` are generated mirrors shipped for offline agent use. After editing a canonical file, synchronize the mirror:

```sh
npm run sync:pi-docs
```

Package validation and `prepack` use `scripts/sync-pi-docs.mjs --check` and fail when the mirror differs. Never edit a mirrored file directly.

Every command and code sample must match a checked-in implementation, test, or example. State prerequisites before the procedure, especially agent definitions, model credentials, external scripts, and unsupported user actions.

## Add or change a public export

1. update the source barrel;
2. update the package `exports` map if a new subpath is needed;
3. build declarations;
4. add a clean-consumer runtime and type import to `scripts/validate-packages.mjs`;
5. document every exported value and type on the matching page under `docs/api/`, then update the package README entry-point link;
6. run `npm run validate:packages`.

Avoid expanding `./internal/*` as an application API. Add a deliberate public subpath when third-party consumers need a supported contract.

## Validate tarballs

Run:

```sh
npm run validate:packages
npm publish --dry-run --workspace @surprisal/hyperchart
npm publish --dry-run --workspace @surprisal/pi-hyperchart
npm audit --omit=dev
```

Review the printed tarball contents. Source files included for Pi/Jiti loading are intentional; tests, Storybook, repository configuration, and unrelated assets are not.

## Prepare and publish a release

The packages publish independently, and the Pi package pins the exact matching core version. Prepare the version from a clean tracked working tree:

```sh
make release-prepare VERSION=0.2.0
```

This command:

1. rejects a version that already exists for any published package;
2. verifies that the corresponding `v<version>` tag is absent or already points at the current `HEAD`;
3. updates the workspace and package versions;
4. updates exact host → core dependencies and `package-lock.json` entries;
5. updates version labels in the root and package READMEs;
6. synchronizes the documentation bundled in the Pi package;
7. runs `npm run check`, the Storybook build, the production dependency audit, and all publish dry-runs.

Review and commit the resulting version change. Publish only from that clean commit:

```sh
make release-publish \
  VERSION=0.2.0 \
  CONFIRM=publish-0.2.0
```

For a pre-release, provide a non-`latest` npm tag to both commands:

```sh
make release-prepare VERSION=0.2.0-rc.1 NPM_TAG=next
make release-publish VERSION=0.2.0-rc.1 NPM_TAG=next CONFIRM=publish-0.2.0-rc.1
```

`release-publish` repeats all gates and dry-runs, verifies npm authentication, then publishes core, Claude, and Pi packages in dependency order. After every npm publish succeeds, it creates the annotated git tag `v<version>` on the current release commit and pushes it to `origin`. Set `RELEASE_REMOTE=<remote>` to use another remote. It does not poll npm registry visibility.

If the process is interrupted after npm prints `+ @surprisal/hyperchart@<version>` but before Pi is published, do not rerun the core publish. Publish only the Pi package with:

```sh
make release-resume \
  VERSION=0.2.0 \
  CONFIRM=resume-0.2.0
```

The resume target repeats the release gate, skips packages already present in npm, publishes the missing packages, and then creates or pushes the same annotated tag. Tagging is idempotent: rerunning resume accepts an existing local or remote tag only when it resolves to the current release commit, and fails on a conflicting tag.

After publication, install the Pi package in a clean Pi environment and verify one extension, one `hyperchart` skill, `/hyperchart`, and every consolidated-tool action.

Do not publish from a workspace whose package manifests or lockfile still refer to a temporary local dependency.

## Pre-release checklist

- [ ] Node and npm versions match the supported range.
- [ ] `npm run check` passes.
- [ ] `npm run build-storybook` passes.
- [ ] TLA+ models and trace validation pass for semantic changes.
- [ ] package and Markdown link validation passes.
- [ ] both tarballs install in a clean consumer.
- [ ] Pi discovers the packed extension and skill.
- [ ] production dependency audit is clean or findings are documented.
- [ ] package versions and core dependency are exact and matching.
- [ ] annotated tag `v<version>` exists on the release commit in the configured release remote.
- [ ] user docs, package READMEs, skill references, examples, and visuals reflect the release.
