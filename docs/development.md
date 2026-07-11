# Development, documentation, testing, and release

## Repository layout

```text
packages/hyperchart/             host-neutral engine/runtime/host models
packages/pi-hyperchart/          Pi adapter, extension, TUI, React, skill
examples/                        executable chart modules
tests/                           cross-workspace Vitest suite
docs/                            canonical documentation
assets/readme/                   checked-in landing-page visuals
.storybook/                      Storybook configuration
tla/                             formal semantics and trace validation
scripts/                         build and package validation
```

The workspace root is private. Only the two packages under `packages/` are publishable.

## Install and validate

```sh
npm install
npm run typecheck
npm run build
npm run test
npm run build-storybook
npm run validate:packages
```

`npm run check` builds core before Pi, typechecks source/tests/examples/Storybook, runs all Vitest tests, and validates packages/docs. `validate:packages` inspects both tarballs and their links/import boundaries. Run the explicit Storybook build for UI changes.

Do not test package consumers only through workspace symlinks. A release candidate must also install the generated tarballs in a clean temporary project.

## Package boundaries

`@surprisal-io/hyperchart` may not import Pi or React. It owns:

- authoring types/DSL;
- normalization, parsing, source, and static inspection;
- machine, projection, replay, and execution loop;
- generic runtime utilities;
- host-neutral inspector models/adapters.

`@surprisal-io/pi-hyperchart` depends on the exact matching core version and owns:

- command event API;
- Pi discovery/runner/agent executor/status/session progress;
- Pi extension and bundled skill;
- TUI components;
- React inspector and compiled stylesheet.

Across this boundary, import package entry points. Relative imports that escape one package into the other are forbidden.

## Tests

The suite includes:

- parser/normalizer/typed authoring tests;
- execution loop, timers, validation, map/parallel/compound behavior;
- durable log/replay and crash gauntlet tests;
- generic runtime, script, artifact, and run-outcome tests;
- Pi path, runner, agent executor, status, host-discovery, and extension tests;
- host-model/runtime-adapter tests;
- React SSR/layout/style/preview tests;
- external chart typecheck examples.

Add the smallest focused test for a change, then run the full suite before release. A change to execution semantics also requires the TLA+/trace workflow in `AGENTS.md`.

## Storybook and visual QA

Run:

```sh
npm run storybook
```

Stories live beside Pi React source and include inspector panels, run states, edge types, launch UI, and bounded-content examples. Visible component changes require an appropriate story. Refresh `assets/readme/inspector.png` when the README representation is no longer accurate. Screenshots must use deterministic fixtures and contain no secrets or real user paths.

## Documentation ownership map

Documentation is part of implementation, not post-release cleanup.

| Change | Required documentation |
|---|---|
| Authoring export or chart field | `core-authoring.md`, `reference.md`, core package README, relevant example; skill routing if agents author it. |
| Compound/parallel/map/artifact/validation/re-entry behavior | `composition.md`, `reference.md`, behavior tests. |
| Runtime/log/replay semantics | `runtime-and-durability.md`, `architecture.md`, `reference.md`, replay tests, and TLA+/trace per `AGENTS.md`. |
| Package/export/dependency/Node support | docs index/reference/development, affected package README, package validation. |
| Pi command/tool/lifecycle/run file | `pi.md`, Pi package README, skill reference/workflow. |
| Host adapter model | `integration.md`, `reference.md`, host tests. |
| React/UI/theme | `integration.md`, Pi README, Storybook, and README visual when visible. |
| Example | `examples.md`, source comments/tests, skill reference when recommended. |
| Recovery safety | `pi.md`, `runtime-and-durability.md`, skill safety reference. |

Package READMEs are concise npm landing pages. `docs/` is canonical. The skill routes agents to focused references and canonical pages; do not duplicate the manual into all three.

## Writing docs

- Use public scoped package imports.
- Keep examples compilable and data-first.
- State defaults, required fields, safety constraints, and unsupported behavior.
- Link related concepts instead of copying paragraphs.
- Add alt text to every image.
- Use repository-relative links inside canonical docs and stable GitHub links from packed package README/skill references.
- Update the docs index when adding a canonical page.

`npm run validate:packages` checks local Markdown links included in root docs, package READMEs, and the bundled skill.

## Preparing a release

1. Confirm the shared version and release notes.
2. Verify the working tree contains only reviewed changes.
3. Run `npm ci` in a clean checkout.
4. Run `npm run check` and `npm run build-storybook`.
5. Inspect actual tarballs:

   ```sh
   npm pack --workspace @surprisal-io/hyperchart --json
   npm pack --workspace @surprisal-io/pi-hyperchart --json
   ```

6. Verify each tarball contains README, LICENSE, declarations, JavaScript, and only intended source/resources. The Pi tarball must contain `extensions/hyperchart.ts` and `skills/hyperchart/SKILL.md` plus references.
7. In a clean temporary project, install both tarballs and import every public export path. Typecheck a minimal chart. Load the Pi extension through Pi/Jiti and verify the skill is discovered.
8. Run `npm publish --dry-run --workspace ...` for both.
9. Publish `@surprisal-io/hyperchart` first, then `@surprisal-io/pi-hyperchart`, both with public access.
10. Verify registry metadata, clean installation, Pi discovery, and the package-gallery image.

Package scripts run a production build before publication. Nothing in this repository publishes automatically.

## Security and dependency review

Pi extensions and skills execute with user permissions. Review dependencies, `npm audit` output, and packed source before release. Do not fix an audit warning by a blind major upgrade; determine reachability and regression risk. Never include run directories, sessions, credentials, generated Storybook output, or local agent definitions in a tarball.
