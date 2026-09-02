# Bounded projection storage and history queries

## Status

Design plan only. No implementation is authorized by this document.

## Context

The current storage refactor removes global journal snapshots, but `readAncestry()` can still return an arbitrarily large branch history. Runtime startup, replay compatibility, user-interaction admission, artifact restoration, rewind, inspector, host adapters, and TUI can therefore still materialize or replay unbounded history.

The intended outcome is to remove complete-ancestry reads while keeping `machine` and `projectBranch` strictly synchronous. Normal startup and inspection should load a reusable projection checkpoint and a small bounded tail. Historical data should be available only through snapshot-stable stateless cursor chunks or targeted lookups.

## Decision

`machine` and `projectBranch` remain synchronous. They must never perform I/O and must not return promises.

`execution_loop` owns projection restoration and execution. It asks `RunLogStore` only for checkpoint bytes and fixed-size journal chunks, synchronously applies each chunk through `projectBranch`, and then creates/steps the machine with the resulting in-memory `BranchProjection`. Storage never imports the AST, calls the projector, compacts semantic state, or decides when execution starts. Machine steps never fetch projection fields from storage and never await the projector. The optimization boundary is therefore:

1. stop materializing complete ancestry arrays;
2. persist reusable projection checkpoints;
3. replay only a bounded tail during normal startup and inspection;
4. remove elapsed-history data from the live projection;
5. expose history through fixed-size stateless cursor-chunk queries.

This does not promise a fixed byte bound for all charts. A single live mailbox, fan-out input, result, or other semantically retained value may itself be arbitrarily large. The enforceable guarantee is: **normal memory and query results do not grow merely because more immutable journal history exists**.

## Non-negotiable invariants

- The durable journal remains the sole source of truth.
- Projection checkpoints and history indexes are disposable derived data.
- Journal entries are trusted during normal operation. Opening, reading, appending, and committing do not perform implicit structural audit or repair.
- Malformed JSON in `log.jsonl`, including an incomplete final line, fails parsing and leaves the file unchanged.
- Replay compatibility against a changed chart remains a semantic operation. It is not journal structural validation.
- `machine`, `projectBranch`, and expression/template evaluation remain synchronous.
- No public or production-internal API returns an unbounded ancestry array.
- Every public history chunk and private replay batch has a hard backend-enforced maximum that callers cannot override.
- An ancestry follows `parentId`; numeric `seqId` order is not ancestry order.
- Branch movement never changes the snapshot represented by an issued history cursor.
- PostgreSQL journal writes, branch-head writes, due checkpoints, derived indexes, sequence allocation, and host participant SQL commit atomically.
- JSONL remains the simple file backend: it parses and indexes the complete file in memory and writes no persistent catalog/checkpoint sidecars in this change.

## Approach

### 1. Keep synchronous projection semantics

Reuse the existing synchronous core:

```ts
export function createBranchProjection(ast: ChartAst): BranchProjection;

export function projectBranch(
  projection: BranchProjection,
  ast: ChartAst,
  records: readonly DurableLogRecord[],
  abandoned?: PendingAction[],
  skipped?: ProjectionSkippedRecord[],
): BranchProjection;
```

An asynchronous outer loader supplies bounded record batches. The core never knows whether records came from JSONL, PostgreSQL, a checkpoint tail, or a test.

### 2. Separate live projection from elapsed history

#### Current projection type

The implementation currently exposes this projection shape in `packages/hyperchart/src/core/projection.ts`:

```ts
export type BranchProjection = {
  activeLeaves: StatePath[];
  seqId: number;
  pendingActions: PendingAction[];
  userInteractions: Record<number, ProjectedUserInteraction>;
  args?: Readonly<Record<string, unknown>>;
  spawns: Record<StatePath, Readonly<Record<string, unknown>>>;
  inputs: Record<StatePath, Record<string, unknown>>;
  results: Record<StatePath, unknown>;
  stateVisits: Record<string, number>;
  sessions: Record<string, string>;
  failure?: { origin: StatePath; error: unknown; seqId: number };
  actors: Record<StatePath, ProjectedActorOccurrence>;
  actorPools: Record<StatePath, ProjectedActorPoolOccurrence>;
  pendingActorCalls: Record<string, PendingActorCall>;
  actorProducerVisits: Record<StatePath, number>;
};

export type ProjectedUserInteraction = {
  opened: UserInteractionOpenedLog;
  status: "open" | "resolved" | "closed";
  resolvedEvent?: ChartEvent;
};

export type ProjectedActorOccurrence = {
  declaration: StatePath;
  logicalOccurrence: StatePath;
  occurrence: StatePath;
  generation: number;
  owner?: StatePath;
  input: unknown;
  definition: ActorDeclarationAst;
  currentState: StatePath;
  mailbox: ProjectedActorMessage[];
  messages: ProjectedActorMessage[];
  currentMessage?: ProjectedActorMessage;
  status: "idle" | "busy" | "closing" | "draining" | "stopped" | "failed" | "cancelled";
};

export type ProjectedActorPoolOccurrence = {
  declaration: StatePath;
  logicalOccurrence: StatePath;
  occurrence: StatePath;
  generation: number;
  owner?: StatePath;
  input: unknown;
  definition: ActorPoolDeclarationAst;
  mailbox: ProjectedActorMessage[];
  messages: ProjectedActorMessage[];
  workers: ProjectedActorPoolWorker[];
  status: "idle" | "busy" | "closing" | "draining" | "stopped" | "failed" | "cancelled";
};
```

#### Planned type diff

```diff
 export type BranchProjection = {
   activeLeaves: StatePath[];
   seqId: number;
   pendingActions: PendingAction[];
-  userInteractions: Record<number, ProjectedUserInteraction>;
+  // Contains open gates only. Resolved/closed history is queried from storage.
+  openUserInteractions: Record<number, OpenProjectedUserInteraction>;
   args?: Readonly<Record<string, unknown>>;
   spawns: Record<StatePath, Readonly<Record<string, unknown>>>;
   inputs: Record<StatePath, Record<string, unknown>>;
   results: Record<StatePath, unknown>;
   stateVisits: Record<string, number>;
   sessions: Record<string, string>;
+  // Latest accepted durable artifact revision per rendered path.
+  artifactPins: Record<string, ArtifactPin>;
   failure?: { origin: StatePath; error: unknown; seqId: number };
   actors: Record<StatePath, ProjectedActorOccurrence>;
   actorPools: Record<StatePath, ProjectedActorPoolOccurrence>;
   pendingActorCalls: Record<string, PendingActorCall>;
   actorProducerVisits: Record<StatePath, number>;
 };
 
-export type ProjectedUserInteraction = {
+export type OpenProjectedUserInteraction = {
   opened: UserInteractionOpenedLog;
-  status: "open" | "resolved" | "closed";
-  resolvedEvent?: ChartEvent;
+  status: "open";
 };
 
 export type ProjectedActorOccurrence = {
   // identity, definition, current state and live-control fields unchanged
   mailbox: ProjectedActorMessage[];
-  messages: ProjectedActorMessage[];
   currentMessage?: ProjectedActorMessage;
 };
 
 export type ProjectedActorPoolOccurrence = {
   // identity, definition, workers and live-control fields unchanged
   mailbox: ProjectedActorMessage[];
-  messages: ProjectedActorMessage[];
 };
```

