# Development and release

This repository is an npm workspace with two publishable packages and shared tests, examples, Storybook, documentation, and formal models.

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
└── pi-hyperchart/
    ├── extensions/
    ├── skills/
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

The README inspector image must be captured from a deterministic Storybook fixture, not assembled as a mockup.

## Package boundaries

`@surprisal-io/hyperchart` must remain independent of Pi and React.

`@surprisal-io/pi-hyperchart` may depend on the core package and Pi/React peers. Browser code must not import Node-only modules.

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

Do not duplicate the manual or API reference into package READMEs or the skill. Package READMEs own installation and entry-point routing. The skill owns agent procedure and safety rules, uses `hyperchart_*` tools directly, and links to canonical pages for API detail.

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
npm publish --dry-run --workspace @surprisal-io/hyperchart
npm publish --dry-run --workspace @surprisal-io/pi-hyperchart
npm audit --omit=dev
```

Review the printed tarball contents. Source files included for Pi/Jiti loading are intentional; tests, Storybook, repository configuration, and unrelated assets are not.

## Release order

The packages publish independently but the Pi package pins the matching core version.

1. confirm a clean working tree and final version numbers;
2. run `npm run check`;
3. run `npm run build-storybook`;
4. run both publish dry-runs;
5. publish `@surprisal-io/hyperchart`;
6. verify the core package from a clean npm install;
7. publish `@surprisal-io/pi-hyperchart`;
8. install the Pi package in a clean Pi environment;
9. verify one extension, one `hyperchart` skill, `/hyperchart`, and all four tools;
10. create the release/tag only after registry verification.

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
- [ ] user docs, package READMEs, skill references, examples, and visuals reflect the release.
