# Artifact revisions: immutable accepted states

## Problem

The durable log stores only the rendered artifact path. `resolveArtifactValue()`
reads the current mutable file, so after the tree-shaped rewind landed, sibling
branches can overwrite the same authored path and replay/`artifactOf` silently
reads a state the original run never saw. Execution history is preserved;
historical artifact values are not (autodiscovery-storage-notes §17).

## Contract decisions

1. **Revision = observed accepted state at the action boundary.** The runtime
   does not control how agents write files; any interception would lie. A
   revision is what the workflow *accepted*, snapshotted at completion
   admission. Diffs are computed between revisions, never recorded.

2. **Snapshot is copy-then-hash.** Read the file once into the store, hash the
   stored bytes, record that hash. No TOCTOU window between hashing and
   copying — the fact references exactly the bytes in the store.

3. **Identity = sha256 of full logical content (blob).** Trivially verifiable
   externally (`sha256sum file` = root). Chunking/compression, if ever needed,
   is a storage-backend concern that must not change identity.

4. **Physical store: flat CAS inside the run directory.**
   `<runDir>/artifact_store/objects/<aa>/<rest-of-sha256>`, written via
   temp+rename (atomic, idempotent, lock-free — identical content maps to the
   same path). The run dir stays self-contained and portable. No git: the
   commit graph / refs / history that git provides already exist in the
   durable log; a second history would compete with the log as truth. Git
   remains reserved for the evolving harness (DGM), where commit semantics
   genuinely apply.

5. **Layering.** The log contract knows only content hashes (semantic layer).
   Blob encoding is specified and stable (canonical layer). The store behind
   put/get/has is boring and replaceable (physical layer). Physical format
   never leaks into execution semantics.

6. **Validation binds to the snapshot.** Snapshot the declared artifacts when
   the completion claim arrives; run schema checks / validators against the
   snapshotted bytes. The verdict and the completion fact then reference the
   same immutable state (closes notes §15.6 — validator no longer races the
   mutable working file).

7. **Entering an action restores pinned state.** Reads are not controlled —
   agents read files with their own tools. The runtime's obligation is
   therefore at action entry: before invoking an action, materialize each
   declared `reads` from the store back to its authored path, at the pinned
   revision from the producing completion fact. Hashing the current file
   first is only an optimization (hash matches pin → skip the copy). A
   missing store object is the only error. Sibling-branch overwrites stop
   mattering: whichever branch runs next, its actions see their own accepted
   states. Files outside declared channels remain outside the guarantee
   (honest system boundary, notes §8).

8. **Working files keep mutable-path semantics.** The authored path is still
   written in place by the agent; no path redirection (rejected in §17). The
   store is an append-only shadow, not a replacement.

## Log contract change

Extend `StateActionCompleteLog` with pinned revisions:

```ts
type StateActionCompleteLog = {
	type: "state_action";
	kind: "complete";
	actionUid: ActionUID;
	event: ChartEvent;
	artifacts?: Readonly<Record<string, ArtifactPin>>; // renderedPath → pin
} & SessionParams;

type ArtifactPin = Readonly<{ hash: ContentHash; size: number }>;
```

- New writers always emit the field (possibly `{}`).
- Records without the field are *pre-versioning*: admitted by replay, but
  reads resolved against them are unpinned (no verification possible).
  `explainReplay` surfaces this as a diagnostic, not an error. No migration.
- Transitions/admission rules are unchanged — the pin is payload. The TLA+
  model is expected to be unaffected; this must be stated and *checked*, not
  assumed: run the full model suite and re-record/validate the sample trace
  because the fact shape changed.

## Phases (one reviewable diff each)

### Phase 1 — store module, no engine changes

`packages/hyperchart/src/runtime/generic/artifact_store.ts`:

- `put(sourcePath) → { hash, size }` (streaming copy → hash → rename into CAS)
- `get(hash) → path`, `has(hash)`
- unit tests: idempotent put, concurrent put of identical content, corrupt
  object detection on get (hash recheck), missing object.

Nothing imports it yet. Pure, safe, reviewable in isolation.

### Phase 2 — snapshot on completion + log contract

- Executor: at completion admission, `put()` each declared artifact before
  schema/validator checks; checks read the snapshotted bytes; the completion
  fact carries the pins.
- `durable_events.ts`: the `artifacts` field as above.
- `replay_check`: pins are provenance, replay does not re-hash; absence of the
  field → pre-versioning diagnostic. Tests for both.
- `tla/trace/record-sample.mjs` / export: carry the new field; run
  `tla/check.sh` for all MC* models and `validate.sh` — expect no spec change,
  verify it.

### Phase 3 — materialize pinned reads at action entry

- Executor: before invoking an action, for each declared `reads` with a pin
  from the producing completion fact, restore the pinned bytes from the store
  to the authored path (skip when the current file already hashes to the
  pin). `resolveArtifactValue()` then reads the restored file as today.
- Missing store object → failure naming the hash and path.
- Unpinned legacy facts: no restore possible; current-file semantics, surfaced
  as a replay diagnostic.
- Tests: sibling-branch overwrite scenario (rewind → fork → overwrite path →
  action on the old branch still sees its pinned input), skip-copy fast path,
  missing-object failure.

### Phase 4 — vertical slice

- Host models/adapters expose the pin (hash, size) on completion projections.
- Inspector State Details + TUI show the revision hash next to the artifact.
- Storybook: State Details case with pinned artifacts (production pipeline:
  real execution loop → explainReplay → adapter → component).
- Docs: canonical page under `docs/` (artifact semantics: boundary revisions,
  pin verification, store layout), package README touchpoints, offer
  docs-engine audit run.

## Explicitly out of scope (with triggers)

- **Directory artifacts / tree encoding** — no directory artifacts exist in
  the DSL today. Trigger: adding directory-typed artifacts. The tree encoding
  (sorted entries → hash, git's *model* not git's tool) must be specified
  before the first directory pin is written.
- **Rejected-attempt snapshots** — host policy, off by default. The mechanism
  (put + reference from a host-side record) is trivial once Phase 1 exists.
- **GC** — mark from reachable pins, sweep the rest. Not needed for v1;
  objects are small relative to sessions and dedup across branches is free.
- **Chunking, compression, alternative backends (git-plumbing, S3)** — behind
  put/get/has, identity unchanged. Trigger: measured storage pain.

## Settled

1. Pins are written only when an action (script/agent/…) completes; the
   completion fact is the sole pin site. `spawned`/actor-message facts carry
   values inline and are immutable by construction.
2. Reads are not verified-and-failed; the runtime restores pinned state at
   action entry (contract decision 7).
3. The `validated` fact does not duplicate the hash; snapshot-first ordering
   in Phase 2 already binds the verdict and the completion to the same bytes.