No separate asynchronous semantic-state provider is introduced. `spawns`, `inputs`, `results`, `stateVisits`, `sessions`, actor counters, and all other synchronously addressable values remain directly in `BranchProjection`.

#### What moves out of the projection

| Removed live-projection data | Replacement |
| --- | --- |
| Resolved/closed `userInteractions` entries and `resolvedEvent` history | `findUserInteractionResponse()` for exact lookup; paginated interaction history for UI |
| `actors[*].messages` settled history | `readActorMessages()` cursor chunks |
| `actorPools[*].messages` settled history | `readActorMessages()` cursor chunks |
| Artifact discovery by scanning all completion records | New `artifactPins` current-state map |
| Inspector visit/message/record arrays derived from complete ancestry | Snapshot-stable state-visit, actor-message, and record pages |

#### What explicitly remains

| Retained field | Why it cannot move behind I/O |
| --- | --- |
| `spawns` | Completed map instances may be referenced synchronously later |
| `inputs` | State entry/invocation rendering reads latest inputs synchronously |
| `results` | Result refs, templates, and final output read them synchronously |
| `stateVisits`, `actorProducerVisits` | Deterministic IDs/counters are computed synchronously |
| `sessions` | Re-entry/resume decisions need the latest reference synchronously |
| actor/pool `mailbox`, `currentMessage`, workers, pending calls | These are live machine control state, not history |
| `args`, `failure`, active leaves, pending actions | Direct machine semantics |

The projection may therefore still grow because synchronous semantics can address dynamic results, spawn values, current pins, or live mailboxes. Pruning those requires a semantic proof rather than age- or size-based eviction.

#### Synchronous projection GC

Add a synchronous, AST-derived retention plan rather than a generic LRU/TTL:

```ts
export type ProjectionRetentionPlan = Readonly<{
  resultReaders: ReadonlyMap<StatePath, ReadonlySet<StatePath>>;
  externallyReadMapScopes: ReadonlySet<StatePath>;
  resumableActions: ReadonlySet<string>;
  reenterableStates: ReadonlySet<StatePath>;
}>;

export function compileProjectionRetention(ast: ChartAst): ProjectionRetentionPlan;
export function compactProjection(
  projection: BranchProjection,
  ast: ChartAst,
  retention: ProjectionRetentionPlan,
): void;
```

`compactProjection` is synchronous and runs after each projected batch and before checkpoint serialization. Initial conservative rules:

- Delete `inputs` for exited ordinary states when no active descendant can resolve that input.
- On permanent map-scope exit, delete per-instance `inputs`, `spawns`, `results`, sessions, and counters only when normalized references prove they cannot be read outside that scope.
- Do not store `sessions` for actions whose `onReenter` policy never resumes.
- Remove stopped actor/pool occurrence control after mailbox/current message/pending calls are empty; retain only a generation counter when recreation remains possible.
- Delete result values only when the normalized AST contains no future-capable reader and the value is not the chart's final result.
- Never evict by count, time, approximate reachability, or memory pressure.
- When static reachability is ambiguous because of loops, dynamic paths, or guards, retain the value.

The GC implementation must begin with characterization tests for every `inputs`, `results`, `spawns`, `sessions`, actor-generation, map re-entry, and final-result read site in `core/machine.ts` and `core/projection.ts`. History remains available from durable paginated records after a value leaves the live projection.

### 3. Version projection checkpoints

```ts
export type ProjectionContract = Readonly<{
  projectorVersion: number;
  astDigest: string;
}>;

export type ProjectionCheckpoint = Readonly<{
  checkpointId: string;
  headSeqId: number | null;
  contract: ProjectionContract;
  projection: BranchProjection;
  createdAt: number;
}>;
```

`astDigest` is SHA-256 over canonical normalized `ChartAst` JSON. `projectorVersion` changes with projection semantics or serialized shape. Branch ID is not part of semantic identity: forks can reuse a checkpoint at a shared ancestry head.

No lineage hash is added under the trusted-storage policy. A checkpoint is accepted only when its contract matches, its head exists, that head belongs to the requested target ancestry, and its payload decodes as the current checkpoint schema. Invalid cache data is discarded without auditing or repairing the journal.

When `astDigest` or `projectorVersion` differs, no existing checkpoint is used. Replay restarts from the journal root in bounded chunks. Nothing is checkpointed during that replay: the first incompatible record aborts loading, while a new checkpoint under the new contract is saved only after the entire replay succeeds.

### 4. Replace `readAncestry()` with snapshot-pinned history chunks

Do not expose stateful `Reader`, `Seeker`, `ReaderSeeker`, `seek`, `tell`, or `close` APIs. Public history reads are idempotent serializable request/response operations.

```ts
export type HistorySnapshot = Readonly<{
  branchId: BranchId;
  headSeqId: number | null;
}>;

/**
 * Opaque and versioned. Bound to one snapshot, subject, boundary record,
 * and travel direction. It is never an offset.
 */
export type HistoryCursor = string;

export type HistoryChunk<T> = Readonly<{
  snapshot: HistorySnapshot;
  /** Canonical order is always newest-first. Backend-enforced length <= 100. */
  items: readonly T[];
  /** Absent exactly when the oldest matching item has been reached. */
  older?: HistoryCursor;
  /** Absent exactly when the captured snapshot head has been reached. */
  newer?: HistoryCursor;
}>;

export type HistorySubject =
  | Readonly<{ kind: "state-visits"; state: StatePath }>
  | Readonly<{ kind: "map-visits"; mapPath: StatePath }>
  | Readonly<{ kind: "actor-generations"; logicalOccurrence: StatePath }>
  | Readonly<{ kind: "actor-messages"; occurrence: StatePath }>;

export type BranchListCursor = string;
export type BranchListChunk = Readonly<{
  items: readonly BranchHead[];
  totalCount: number;
  next?: BranchListCursor;
}>;

export interface RunHistoryStore {
  captureSnapshot(branchId: BranchId): Promise<HistorySnapshot>;

  getBranch(branchId: BranchId): Promise<BranchHead>;
  /** Read-committed keyset pagination; branch-list pages are not snapshot-stable. */
  listBranches(cursor?: BranchListCursor): Promise<BranchListChunk>;
  getRecord(seqId: number): Promise<DurableLogRecord | undefined>;
  containsInHistory(input: {
    headSeqId: number | null;
    seqId: number;
  }): Promise<boolean>;
  countRecords(): Promise<number>;

  /** Unfiltered newest-first ancestry only; no arbitrary scan-backed filter. */
  readRecords(input: {
    snapshot: HistorySnapshot;
    cursor?: HistoryCursor;
  }): Promise<HistoryChunk<DurableLogRecord>>;

  readStateVisits(input: {
    snapshot: HistorySnapshot;
    state: StatePath;
    cursor?: HistoryCursor;
  }): Promise<HistoryChunk<HyperchartVisitInfo>>;

  readMapVisits(input: {
    snapshot: HistorySnapshot;
    mapPath: StatePath;
    cursor?: HistoryCursor;
  }): Promise<HistoryChunk<HyperchartMapVisitInfo>>;

  readActorGenerations(input: {
    snapshot: HistorySnapshot;
    logicalOccurrence: StatePath;
    cursor?: HistoryCursor;
  }): Promise<HistoryChunk<HyperchartActorGenerationInfo>>;

  readActorMessages(input: {
    snapshot: HistorySnapshot;
    occurrence: StatePath;
    cursor?: HistoryCursor;
  }): Promise<HistoryChunk<ProjectedActorMessage>>;

  /** Mint a cursor whose next subject read returns a newest-first chunk beginning with seqId. */
  cursorAt(input: {
    snapshot: HistorySnapshot;
    subject: HistorySubject;
    seqId: number;
  }): Promise<HistoryCursor | undefined>;

  findUserInteractionResponse(input: {
    headSeqId: number | null;
    gateSeqId: number;
  }): Promise<UserInteractionResolvedLog | undefined>;
}
```

Public-history invariants:

- A read is a pure function of immutable journal data at `snapshot.headSeqId` plus its request; retries and concurrent older/newer requests are safe.
- `items.length <= HISTORY_READ_ITEMS`, where private backend constant `HISTORY_READ_ITEMS = 100` is not caller-configurable.
- A cursor is valid only for the exact snapshot and subject that minted it; mismatch returns a typed error.
- `cursorAt` returns `undefined` unless `seqId` belongs to both the captured ancestry and subject chain; a read with the returned cursor includes that item as the first/newest item and returns both edge cursors as available.
- Every chunk is newest-first regardless of whether `older` or `newer` was requested.
- Cursor absence is the only end marker; do not duplicate it with `eof`/`reachedOldest`/`reachedNewest` flags.
- Catalog-backed subject reads traverse matching links only and never return an empty continuation chunk.
- `readRecords` is unfiltered; do not accept a generic `RecordFilter` that can silently degrade into ancestry scanning.
- Chunks are immutable/cacheable by `(snapshot, subject, cursor)`.
- Branch-list cursors use stable keyset ordering `(branchCreatedSeqId, branchId)` under read-committed semantics; concurrent branch creation may change `totalCount`, and branch-head movement may change an item's head between requests without invalidating history snapshots.
- Contract tests execute the same requests against Memory, JSONL, and PostgreSQL and assert result equality and the 100-item bound.

### 5. Keep projection replay private and one-directional

Projection replay is not a UI history query and does not share the public chunk abstraction. It is a private oldest-first single-consumer stream owned by `execution_loop`/`projection_loader`:

```ts
interface ProjectionReplaySource {
  /**
   * Streams ancestry (afterSeqId, targetHeadSeqId] oldest-first.
   * Every yielded batch contains <= PROJECTION_READ_RECORDS (500) facts.
   * Iterator return()/throw() releases PostgreSQL temporary resources.
   */
  openProjectionReplay(input: {
    targetHeadSeqId: number | null;
    afterSeqId: number | null;
  }): AsyncIterable<readonly DurableLogRecord[]>;
}

interface ProjectionRepository {
  loadExact(input: ProjectionLookup): Promise<ProjectionCheckpoint | undefined>;
  findNearestAncestor(input: ProjectionLookup): Promise<ProjectionCheckpoint | undefined>;
  save(checkpoint: ProjectionCheckpoint): Promise<void>;
}

// packages/hyperchart/src/runtime/generic/projection_loader.ts
export async function loadBranchProjection(input: {
  ast: ChartAst;
  branchId: BranchId;
  store: RunLogStore;
  contract: ProjectionContract;
}): Promise<LoadedBranchProjection>;
```

`loadBranchProjection`, called by `execution_loop`:

1. Capture the selected branch head once.
2. Load an exact compatible checkpoint or the nearest compatible ancestor checkpoint.
3. Clone the checkpoint or call `createBranchProjection(ast)`.
4. `for await` over `openProjectionReplay({afterSeqId: checkpointHead, targetHeadSeqId})`.
5. Apply every bounded batch synchronously through `projectBranch` and `compactProjection`.
6. Update streaming replay compatibility; abort without saving on failure.
7. Persist a due/exact opaque checkpoint only after reaching the captured head.
8. Return the synchronous projection to `execution_loop`, which creates the machine.

Storage responsibilities end at facts, topology, bounded replay batches, public history chunks, and opaque checkpoint persistence. AST digest construction, projection, compaction, replay diagnostics, and machine creation remain runtime/execution responsibilities.

PostgreSQL may use bounded temporary storage internally to reverse a parent-linked tail for oldest-first iteration. JSONL may iterate its complete private in-memory index. Neither mechanism is public.

### 6. Checkpoint cadence

Use `PROJECTION_CHECKPOINT_INTERVAL = 512` initially. Create immutable checkpoints:

- at root initialization;
- every 512 ancestry records;
- at a newly created branch head;
- at rewind/move targets before resume;
- on clean shutdown when the tail is non-empty;
- after a fully successful chart-compatibility rebuild; a failed or incomplete rebuild saves nothing.

Healthy PostgreSQL startup/inspection replays at most 511 records. Missing PostgreSQL checkpoints may require more total streaming work but never unbounded result batches. JSONL retains its full in-memory replay behavior for now.

Historical fork/rewind uses the nearest checkpoint contained in target ancestry, then streams the remaining tail. Do not design checkpoint garbage collection in this change because arbitrary historical targets must remain usable.

### 7. PostgreSQL persistence

Define per-run allocation directly in the initial `hyperchart_run_meta` schema; this work does not migrate existing PostgreSQL data because the current development database will be cleared:

```sql
CREATE TABLE hyperchart_run_meta (
  run_id text PRIMARY KEY,
  meta jsonb NOT NULL,
  next_seq bigint NOT NULL DEFAULT 1
);

UPDATE hyperchart_run_meta
SET next_seq = next_seq + $2
WHERE run_id = $1
RETURNING next_seq - $2 AS first_seq;
```

Normal appends never call `MAX(seq)`. There is no backfill or compatibility path for the discarded schema.

Add immutable checkpoints:

```sql
CREATE TABLE hyperchart_projection_checkpoint (
  run_id text NOT NULL,
  checkpoint_id text NOT NULL,
  head_seq_id bigint,
  projector_version integer NOT NULL,
  ast_digest text NOT NULL,
  projection jsonb NOT NULL,
  created_at_ms bigint NOT NULL,
  PRIMARY KEY (run_id, checkpoint_id),
  FOREIGN KEY (run_id, head_seq_id)
    REFERENCES hyperchart_journal(run_id, seq)
);

CREATE UNIQUE INDEX hyperchart_projection_identity_idx
  ON hyperchart_projection_checkpoint(
    run_id,
    COALESCE(head_seq_id, -1),
    projector_version,
    ast_digest
  );
```

### 7.3 PostgreSQL persistent ancestry catalog

Implement the catalog only in `PostgresLogStore`. PostgreSQL treats catalog keys as opaque bytes; key namespaces remain TypeScript runtime constants and are not constrained in DDL.

#### DDL

Create immutable HAMT nodes before the journal:

```sql
CREATE TABLE hyperchart_catalog_node (
  node_hash bytea PRIMARY KEY,
  node_kind text NOT NULL CHECK (node_kind IN ('branch', 'leaf', 'collision')),
  bitmap bigint,
  child_hashes bytea[],
  entries jsonb,
  canonical_bytes bytea NOT NULL,
  CHECK (
    (node_kind = 'branch' AND bitmap IS NOT NULL AND child_hashes IS NOT NULL AND entries IS NULL)
    OR
    (node_kind IN ('leaf', 'collision') AND bitmap IS NULL AND child_hashes IS NULL AND entries IS NOT NULL)
  )
);
```

Define `catalog_root_hash` directly in the new initial journal DDL; do not add migration or `ALTER TABLE` code:

```sql
CREATE TABLE hyperchart_journal (
  run_id text NOT NULL,
  seq bigint NOT NULL,
  parent_id bigint,
  -- existing kind/branch/payload columns
  catalog_root_hash bytea,
  PRIMARY KEY (run_id, seq),
  FOREIGN KEY (catalog_root_hash)
    REFERENCES hyperchart_catalog_node(node_hash)
  -- existing checks and foreign keys
);
```

Store canonical opaque keys separately:

```sql
CREATE TABLE hyperchart_catalog_key (
  key_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id text NOT NULL,
  key_bytes bytea NOT NULL,
  key_hash bytea NOT NULL,
  UNIQUE (run_id, key_bytes)
);

CREATE INDEX hyperchart_catalog_key_hash_idx
  ON hyperchart_catalog_key(run_id, key_hash);
```

Store one immutable matching-history link per affected key/fact:

```sql
CREATE TABLE hyperchart_catalog_link (
  run_id text NOT NULL,
  key_id bigint NOT NULL,
  seq_id bigint NOT NULL,
  previous_seq_id bigint,
  PRIMARY KEY (run_id, key_id, seq_id),
  FOREIGN KEY (key_id) REFERENCES hyperchart_catalog_key(key_id),
  FOREIGN KEY (run_id, seq_id) REFERENCES hyperchart_journal(run_id, seq),
  FOREIGN KEY (run_id, previous_seq_id) REFERENCES hyperchart_journal(run_id, seq)
);
```

#### Runtime-owned key encoding

```ts
function encodeCatalogKey(namespace: string, parts: readonly string[]): Uint8Array;
function encodeCatalogForwardKey(subjectKey: Uint8Array, fromSeqId: number): Uint8Array;
function deriveCatalogKeys(record: DurableLogRecord): readonly Uint8Array[];
```

Requirements:

- encoding is canonical and length-delimited, not separator-concatenated text;
- database code never switches on namespace strings;
- `state-visits/<state>` is updated only by `state_action/invoke`;
- `visit-events/<invokeSeqId>` is updated by the launch's lifecycle facts;
- actor/map/gate/checkpoint namespaces are runtime constants, not PostgreSQL enum/check constraints;
- every durable record updates its opaque `record-membership/<seqId>` key so `containsInHistory` is one captured-root HAMT lookup rather than ancestry traversal;
- beyond that mandatory membership key, one fact may update zero, one, or several subject keys;
- for every new subject link whose `previous_seq_id` is non-null, also update the opaque forward key `(subjectKey, previousSeqId) → newSeqId` in the new catalog root;
- the forward key is versioned by the same root, so two branches may store different successors for the same previous record without ambiguity.

#### HAMT requirements

- `node_hash = SHA-256(canonical_bytes)`;
- verify canonical bytes before reusing an existing hash;
- leaf/collision entries contain `{keyHash, keyId, latestSeqId, count}`;
- compare full `key_id` in leaf/collision nodes;
- nodes are immutable;
- copy only nodes on changed key paths;
- reuse unchanged child hashes;
- select fan-out, canonical encoding, and collision layout from the benchmark gate;
- do not implement node GC until root-retention semantics are separately approved.

#### Atomic write algorithm

For each new journal record inside the existing serialized PostgreSQL transaction:

1. Read the selected parent row's `catalog_root_hash`, or use the empty root.
2. Derive opaque catalog keys in execution/admission code.
3. Resolve/create `hyperchart_catalog_key` rows.
4. Lookup every key in the inherited HAMT root.
5. Insert each `hyperchart_catalog_link` using the inherited `latestSeqId` as `previous_seq_id`.
6. Copy-on-write update each subject HAMT value to `{latestSeqId: newSeqId, count: oldCount + 1}`.
7. When `previous_seq_id` exists, copy-on-write set the subject's opaque forward key `(previousSeqId) → newSeqId` in the same root version.
8. Insert the journal row with the final root hash.
9. Atomically commit journal, catalog keys/links/nodes, branch head, due checkpoint, and host participant SQL.

Every durable record changes at least its membership key. A record affecting no semantic-history subject changes only that membership key while structurally sharing every other path. A record appended from an arbitrary historical parent starts from that parent's root.

#### Cursor-chunk query algorithm

For a catalog-backed filtered chunk query:

1. Resolve opaque `key_bytes` to `key_id`/`key_hash`.
2. Load `catalog_root_hash` from the captured head row.
3. Lookup `{latestSeqId, count}` in the HAMT.
4. Follow at most `HISTORY_READ_ITEMS = 100` links from `latestSeqId`.
5. Batch-fetch the matching journal payloads.
6. Return a `HistoryChunk` with `older` and `newer` cursors. Older traversal follows `previous_seq_id`. Newer traversal resolves the subject's opaque forward keys against the captured snapshot root; it must not query all global children of `previous_seq_id`, because different branches may have different successors.

The first/newest chunk performs the subject-head HAMT lookup. Subsequent older chunks start directly from the key ID and boundary sequence encoded in the cursor. Newer chunks use the same captured root plus bounded forward-key HAMT lookups. Benchmark both directions separately.

`cursorAt` verifies a matching durable coordinate without ancestry traversal: the coordinate is visible when it equals the root's subject `latestSeqId` or its forward key exists in that root. The returned cursor begins a chunk at that coordinate.

The PostgreSQL link query must cap recursion inside the recursive term:

```sql
WITH RECURSIVE matching AS (
  SELECT l.seq_id, l.previous_seq_id, 1 AS depth
  FROM hyperchart_catalog_link l
  WHERE l.run_id = $1 AND l.key_id = $2 AND l.seq_id = $3

  UNION ALL

  SELECT p.seq_id, p.previous_seq_id, m.depth + 1
  FROM matching m
  JOIN hyperchart_catalog_link p
    ON p.run_id = $1
   AND p.key_id = $2
   AND p.seq_id = m.previous_seq_id
  WHERE m.depth < 100
)
SELECT seq_id, previous_seq_id FROM matching;
```

Do not add an outer sort/join that forces traversal beyond the capped result before payload batch fetch.

For 100 state launches, read 100 `state-visits/<state>` invoke links, then perform a bounded batch of `visit-events/<invokeSeqId>` HAMT lookups/details. Do not mix all lifecycle facts into the state-launch chain.

Unfiltered history reads at most 100 ordinary parent links and does not use the catalog. Replace unbounded `listBranches()` with read-committed keyset pagination `listBranches(cursor?): Promise<BranchListChunk>`.

A due projection checkpoint written with an append updates the opaque checkpoint key for its projection contract. Exact checkpoints remain directly addressable by `(run_id, head_seq_id, contract)`.

PostgreSQL commit sequence:

The execution/admission service orchestrates the transaction:

1. ask the store transaction to begin and lock the selected branch head;
2. use execution-owned `loadBranchProjection` against the transaction's private bounded replay stream when admission needs projection;
3. ask the transaction to allocate the contiguous `seqId` range through `next_seq`;
4. ask it to stamp/insert durable facts;
5. synchronously apply facts to a cloned projection in execution/admission code;
6. derive catalog keys/links, copy-on-write catalog nodes, and checkpoint payload in execution code, then ask the transaction to persist them;
7. run host participant SQL and update branch head through the transaction;
8. ask the store to commit; poison the store on uncertain commit.

The store provides atomic persistence primitives but never calls `projectBranch` itself.

### 8. JSONL remains in-memory

Do not implement persistent catalog nodes, catalog links, SQLite, checkpoint sidecars, disk spools, or new on-disk indexes for the file backend in this change.

`JsonlLogStore` keeps the existing simple model:

1. Parse the complete trusted `log.jsonl` on open.
2. Fail on malformed/incomplete JSON without modifying the file.
3. Build private in-memory record, branch, ancestry, catalog-key, and process-local projection-checkpoint indexes.
4. Keep the complete file-backed journal/index in memory; `ProjectionRepository.save()` updates only that process-local map.
5. Implement the same public stateless history-chunk queries over those private arrays/maps with the same 100-item return bound.
6. Never expose the complete materialized index or `readAncestry()`.
7. Continue appending only durable journal entries to disk.

JSONL startup remains O(file size) and is not covered by the 100-million-row PostgreSQL scalability guarantee. Persistent file checkpoints/indexes require a separate approved design later.

### 9. Stream replay compatibility

Refactor `explainReplay` behind a synchronous incremental accumulator:

```ts
interface ReplayAccumulator {
  readonly projection: BranchProjection;
  push(records: readonly DurableLogRecord[]): void;
  finish(): ReplaySummary;
}
```

Retain the first broken record, valid-prefix end, diagnostic counts, capped preview, and all data required for the existing compatibility decision. Full diagnostics become paginated derived history. `ReplaySummary` is a transient loader result and is not stored in `ProjectionCheckpoint`.

An AST digest or projector version change invalidates every existing checkpoint and forces bounded streaming replay from root. No checkpoint is saved until replay reaches the captured head successfully; an incompatibility aborts loading without persisting the valid prefix. That is semantic compatibility checking, not structural storage validation.

### 10. Make inspector Runtime truly on-demand

#### Current eager behavior

`host/adapters.ts::runtimeFacts()` currently receives the entire `records` array and eagerly builds all runtime launches before the inspector renders:

- `runtimeVisitHistories()` constructs every state/action visit;
- `runtimeMapVisitHistories()` constructs every map visit and copies every visit's instances;
- `actorInternalMessageHistories()` replays actor messages and generations;
- session progress/messages are attached across complete visit histories;
- `HyperchartStateInfo.visitHistory`, `mapConfig.visitHistory`, actor generation histories, sent-message arrays, and mailbox histories are embedded in `HyperchartRunInfo`;
- `RuntimeSection`, `VisitHistory`, `MapVisitHistory`, `ActorMailboxCard`, and actor-generation components synchronously render those arrays.

This entire path must be split. Merely paginating raw records while retaining eager `runtimeFacts()` would not fix inspector loading.

#### Overview payload

The initial run/branch load returns only graph/control data and small runtime summaries:

```ts
export interface HyperchartRunOverview {
  run: HyperchartRunSummaryInfo;
  branch: BranchSummary;
  branchCount: number;
  initialBranches: BranchListChunk;
  states: readonly HyperchartStateOverview[];
  actors: readonly HyperchartActorOverview[];
  snapshot: HistorySnapshot;
}

export interface HyperchartStateRuntimeSummary {
  status: HyperchartStateStatus;
  visitCount: number;
  latestVisit?: HyperchartVisitSummary;
  activeSession?: HyperchartAgentSessionSummary;
  usage?: HyperchartUsageInfo;
  issueCount: number;
  actorMessageCount: number;
  mapVisitCount?: number;
  hasOlderRuntime: boolean;
}
```

The overview explicitly does **not** contain:

- `visitHistory`;
- `mapConfig.visitHistory`;
- actor `generationHistory` arrays;
- actor sent/processed message arrays;
- historical mailbox instances;
- transcript messages;
- record tree/history.

Current/live session summary may appear in overview, but transcript messages do not.

#### Serializable host data source

`RunHistoryStore` and `HyperchartHostAdapter` use the same stateless cursor-chunk semantics. The host adapter only scopes requests by `runId` and maps durable domain values to serializable host models:

```ts
export interface HyperchartInspectorDataSource {
  listBranches(input: {
    runId: string;
    cursor?: BranchListCursor;
  }): Promise<BranchListChunk>;

  readStateVisits(input: {
    runId: string;
    snapshot: HistorySnapshot;
    stateId: StatePath;
    cursor?: HistoryCursor;
  }): Promise<HistoryChunk<HyperchartVisitInfo>>;

  readMapVisits(input: {
    runId: string;
    snapshot: HistorySnapshot;
    mapPath: StatePath;
    cursor?: HistoryCursor;
  }): Promise<HistoryChunk<HyperchartMapVisitInfo>>;

  readActorGenerations(input: {
    runId: string;
    snapshot: HistorySnapshot;
    logicalOccurrence: StatePath;
    cursor?: HistoryCursor;
  }): Promise<HistoryChunk<HyperchartActorGenerationInfo>>;

  readActorMessages(input: {
    runId: string;
    snapshot: HistorySnapshot;
    occurrence: StatePath;
    cursor?: HistoryCursor;
  }): Promise<HistoryChunk<HyperchartActorMessageInfo>>;

  readRecords(input: {
    runId: string;
    snapshot: HistorySnapshot;
    cursor?: HistoryCursor;
  }): Promise<HistoryChunk<HyperchartRecordInfo>>;

  cursorAt(input: {
    runId: string;
    snapshot: HistorySnapshot;
    subject: HistorySubject;
    seqId: number;
  }): Promise<HistoryCursor | undefined>;

  readVisitSession(input: {
    runId: string;
    branchId: BranchId;
    invokeSeqId: number;
  }): Promise<HyperchartAgentSessionInfo | undefined>;
}
```

Every method is idempotent and independently retryable. Older and newer edge requests may execute concurrently. No adapter method creates or retains a resource-holding reader object.

#### React loading flow

1. Opening/polling the inspector loads `HyperchartRunOverview` only.
2. Graph cards and collapsed Runtime sections render `HyperchartStateRuntimeSummary` only.
3. Expanding a state's Runtime section triggers `readStateVisits()` for its first chunk.
4. Expanding map history, actor generations, or mailbox history triggers only its specific chunk query; opening one kind never fetches the others.
5. Scrolling toward an unloaded edge calls the same adapter with the edge's `older` or `newer` cursor; an absent cursor means that edge has been reached.
6. Expanding one visit shows summary/details already in that visit row but does not load transcript messages.
7. Clicking “View session” calls `readVisitSession(invokeSeqId)` on demand.
8. Branch selection captures a new `HistorySnapshot` and clears detail caches for the new branch.
9. Polling overview does not mutate already-loaded chunks tied to the old snapshot. The UI may offer “Refresh history” to capture the new head.
10. Component unmount/branch switch cancels in-flight reads and ignores late responses.

Client cache key:

```ts
[
  runId,
  snapshot.branchId,
  snapshot.headSeqId,
  detailKind,
  subjectId,
  cursor,
]
```

`RuntimeSection` receives summary plus loader callbacks/state. `VisitHistory`, `MapVisitHistory`, `ActorMailboxCard`, and actor-generation history no longer receive complete arrays from `HyperchartStateInfo`.

#### Bidirectional virtualized sliding window

Add one production component/hook shared by every potentially large Runtime history:

```ts
const HISTORY_WINDOW_ITEMS = 1_000;
const HISTORY_VIRTUAL_OVERSCAN = 20;

type HistoryWindow<T> = Readonly<{
  items: readonly T[];              // always <= HISTORY_WINDOW_ITEMS
  older?: HistoryCursor;
  newer?: HistoryCursor;
  
}>;
```

Implementation requirements:

- Use `@tanstack/react-virtual` for DOM virtualization and measured variable-height rows; do not implement a custom virtualizer.
- Render only the visible range plus 20-row overscan.
- Start with the newest chunk for ordinary Runtime expansion. For a targeted/deep-linked item, call `cursorAt(snapshot, subject, seqId)` and load the chunk around the minted cursor.
- Trigger older loading when the viewport approaches the older edge and newer loading when it approaches the newer edge.
- Keep at most 1,000 decoded items in React state.
- After appending an older chunk beyond 1,000 items, evict items from the newer edge and retain `newer` so they can be reloaded.
- After prepending a newer chunk beyond 1,000 items, evict items from the older edge and retain `older`.
- Preserve the visible anchor record and its pixel offset when prepending, appending, measuring variable-height rows, or evicting the opposite edge; loading must not jump the scroll position.
- Deduplicate overlapping chunks by stable durable identity (`invokeSeqId`, `spawnSeqId`, generation coordinate, message ID + lifecycle coordinate, or record `seqId`).
- Permit only one request per edge; abort/ignore stale responses after branch/snapshot/subject changes.
- Keep edge-specific loading and retry errors so failure on one edge does not discard the current window or block the other edge.
- New commits do not mutate the captured snapshot. “Refresh to latest” captures a new snapshot, loads its newest chunk, and preserves the previously selected subject.
- Transcript/session payloads remain outside the 1,000-item window and load only for the opened visit.

Add:

- `packages/hyperchart/src/react/components/inspector/history/VirtualizedHistoryList.tsx`;
- `packages/hyperchart/src/react/components/inspector/history/useHistoryWindow.ts`;
- focused unit tests for bidirectional merge, deduplication, edge eviction, anchor preservation, cancellation, retry, and the strict 1,000-item cap.

#### Dedicated Storybook board

Add a separate **Runtime History — Virtualized Cursor Chunks** board; do not hide these cases inside the general State Details board. Use the production inspector data-source contract and production components.

Required cases:

1. 10,000 state visits, initial newest chunk, scroll to load older.
2. Initial middle/deep-linked chunk, load both newer and older.
3. More than 1,000 loaded visits, verify opposite-edge eviction and reload.
4. Variable-height visit rows with outputs, validation errors, artifacts, and sessions; verify no scroll jump.
5. 10,000 map launches.
6. 10,000 actor generations.
7. 10,000 actor messages/mailbox entries.
8. Empty history.
9. Older-edge failure/retry while newer loading remains usable.
10. Newer-edge failure/retry while older loading remains usable.
11. Branch/snapshot switch with in-flight requests cancelled/ignored.
12. Refresh-to-latest while an older sliding window is open.
13. Transcript-on-demand proving messages are absent until a visit is opened.

Story fixtures must follow the production normalized-chart → durable log → host adapter → React pipeline required by `AGENTS.md`. Controlled latency/failure wrappers may decorate the production data source for loading/error stories; semantic host models must not be hand-authored. Structural Storybook tests assert the dedicated board and all cases exist. Browser interaction tests scroll both directions and assert that rendered DOM rows remain bounded by visible rows plus overscan while retained data never exceeds 1,000 items.

#### TUI

TUI uses the same overview and stateless recent-record chunks. Opening state details loads one chunk; “more” sends its older cursor. Polling never requests history chunks and never loads ancestry.

## Files to modify

Critical production seams:

- `packages/hyperchart/src/core/projection.ts` — remove elapsed histories, add current artifact pins, retain synchronous semantics.
- `packages/hyperchart/src/core/replay_check.ts` — incremental replay accumulator.
- `packages/hyperchart/src/core/machine.ts` — adapt only to the cleaned synchronous projection shape.
- `packages/hyperchart/src/runtime/generic/log_store.ts` — stateless bounded history-chunk contracts and private replay-stream contract; remove `readAncestry`.
- `packages/hyperchart/src/runtime/generic/memory_log_store.ts` — stateless history chunks and in-memory replay behavior.
- `packages/hyperchart/src/runtime/generic/postgres_log_store.ts` — sequence counter, persistent catalog roots/nodes/links, stateless bounded history queries, private replay stream, checkpoints, and atomic writes.
- `packages/hyperchart/src/runtime/generic/log_store_factory.ts` — open projection-aware backends once.
- `packages/hyperchart/src/runtime/generic/projection_loader.ts` (new) — execution-owned checkpoint selection, synchronous projection/GC, and replay accumulation orchestration.
- `packages/hyperchart/src/runtime/generic/chart_runtime.ts` and `execution_loop.ts` — call the projection loader, create the machine, and maintain incremental in-memory projection.
- `packages/hyperchart/src/runtime/generic/runner_main.ts` — remove repeated replay/workspace/outcome ancestry reads.
- `packages/hyperchart/src/runtime/generic/user_interaction_admission.ts` and `user_interactions.ts` — current projection plus targeted gate indexes.
- `packages/hyperchart/src/runtime/generic/artifact_store.ts` / artifact helpers — materialize current pins without history scan.
- `packages/hyperchart/src/runtime/generic/branches.ts` and `rewind.ts` — target checkpoints and bounded history selection.
- `packages/hyperchart/src/inspect/run_inspect.ts` — overview only; no eager records.
- `packages/hyperchart/src/host/models.ts`, `host/adapter.ts`, and `host/adapters.ts` — overview and lazy history APIs.
- `packages/hyperchart/src/react/components/inspector/**` — on-demand details plus shared bidirectional virtualized sliding-window histories.
- `packages/hyperchart/package.json` and workspace lockfile — add `@tanstack/react-virtual` for production virtualization.
- `.storybook/**` / inspector story files — dedicated Runtime History virtualization board and interaction fixtures.
- `packages/pi-hyperchart/src/runtime/pi/host_adapter.ts`, `src/tui/**`, and `extensions/hyperchart.ts` — consume overview/pages.
- `packages/claude-hyperchart/**` — adapt affected run inspection/tool surfaces.
- `tla/Hyperchart.tla`, `tla/HyperchartTrace.tla`, and trace export when projection semantics change.
- canonical runtime/API/safety/development docs and relevant package READMEs.

Tests to update/add include `tests/log_store.test.ts`, `tests/postgres_log_store.test.ts`, runtime/replay/rewind/branch/user-interaction tests, host/inspector/TUI tests, Storybook structural tests, and large-history boundedness fixtures.

## Reuse

- `createBranchProjection` / `projectBranch` in `packages/hyperchart/src/core/projection.ts` remain the synchronous semantic authority.
- `explainReplay` and replay compatibility rules in `packages/hyperchart/src/core/replay_check.ts` become incremental rather than replaced.
- Existing `parentId` journal topology and `containsInAncestry` recursive query in `packages/hyperchart/src/runtime/generic/postgres_log_store.ts` provide bounded traversal foundations.
- Existing `getRecord`, branch-head queries, PostgreSQL writer/advisory lock, transaction wrapper, host participant transaction, and uncertain-commit poisoning remain storage primitives orchestrated by execution/admission code.
- Existing JSONL private materialized index serves file-backed stateless history chunks and private projection replay; it is not exposed and gains no persistent checkpoint/catalog layer.
- JSONL persistence remains journal-only; no new sidecar write protocol is introduced.
- Existing `hyperchartRunFromRuntime` host projection logic is split into overview summaries and on-demand cursor-chunk detail adapters rather than duplicated.

## Steps

- [ ] Phase 0: clear the disposable PostgreSQL development data, define `next_seq` in the new initial schema, keep trusted-storage behavior, and stabilize/commit the current targeted-query refactor without adding migration/compatibility code or new ancestry callers.
- [ ] Phase 0.5: build the isolated PostgreSQL catalog prototype and run the benchmark gate below before integrating HAMT/catalog code into runtime production paths.
- [ ] Phase 1: introduce snapshot-bound stateless history chunks, read-committed branch keyset pagination, and `cursorAt`; add the benchmark-approved persistent catalog with branch-versioned forward keys; implement capped older/newer traversal plus the private oldest-first `AsyncIterable` replay stream.
- [ ] Phase 2: remove resolved interactions and settled message histories from `BranchProjection`; add current artifact pins; compile conservative AST retention plans and synchronous projection GC; keep all synchronously required retained state; update semantic model/tests/TLA together.
- [ ] Phase 3: add projection contract digest/version and nearest-compatible PostgreSQL checkpoints/cadence; keep JSONL projection/index state in memory only; add finite-log equivalence tests.
- [ ] Phase 4: migrate runtime startup/restart, replay gate, gate admission, response lookup, artifact materialization, fork, rewind, and final-outcome paths.
- [ ] Phase 5: add inspector overview and bidirectional stateless cursor-chunk host APIs; implement the `@tanstack/react-virtual` 1,000-item sliding window; migrate React inspector, Pi adapter/extension/TUI, and Claude surfaces; add the dedicated Runtime History Storybook board and interaction tests.
- [ ] Phase 6: delete `readAncestry` and full-history snapshots from all production interfaces; add import-boundary tests preventing host/UI access to replay streams; update canonical/package docs.

## PostgreSQL catalog benchmark gate

The persistent catalog is not accepted from design reasoning alone. Before production integration, add an isolated benchmark under `benchmarks/postgres-catalog/` with schema/setup, deterministic data generator, workload runner, query-plan capture, and a Markdown/JSON result report. It runs explicitly against a disposable PostgreSQL container and is not part of the ordinary unit-test suite.

### Compared implementations

Benchmark at least:

1. current record-by-record ancestry recursive CTE without catalog;
2. catalog root + immutable HAMT + `previous_seq_id` links;
3. if linked-page cold reads are inadequate, the same HAMT root with immutable multi-entry history blocks.

The stateless history-chunk contract and workloads remain identical across variants.

### Dataset shapes

Generate the same durable facts and catalog-key distribution for increasing sizes `10^5`, `10^6`, `10^7`, and `10^8`:

1. **Linear:** one branch, every record points to the preceding record.
2. **Branch per record:** every record creates a new named branch from the preceding record, producing 100 million branch heads and ancestry depth 100 million.
3. **Wide fan-out:** every record has the same early parent, stressing structural sharing and unrelated roots.
4. **Random historical parent:** deterministic seeded parent selection over the existing record set.

For each shape, generate:

- one hot catalog key updated by every record;
- sparse keys updated once per 10, 1,000, and 1,000,000 records;
- high-cardinality keys used only once;
- a realistic mixed distribution of state visits, actor messages, map visits, gate responses, artifact revisions, and projection checkpoints;
- the mandatory unique membership key for every record, branch-versioned forward keys, and records affecting zero, one, or several additional semantic-history keys.

The generator must bulk-create the base journal without loading it into Node memory. Catalog variants are built through their real transactional write/update implementation, not a different offline shortcut.

### Measured operations

Measure warm and cold-cache distributions for:

- append from current head;
- append from a random historical parent;
- creating a new branch head;
- HAMT lookup of hot, sparse, missing, and collision keys;
- first stateless chunk of 100 matching records;
- older and newer cursor chunks, including concurrent reads from both edges;
- `cursorAt` for a deep-linked durable coordinate;
- raw unfiltered history read of 100 parent records;
- nearest compatible checkpoint lookup;
- first and subsequent keyset chunks of the 100-million-branch list;
- deletion of one complete run including catalog nodes that are not shared outside it.

Capture:

- throughput and p50/p95/p99 latency;
- `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)`;
- rows examined and recursive iterations;
- shared-buffer hits/reads and temporary I/O;
- HAMT nodes and bytes written per changed key;
- total relation/index size and bytes per journal record;
- WAL bytes per append;
- Node process peak RSS for the benchmark driver;
- PostgreSQL CPU and resident memory.

Warm runs execute after a fixed preconditioning pass. Cold runs use a fresh PostgreSQL restart plus a dataset materially larger than configured shared buffers/RAM working set, then issue deterministic random-head queries so results cannot rely on one cached path. Record PostgreSQL configuration and machine/storage details in the report.

### Structural acceptance conditions

The catalog design is rejected before production integration unless all conditions hold:

- filtered lookup/read cost is independent of total ancestry length: increasing from `10^6` to `10^8` may not increase rows examined, recursive depth, or HAMT depth for the same key distribution;
- every history chunk returns at most 100 items; older reads perform at most 100 history-link probes, and newer reads perform at most 100 branch-versioned forward-key lookups;
- query plans contain no sequential scan, ancestry intersection, unbounded recursive walk, or sort over journal ancestry;
- missing and once-per-million sparse keys do not scan intervening journal records;
- branch-per-record and random-parent results are identical to a reference ancestry implementation on sampled heads;
- catalog storage grows linearly with inserted records/changed keys, and measured nodes/bytes per changed key stabilize rather than increasing with ancestry depth;
- append and read reports include both warm and cold p95/p99 numbers, storage amplification, and WAL amplification for explicit review;
- the chosen HAMT fan-out, node encoding, collision representation, and link-versus-block history format are written back into this plan from benchmark evidence before runtime implementation begins.

A scaled `100_000`-record version runs in automated tests and asserts structural bounds/query plans. The full 100-million benchmark is an explicit release/design gate artifact, not a per-commit CI job.

### Phase 0.5 benchmark outcome (2026-09-02)

The isolated 16-way, canonical-JSON-node HAMT candidate was measured in a corrected four-shape 100,000-record matrix under `benchmarks/postgres-catalog/results/`. Candidate, baseline-only, and instrumentation storage are separated; TOAST and indexes are counted exactly once; measured append WAL excludes baseline facts and instrumentation writes. One hundred warm/cold samples use distinct deterministic roots and clear the driver node cache. All bounded-query, complete-key probe, arbitrary-parent equivalence, divergent-forward, sparse/missing, and shared-node deletion checks pass.

The physical candidate is nevertheless **rejected** and must not be integrated:

- linear: 44,810 candidate bytes/record, 5.89 nodes and 4,505 canonical node bytes per changed key, 59 KB warm append WAL mean, and 107 ms warm newer-chunk p99;
- branch-per-record: 45,344 candidate bytes/record and 169 KB warm append WAL mean;
- random-parent: 12,698 candidate bytes/record;
- wide fan-out: 6,133 candidate bytes/record.

At only 100,000 linear records the candidate already occupies 4.50 GB versus 106 MB for the ancestry baseline. Linear extrapolation alone is roughly 4.5 TB at 100 million records, before the observed HAMT path depth/node amplification grows further. The linked forward-key newer path also requires up to 100 HAMT lookups and is already two orders of magnitude slower than wide-fanout reads. Because root-map copy-on-write amplification dominates the result, changing only history links to multi-entry blocks cannot make this candidate acceptable; escalation and production integration stop here. Phase 1 is blocked until a revised persistent catalog representation is explicitly approved and benchmarked.

## Verification

- Focused projection, store, replay, runtime, gate, fork, rewind, artifact, host, inspector, and TUI tests.
- Real-container PostgreSQL tests for sequence allocation, transaction atomicity, catalog inheritance across arbitrary parents, checkpoint lookup, older/newer cursor chunks, `cursorAt`, and uncertain commits.
- Equivalence tests proving private fixed-batch `AsyncIterable` replay equals legacy finite replay.
- The PostgreSQL catalog benchmark gate above, with its full JSON/Markdown report retained as an artifact and the selected physical catalog parameters copied into the final design.
- Large-history instrumentation proving every SQL result, public history chunk, and private projector batch respects backend-private constants.
- Snapshot cursor remains stable after append/rewind/branch movement.
- Missing/stale/incompatible PostgreSQL checkpoints rebuild without journal mutation; JSONL malformed/incomplete input still fails without repair.
- Chart digest/projector version mismatch performs bounded streaming compatibility replay.
- JSONL malformed/incomplete tail fails with bytes unchanged.
- `npm run typecheck`, full tests, `npm run validate:packages`, `npm run build-storybook`, and `git diff --check`.
- All TLA+ models and sample trace validation required by `AGENTS.md`.

## Acceptance criteria

- No production caller can request complete ancestry, and filtered history never computes/intersects ancestry at read time.
- Healthy startup and inspector overview use a compatible checkpoint plus at most 511 tail records.
- Every storage query/result and projector batch has a hard bound; filtered reads start from the captured head's catalog root and touch only matching links.
- Machine/projector remain synchronous.
- Finite-run behavior remains projection-equivalent.
- Journal facts remain authoritative and trusted.
- Historical pages remain stable after branch movement.
- Fork/rewind preserve ancestry semantics.
- PostgreSQL gate response performs no full ancestry replay.
- Inspector/TUI never eagerly build complete histories.
- Documentation describes checkpoints as disposable derived data, never authoritative state.
