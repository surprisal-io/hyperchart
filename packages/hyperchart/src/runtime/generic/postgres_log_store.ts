import { isDeepStrictEqual } from "node:util";
import { isDurableRecordEntry, type BranchHead, type BranchId, type BranchMetadata, type DurableLogRecord, type DurableRecordDraft, type StorageEntry } from "../../core/durable_events.js";
import {
	DEFAULT_BRANCH_ID,
	HISTORY_READ_ITEMS,
	assertDurableRecordDraft,
	cursorAtItems,
	decodeBranchListCursor,
	encodeBranchListCursor,
	findUserInteractionResponseInAncestry,
	historyChunkFromItems,
	historyItemsForSubject,
	type ActorGenerationHistoryItem,
	type ActorMessageHistoryItem,
	type BranchListChunk,
	type BranchListCursor,
	type HistoryChunk,
	type HistoryCursor,
	type HistorySnapshot,
	type HistorySubject,
	type MapVisitHistoryItem,
	type ProjectionCheckpointLookup,
	type RunLogStore,
	type RunMeta,
	type RespondToUserInteractionInput,
	type StateVisitHistoryItem,
	type StoredProjectionCheckpoint,
	type UserInteractionResponseCommit,
} from "./log_store.js";
import type { StatePath } from "../../core/types.js";
import { prepareUserInteractionResponse } from "./user_interaction_admission.js";

export const JOURNAL_TABLE = "hyperchart_journal";
export const JOURNAL_CHANNEL = "hyperchart_journal";
export const RUN_META_TABLE = "hyperchart_run_meta";
export const PROJECTION_CHECKPOINT_TABLE = "hyperchart_projection_checkpoint";
const JOURNAL_DDL = `CREATE TABLE IF NOT EXISTS ${JOURNAL_TABLE} (
  run_id text NOT NULL,
  seq bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('record', 'branch_create', 'branch_move')),
  branch_id text NOT NULL,
  parent_id bigint,
  head_seq_id bigint,
  record_type text,
  payload jsonb,
  metadata jsonb,
  committed_at_ms bigint NOT NULL,
  PRIMARY KEY (run_id, seq),
  CHECK (seq > 0),
  CHECK (
    (kind = 'record' AND seq > 0 AND head_seq_id IS NULL
      AND record_type IS NOT NULL AND payload IS NOT NULL AND metadata IS NULL)
    OR
    (kind = 'branch_create' AND parent_id IS NULL
      AND record_type IS NULL AND payload IS NULL)
    OR
    (kind = 'branch_move' AND parent_id IS NULL
      AND record_type IS NULL AND payload IS NULL AND metadata IS NULL)
  )
)`;
const RUN_META_DDL = `CREATE TABLE IF NOT EXISTS ${RUN_META_TABLE} (
  run_id text PRIMARY KEY,
  chart_path text,
  export_name text,
  work_dir text,
  chart_id text,
  created_at text,
  origin_session_id text,
  next_seq bigint NOT NULL DEFAULT 1,
  CHECK (
    (chart_path IS NULL AND export_name IS NULL AND work_dir IS NULL
      AND chart_id IS NULL AND created_at IS NULL AND origin_session_id IS NULL)
    OR
    (chart_path IS NOT NULL AND work_dir IS NOT NULL
      AND chart_id IS NOT NULL AND created_at IS NOT NULL)
  )
)`;
const PROJECTION_CHECKPOINT_DDL = `CREATE TABLE IF NOT EXISTS ${PROJECTION_CHECKPOINT_TABLE} (
  run_id text NOT NULL,
  checkpoint_id text NOT NULL,
  head_seq_id bigint,
  projector_version integer NOT NULL,
  ast_digest text NOT NULL,
  projection jsonb NOT NULL,
  created_at_ms bigint NOT NULL,
  PRIMARY KEY (run_id, checkpoint_id),
  FOREIGN KEY (run_id, head_seq_id) REFERENCES ${JOURNAL_TABLE}(run_id, seq)
)`;
const PROJECTION_CHECKPOINT_IDENTITY_DDL = `CREATE UNIQUE INDEX IF NOT EXISTS hyperchart_projection_identity_idx
  ON ${PROJECTION_CHECKPOINT_TABLE}(run_id, COALESCE(head_seq_id, -1), projector_version, ast_digest)`;
const JOURNAL_PARENT_INDEX_DDL = `CREATE INDEX IF NOT EXISTS hyperchart_journal_parent_idx
  ON ${JOURNAL_TABLE}(run_id, parent_id) WHERE kind = 'record'`;
const JOURNAL_BRANCH_INDEX_DDL = `CREATE INDEX IF NOT EXISTS hyperchart_journal_branch_latest_idx
  ON ${JOURNAL_TABLE}(run_id, branch_id, seq DESC)`;
const JOURNAL_BRANCH_CREATE_INDEX_DDL = `CREATE INDEX IF NOT EXISTS hyperchart_journal_branch_create_idx
  ON ${JOURNAL_TABLE}(run_id, branch_id, seq) WHERE kind = 'branch_create'`;

export type PostgresLogAccess = "writer" | "read";
export type OpenPostgresLogStoreOptions = Readonly<{ dsn: string; runId: string; branchId?: BranchId; onWarn?: (message: string) => void; access?: PostgresLogAccess }>;
export type PgQueryResult = { rows: Record<string, unknown>[] };
export type PgClientLike = {
	connect(): Promise<void>;
	query(text: string, values?: readonly unknown[]): Promise<PgQueryResult>;
	end(): Promise<void>;
	on(event: "error", listener: (error: Error) => void): unknown;
};

type JournalSqlRow = {
	seq: string | number;
	kind: "record" | "branch_create" | "branch_move";
	branch_id: string;
	parent_id: string | number | null;
	head_seq_id: string | number | null;
	record_type: string | null;
	payload: unknown;
	metadata: unknown;
	committed_at_ms: string | number;
};

type SharedPgJournal = {
	client: PgClientLike;
	runId: string;
	access: PostgresLogAccess;
	writeChain: Promise<void>;
	closed: boolean;
	poisoned: boolean;
};

export type SqlCommitTransaction = Readonly<{
	query(text: string, values?: readonly unknown[]): Promise<PgQueryResult>;
}>;
export type SqlCommitParticipant<T> = (tx: SqlCommitTransaction) => Promise<T>;
export type PostgresRunTransaction = SqlCommitTransaction & Readonly<{
	appendDrafts(branchId: BranchId, drafts: readonly DurableRecordDraft[]): Promise<readonly DurableLogRecord[]>;
	createBranch(branchId: BranchId, headSeqId: number, metadata?: BranchMetadata): Promise<BranchHead>;
	moveBranch(branchId: BranchId, headSeqId: number | null): Promise<BranchHead>;
	respondToUserInteraction(branchId: BranchId, input: RespondToUserInteractionInput): Promise<UserInteractionResponseCommit>;
	saveProjectionCheckpoint(checkpoint: StoredProjectionCheckpoint): Promise<void>;
}>;
export type PostgresForkAndCommitInput = Readonly<{
	sourceBranchId: BranchId;
	newBranchId: BranchId;
	fromSeqId: number;
	responseBranchId: BranchId;
	metadata?: BranchMetadata;
	response: RespondToUserInteractionInput;
}>;
export interface SqlTransactionalRunLogStore extends RunLogStore {
	commitUserInteraction<T>(branchId: BranchId, response: RespondToUserInteractionInput, participate: SqlCommitParticipant<T>): Promise<{ response: UserInteractionResponseCommit; participant: T }>;
	forkAndCommitUserInteraction<T>(input: PostgresForkAndCommitInput, participate: SqlCommitParticipant<T>): Promise<{ branch: BranchHead; response: UserInteractionResponseCommit; participant: T }>;
}

export class PostgresLogStore implements RunLogStore {
	readonly canSaveProjectionCheckpoints: boolean;
	private constructor(private readonly journal: SharedPgJournal, readonly branchId: BranchId) {
		this.canSaveProjectionCheckpoints = journal.access === "writer";
	}

	static async open(options: OpenPostgresLogStoreOptions): Promise<PostgresLogStore> {
		const access = options.access ?? "read";
		const branchId = options.branchId ?? DEFAULT_BRANCH_ID;
		const client = await connectPg(options.dsn, options.onWarn ?? (() => {}));
		try {
			if (access === "writer") {
				await ensureJournalTable(client);
				await ensureRunMetaTable(client);
				await ensureProjectionCheckpointTable(client);
				const locked = await client.query("SELECT pg_try_advisory_lock(hashtextextended('hyperchart:run:' || $1, 0)) AS locked", [options.runId]);
				if (locked.rows[0]?.locked !== true) throw new Error(`Another live writer holds Hyperchart run '${options.runId}' in Postgres; stop it before writing`);
			}
			return new PostgresLogStore({ client, runId: options.runId, access, writeChain: Promise.resolve(), closed: false, poisoned: false }, branchId);
		} catch (error) { await client.end().catch(() => {}); throw error; }
	}

	forBranch(branchId: BranchId): PostgresLogStore { return new PostgresLogStore(this.journal, branchId); }

	async captureSnapshot(branchId: BranchId): Promise<HistorySnapshot> {
		const branch = await this.getBranch(branchId);
		return { branchId, headSeqId: branch.headSeqId };
	}
	async listBranches(cursor?: BranchListCursor): Promise<BranchListChunk> {
		await this.awaitReadable();
		return listBranchesDirect(this.journal.client, this.journal.runId, this.journal.access, cursor);
	}
	async getBranch(branchId: BranchId): Promise<BranchHead> {
		await this.awaitReadable();
		return requireBranch(await findBranchDirect(this.journal.client, this.journal.runId, branchId, this.journal.access), branchId);
	}
	async getRecord(seqId: number): Promise<DurableLogRecord | undefined> {
		await this.awaitReadable();
		return findRecordDirect(this.journal.client, this.journal.runId, seqId, this.journal.access);
	}
	async containsInHistory(input: { headSeqId: number | null; seqId: number }): Promise<boolean> {
		await this.awaitReadable();
		return containsInHistoryDirect(this.journal.client, this.journal.runId, input.headSeqId, input.seqId, this.journal.access);
	}
	async readRecords(input: { snapshot: HistorySnapshot; cursor?: HistoryCursor }): Promise<HistoryChunk<DurableLogRecord>> { return this.readSubject(input.snapshot, { kind: "records" }, input.cursor) as Promise<HistoryChunk<DurableLogRecord>>; }
	async readStateVisits(input: { snapshot: HistorySnapshot; state: StatePath; cursor?: HistoryCursor }): Promise<HistoryChunk<StateVisitHistoryItem>> { return this.readSubject(input.snapshot, { kind: "state-visits", state: input.state }, input.cursor) as Promise<HistoryChunk<StateVisitHistoryItem>>; }
	async readMapVisits(input: { snapshot: HistorySnapshot; mapPath: StatePath; cursor?: HistoryCursor }): Promise<HistoryChunk<MapVisitHistoryItem>> { return this.readSubject(input.snapshot, { kind: "map-visits", mapPath: input.mapPath }, input.cursor) as Promise<HistoryChunk<MapVisitHistoryItem>>; }
	async readActorGenerations(input: { snapshot: HistorySnapshot; logicalOccurrence: StatePath; cursor?: HistoryCursor }): Promise<HistoryChunk<ActorGenerationHistoryItem>> { return this.readSubject(input.snapshot, { kind: "actor-generations", logicalOccurrence: input.logicalOccurrence }, input.cursor) as Promise<HistoryChunk<ActorGenerationHistoryItem>>; }
	async readActorMessages(input: { snapshot: HistorySnapshot; occurrence: StatePath; cursor?: HistoryCursor }): Promise<HistoryChunk<ActorMessageHistoryItem>> { return this.readSubject(input.snapshot, { kind: "actor-messages", occurrence: input.occurrence }, input.cursor) as Promise<HistoryChunk<ActorMessageHistoryItem>>; }
	async cursorAt(input: { snapshot: HistorySnapshot; subject: HistorySubject; seqId: number }): Promise<HistoryCursor | undefined> {
		const ancestry = await this.ancestryForSnapshot(input.snapshot);
		return cursorAtItems(input.snapshot, input.subject, historyItemsForSubject(ancestry, input.subject), input.seqId);
	}
	async findUserInteractionResponse(input: { headSeqId: number | null; gateSeqId: number }): Promise<Extract<DurableLogRecord, { type: "user_interaction"; kind: "resolved" }> | undefined> {
		await this.awaitReadable();
		const ancestry = await readAncestryToHeadDirect(this.journal.client, this.journal.runId, input.headSeqId, this.journal.access);
		return findUserInteractionResponseInAncestry(ancestry, input.gateSeqId);
	}
	async readAncestry(branchId: BranchId): Promise<readonly DurableLogRecord[]> {
		await this.awaitReadable();
		return readAncestryDirect(this.journal.client, this.journal.runId, branchId, this.journal.access);
	}
	async containsInAncestry(branchId: BranchId, seqId: number): Promise<boolean> {
		const snapshot = await this.captureSnapshot(branchId);
		return this.containsInHistory({ headSeqId: snapshot.headSeqId, seqId });
	}
	async countRecords(): Promise<number> {
		await this.awaitReadable();
		return countRecordsDirect(this.journal.client, this.journal.runId, this.journal.access);
	}
	async loadExactProjectionCheckpoint(input: ProjectionCheckpointLookup): Promise<StoredProjectionCheckpoint | undefined> {
		await this.awaitReadable();
		const rows = await queryRows(this.journal.client, this.journal.access,
			`SELECT checkpoint_id, head_seq_id, projector_version, ast_digest, projection, created_at_ms
			   FROM ${PROJECTION_CHECKPOINT_TABLE}
			  WHERE run_id = $1 AND head_seq_id IS NOT DISTINCT FROM $2
			    AND projector_version = $3 AND ast_digest = $4
			  ORDER BY created_at_ms DESC LIMIT 1`,
			[this.journal.runId, input.targetHeadSeqId, input.projectorVersion, input.astDigest]);
		return rows[0] === undefined ? undefined : decodeCheckpointRow(rows[0]);
	}
	async findNearestProjectionCheckpoint(input: ProjectionCheckpointLookup): Promise<StoredProjectionCheckpoint | undefined> {
		await this.awaitReadable();
		const rows = await queryRows(this.journal.client, this.journal.access,
			`WITH RECURSIVE ancestry AS (
			   SELECT seq, parent_id, 0 AS depth FROM ${JOURNAL_TABLE}
			    WHERE run_id = $1 AND seq = $2 AND kind = 'record'
			   UNION ALL
			   SELECT parent.seq, parent.parent_id, child.depth + 1
			     FROM ancestry child JOIN ${JOURNAL_TABLE} parent
			       ON parent.run_id = $1 AND parent.seq = child.parent_id AND parent.kind = 'record'
			 )
			 SELECT checkpoint_id, head_seq_id, projector_version, ast_digest, projection, created_at_ms
			   FROM ${PROJECTION_CHECKPOINT_TABLE} checkpoint
			   LEFT JOIN ancestry ON ancestry.seq = checkpoint.head_seq_id
			  WHERE checkpoint.run_id = $1 AND checkpoint.projector_version = $3 AND checkpoint.ast_digest = $4
			    AND (checkpoint.head_seq_id IS NULL OR ancestry.seq IS NOT NULL)
			  ORDER BY COALESCE(ancestry.depth, 2147483647), checkpoint.created_at_ms DESC LIMIT 1`,
			[this.journal.runId, input.targetHeadSeqId, input.projectorVersion, input.astDigest]);
		return rows[0] === undefined ? undefined : decodeCheckpointRow(rows[0]);
	}
	discardProjectionCheckpoint(checkpointId: string): Promise<void> {
		return this.transaction(async (tx) => { await tx.query(`DELETE FROM ${PROJECTION_CHECKPOINT_TABLE} WHERE run_id = $1 AND checkpoint_id = $2`, [this.journal.runId, checkpointId]); });
	}
	saveProjectionCheckpoint(checkpoint: StoredProjectionCheckpoint): Promise<void> {
		return this.transaction((tx) => tx.saveProjectionCheckpoint(checkpoint));
	}

	private async readSubject(snapshot: HistorySnapshot, subject: HistorySubject, cursor?: HistoryCursor): Promise<HistoryChunk<DurableLogRecord | StateVisitHistoryItem | MapVisitHistoryItem | ActorGenerationHistoryItem | ActorMessageHistoryItem>> {
		const ancestry = await this.ancestryForSnapshot(snapshot);
		return historyChunkFromItems(snapshot, subject, historyItemsForSubject(ancestry, subject), cursor);
	}
	private async ancestryForSnapshot(snapshot: HistorySnapshot): Promise<readonly DurableLogRecord[]> {
		await this.awaitReadable();
		await requireSnapshotBranchDirect(this.journal.client, this.journal.runId, snapshot, this.journal.access);
		return readAncestryToHeadDirect(this.journal.client, this.journal.runId, snapshot.headSeqId, this.journal.access);
	}

	async readRunMeta(): Promise<RunMeta | undefined> {
		await this.awaitReadable();
		try {
			const result = await this.journal.client.query(
				`SELECT chart_path, export_name, work_dir, chart_id, created_at, origin_session_id FROM ${RUN_META_TABLE} WHERE run_id = $1`,
				[this.journal.runId],
			);
			return result.rows[0] === undefined || result.rows[0].chart_path === null ? undefined : decodeRunMeta(result.rows[0]);
		} catch (error) { if (isUndefinedTable(error)) return undefined; throw error; }
	}
	writeRunMeta(meta: RunMeta): Promise<void> {
		return this.enqueueWrite(async () => {
			const { client, runId } = this.journal;
			try {
				await client.query("BEGIN");
				await client.query(
					`INSERT INTO ${RUN_META_TABLE} (run_id, chart_path, export_name, work_dir, chart_id, created_at, origin_session_id)
					 VALUES ($1, $2, $3, $4, $5, $6, $7)
					 ON CONFLICT (run_id) DO UPDATE SET
					   chart_path = EXCLUDED.chart_path,
					   export_name = EXCLUDED.export_name,
					   work_dir = EXCLUDED.work_dir,
					   chart_id = EXCLUDED.chart_id,
					   created_at = EXCLUDED.created_at,
					   origin_session_id = EXCLUDED.origin_session_id
					 WHERE ${RUN_META_TABLE}.chart_path IS NULL`,
					[runId, meta.chartPath, meta.exportName ?? null, meta.workDir, meta.chartId, meta.createdAt, meta.originSessionId ?? null],
				);
				const stored = await this.readRunMetaDirect();
				if (stored === undefined || !isDeepStrictEqual(stored, meta)) throw new Error(`Conflicting metadata for Hyperchart run '${runId}'`);
				await client.query("COMMIT");
			} catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
		});
	}
	deleteRunData(): Promise<void> {
		return this.enqueueWrite(async () => {
			const { client, runId } = this.journal;
			try {
				await client.query("BEGIN");
				await client.query(`DELETE FROM ${PROJECTION_CHECKPOINT_TABLE} WHERE run_id = $1`, [runId]);
				await client.query(`DELETE FROM ${RUN_META_TABLE} WHERE run_id = $1`, [runId]);
				await client.query(`DELETE FROM ${JOURNAL_TABLE} WHERE run_id = $1`, [runId]);
				await client.query("COMMIT");
			} catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
		});
	}
	private async readRunMetaDirect(): Promise<RunMeta | undefined> {
		const result = await this.journal.client.query(
			`SELECT chart_path, export_name, work_dir, chart_id, created_at, origin_session_id FROM ${RUN_META_TABLE} WHERE run_id = $1`,
			[this.journal.runId],
		);
		return result.rows[0] === undefined || result.rows[0].chart_path === null ? undefined : decodeRunMeta(result.rows[0]);
	}

	async initializeRootBranch(metadata: BranchMetadata = { name: this.branchId }): Promise<BranchHead> {
		return this.transaction(async (tx) => {
			const impl = tx as TransactionImpl;
			if (await impl.hasAnyEntry()) throw new Error("Cannot initialize a non-empty Hyperchart journal");
			return impl.createRootBranch(this.branchId, metadata);
		});
	}
	appendDrafts(drafts: readonly DurableRecordDraft[]): Promise<readonly DurableLogRecord[]> { return drafts.length === 0 ? Promise.resolve([]) : this.transaction((tx) => tx.appendDrafts(this.branchId, drafts)); }
	createBranch(branchId: BranchId, headSeqId: number, metadata?: BranchMetadata): Promise<BranchHead> { return this.transaction((tx) => tx.createBranch(branchId, headSeqId, metadata)); }
	moveBranch(branchId: BranchId, headSeqId: number | null): Promise<BranchHead> { return this.transaction((tx) => tx.moveBranch(branchId, headSeqId)); }
	respondToUserInteraction(input: RespondToUserInteractionInput): Promise<UserInteractionResponseCommit> { return this.transaction((tx) => tx.respondToUserInteraction(this.branchId, input)); }

	/** Managed transaction: journal mutations and host-domain SQL share one client and commit. */
	transaction<T>(task: (tx: PostgresRunTransaction) => Promise<T>): Promise<T> {
		return this.enqueueWrite(async () => {
			const { client, runId } = this.journal;
			let commitAttempted = false;
			try {
				await client.query("BEGIN");
				const result = await task(new TransactionImpl(client, runId));
				commitAttempted = true;
				await client.query("COMMIT");
				return result;
			} catch (error) {
				if (!commitAttempted) await client.query("ROLLBACK").catch(() => {});
				else {
					this.journal.poisoned = true;
					await client.end().catch(() => {});
				}
				throw normalizeUnique(error, runId);
			}
		});
	}

	commitUserInteraction<T>(branchId: BranchId, response: RespondToUserInteractionInput, participate: SqlCommitParticipant<T>): Promise<{ response: UserInteractionResponseCommit; participant: T }> {
		return this.transaction(async (tx) => ({ response: await tx.respondToUserInteraction(branchId, response), participant: await participate(restrictTransaction(tx)) }));
	}
	forkAndCommitUserInteraction<T>(input: PostgresForkAndCommitInput, participate: SqlCommitParticipant<T>): Promise<{ branch: BranchHead; response: UserInteractionResponseCommit; participant: T }> {
		if (input.responseBranchId !== input.sourceBranchId && input.responseBranchId !== input.newBranchId) {
			return Promise.reject(new Error("responseBranchId must be the source branch or the newly created branch"));
		}
		return this.transaction(async (tx) => {
			const impl = tx as TransactionImpl;
			if (!await impl.containsInAncestry(input.sourceBranchId, input.fromSeqId)) throw new Error(`Fork point ${input.fromSeqId} is not in source branch '${input.sourceBranchId}' ancestry`);
			const branch = await impl.ensureExactBranch(input.newBranchId, input.fromSeqId, input.metadata);
			const response = await tx.respondToUserInteraction(input.responseBranchId, input.response);
			const participant = await participate(restrictTransaction(tx));
			return { branch, response, participant };
		});
	}

	async close(): Promise<void> {
		if (this.journal.closed) return;
		this.journal.closed = true;
		await this.journal.writeChain.catch(() => {});
		await this.journal.client.end().catch(() => {});
	}
	private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
		if (this.journal.access !== "writer") return Promise.reject(new Error(`Hyperchart run '${this.journal.runId}' was opened read-only`));
		if (this.journal.closed) return Promise.reject(new Error("Postgres Hyperchart journal is closed"));
		if (this.journal.poisoned) return Promise.reject(new Error("Postgres Hyperchart journal is unusable after an uncertain commit"));
		const result = this.journal.writeChain.then(task);
		this.journal.writeChain = result.then(() => undefined, () => undefined);
		return result;
	}
	private async awaitReadable(): Promise<void> {
		if (this.journal.closed) throw new Error("Postgres Hyperchart journal is closed");
		if (this.journal.poisoned) throw new Error("Postgres Hyperchart journal is unusable after an uncertain commit");
		await this.journal.writeChain;
	}
}

class TransactionImpl implements PostgresRunTransaction {
	constructor(readonly client: PgClientLike, readonly runId: string) {}
	query(text: string, values?: readonly unknown[]): Promise<PgQueryResult> { return this.client.query(text, values); }
	async hasAnyEntry(): Promise<boolean> {
		const result = await this.client.query(`SELECT EXISTS (SELECT 1 FROM ${JOURNAL_TABLE} WHERE run_id = $1) AS present`, [this.runId]);
		return result.rows[0]?.present === true;
	}
	async createRootBranch(branchId: BranchId, metadata: BranchMetadata): Promise<BranchHead> {
		const committedAt = Date.now();
		await this.commitEntries([{ kind: "branch", op: "create", seqId: await this.allocateOne(), branchId, headSeqId: null, metadata, committedAt }]);
		return { branchId, headSeqId: null, createdAt: committedAt, metadata };
	}
	async appendDrafts(branchId: BranchId, drafts: readonly DurableRecordDraft[]): Promise<readonly DurableLogRecord[]> {
		if (drafts.length === 0) return [];
		const branch = requireBranch(await findBranchDirect(this.client, this.runId, branchId, "writer"), branchId);
		let seqId = await this.allocate(drafts.length);
		let parentId = branch.headSeqId;
		const now = Date.now();
		const records = drafts.map((draft) => {
			assertDurableRecordDraft(draft);
			const record = { ...draft, seqId: seqId++, parentId, branchId, timestamp: now } as DurableLogRecord;
			parentId = record.seqId;
			return record;
		});
		await this.commitEntries(records);
		return records;
	}
	async createBranch(branchId: BranchId, headSeqId: number, metadata?: BranchMetadata): Promise<BranchHead> {
		if (await findBranchDirect(this.client, this.runId, branchId, "writer") !== undefined) throw new Error(`Hyperchart branch '${branchId}' already exists`);
		if (await findRecordDirect(this.client, this.runId, headSeqId, "writer") === undefined) throw new Error(`No durable log record with seqId ${headSeqId}`);
		const committedAt = Date.now();
		await this.commitEntries([{ kind: "branch", op: "create", seqId: await this.allocateOne(), branchId, headSeqId, ...(metadata === undefined ? {} : { metadata }), committedAt }]);
		return { branchId, headSeqId, createdAt: committedAt, ...(metadata === undefined ? {} : { metadata }) };
	}
	async ensureExactBranch(branchId: BranchId, headSeqId: number, metadata?: BranchMetadata): Promise<BranchHead> {
		const existing = await findBranchDirect(this.client, this.runId, branchId, "writer");
		if (existing === undefined) return this.createBranch(branchId, headSeqId, metadata);
		if (!await containsInAncestryDirect(this.client, this.runId, branchId, headSeqId, "writer") || !isDeepStrictEqual(existing.metadata, metadata)) {
			throw new Error(`Conflicting retry for Hyperchart branch '${branchId}'`);
		}
		return existing;
	}
	async moveBranch(branchId: BranchId, headSeqId: number | null): Promise<BranchHead> {
		const branch = requireBranch(await findBranchDirect(this.client, this.runId, branchId, "writer"), branchId);
		if (headSeqId !== null && await findRecordDirect(this.client, this.runId, headSeqId, "writer") === undefined) throw new Error(`No durable log record with seqId ${headSeqId}`);
		await this.commitEntries([{ kind: "branch", op: "move", seqId: await this.allocateOne(), branchId, headSeqId, committedAt: Date.now() }]);
		return { ...branch, headSeqId };
	}
	async respondToUserInteraction(branchId: BranchId, input: RespondToUserInteractionInput): Promise<UserInteractionResponseCommit> {
		const prepared = await prepareUserInteractionResponse(await readAncestryDirect(this.client, this.runId, branchId, "writer"), branchId, input);
		if (prepared.kind === "idempotent") return { record: prepared.record, idempotent: true };
		const records = await this.appendDrafts(branchId, [prepared.draft]);
		return { record: records[0] as UserInteractionResponseCommit["record"], idempotent: false };
	}
	containsInAncestry(branchId: BranchId, seqId: number): Promise<boolean> { return containsInAncestryDirect(this.client, this.runId, branchId, seqId, "writer"); }
	saveProjectionCheckpoint(checkpoint: StoredProjectionCheckpoint): Promise<void> { return saveCheckpointDirect(this.client, this.runId, checkpoint); }
	private async allocateOne(): Promise<number> { return this.allocate(1); }
	private async allocate(count: number): Promise<number> {
		if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`Invalid Hyperchart sequence allocation size ${count}`);
		await this.client.query(
			`INSERT INTO ${RUN_META_TABLE} (run_id) VALUES ($1) ON CONFLICT (run_id) DO NOTHING`,
			[this.runId],
		);
		const result = await this.client.query(
			`UPDATE ${RUN_META_TABLE}
			    SET next_seq = next_seq + $2
			  WHERE run_id = $1
			  RETURNING next_seq - $2 AS first_seq`,
			[this.runId, count],
		);
		return pgNumber(result.rows[0]?.first_seq);
	}
	private async commitEntries(entries: readonly StorageEntry[]): Promise<void> {
		if (entries.length === 0) return;
		const values: unknown[] = [this.runId];
		const rows = entries.map((entry, index) => {
			const parameter = 2 + index * 9;
			if (isDurableRecordEntry(entry)) {
				const { seqId, parentId, branchId, type, ...payload } = entry;
				values.push(seqId, "record", branchId, parentId, null, type, JSON.stringify(payload), null, payload.timestamp);
			} else {
				values.push(entry.seqId, entry.op === "create" ? "branch_create" : "branch_move", entry.branchId, null, entry.headSeqId, null, null, entry.op === "create" && entry.metadata !== undefined ? JSON.stringify(entry.metadata) : null, entry.committedAt);
			}
			return `($1, $${parameter}, $${parameter + 1}, $${parameter + 2}, $${parameter + 3}, $${parameter + 4}, $${parameter + 5}, $${parameter + 6}::jsonb, $${parameter + 7}::jsonb, $${parameter + 8})`;
		});
		await this.client.query(
			`INSERT INTO ${JOURNAL_TABLE}
			   (run_id, seq, kind, branch_id, parent_id, head_seq_id, record_type, payload, metadata, committed_at_ms)
			 VALUES ${rows.join(", ")}`,
			values,
		);
		await this.client.query("SELECT pg_notify($1, $2)", [JOURNAL_CHANNEL, `${this.runId}:${entries.at(-1)!.seqId}`]);
	}
}

async function connectPg(dsn: string, onWarn: (message: string) => void): Promise<PgClientLike> {
	let pg: { Client: new (config: { connectionString: string }) => PgClientLike };
	try { pg = (await import("pg")) as unknown as typeof pg; }
	catch { throw new Error("Postgres Hyperchart log storage requires the optional 'pg' package; install it to use HYPERCHART_PG_DSN"); }
	const client = new pg.Client({ connectionString: dsn });
	client.on("error", (error) => onWarn(`Hyperchart Postgres journal connection error: ${error.message}`));
	await client.connect();
	return client;
}
async function ensureRunMetaTable(client: PgClientLike): Promise<void> {
	try { await client.query(RUN_META_DDL); }
	catch (error) { if (!isDuplicateObject(error)) throw error; await client.query(RUN_META_DDL); }
}
async function ensureProjectionCheckpointTable(client: PgClientLike): Promise<void> {
	try { await client.query(PROJECTION_CHECKPOINT_DDL); }
	catch (error) { if (!isDuplicateObject(error)) throw error; await client.query(PROJECTION_CHECKPOINT_DDL); }
	await client.query(PROJECTION_CHECKPOINT_IDENTITY_DDL);
}
async function ensureJournalTable(client: PgClientLike): Promise<void> {
	try { await client.query(JOURNAL_DDL); }
	catch (error) { if (!isDuplicateObject(error)) throw error; await client.query(JOURNAL_DDL); }
	await client.query(JOURNAL_PARENT_INDEX_DDL);
	await client.query(JOURNAL_BRANCH_INDEX_DDL);
	await client.query(JOURNAL_BRANCH_CREATE_INDEX_DDL);
}

async function listBranchesDirect(client: PgClientLike, runId: string, access: PostgresLogAccess, cursor?: BranchListCursor): Promise<BranchListChunk> {
	const decoded = cursor === undefined ? undefined : decodeBranchListCursor(cursor);
	const values: unknown[] = [runId];
	const boundary = decoded === undefined ? "" : "AND (seq, branch_id) > ($2, $3)";
	if (decoded !== undefined) values.push(decoded.createdSeqId, decoded.branchId);
	const [rows, totals] = await Promise.all([
		queryRows(client, access,
			`WITH creates AS (
			   SELECT seq AS created_seq_id, branch_id, metadata, committed_at_ms
			     FROM ${JOURNAL_TABLE}
			    WHERE run_id = $1 AND kind = 'branch_create' ${boundary}
			    ORDER BY seq, branch_id LIMIT ${HISTORY_READ_ITEMS + 1}
			 )
			 SELECT creates.created_seq_id, creates.branch_id,
			        CASE WHEN latest.kind = 'record' THEN latest.seq ELSE latest.head_seq_id END AS current_head_seq_id,
			        creates.metadata, creates.committed_at_ms
			   FROM creates
			   CROSS JOIN LATERAL (
			     SELECT kind, seq, head_seq_id
			       FROM ${JOURNAL_TABLE}
			      WHERE run_id = $1 AND branch_id = creates.branch_id
			      ORDER BY seq DESC LIMIT 1
			   ) latest
			  ORDER BY creates.created_seq_id, creates.branch_id`, values),
		queryRows(client, access, `SELECT COUNT(*) AS count FROM ${JOURNAL_TABLE} WHERE run_id=$1 AND kind='branch_create'`, [runId]),
	]);
	const page = rows.slice(0, HISTORY_READ_ITEMS);
	const last = page.at(-1);
	return {
		items: page.map(decodeBranchRow),
		totalCount: totals[0] === undefined ? 0 : pgNumber(totals[0].count),
		...(rows.length > page.length && last !== undefined ? { next: encodeBranchListCursor(pgNumber(last.created_seq_id), last.branch_id as BranchId) } : {}),
	};
}
async function findBranchDirect(client: PgClientLike, runId: string, branchId: BranchId, access: PostgresLogAccess): Promise<BranchHead | undefined> {
	const rows = await queryRows(client, access,
		`WITH created AS (
		   SELECT branch_id, metadata, committed_at_ms
		     FROM ${JOURNAL_TABLE}
		    WHERE run_id = $1 AND branch_id = $2 AND kind = 'branch_create'
		    ORDER BY seq LIMIT 1
		 ), latest AS (
		   SELECT kind, seq, head_seq_id
		     FROM ${JOURNAL_TABLE}
		    WHERE run_id = $1 AND branch_id = $2
		    ORDER BY seq DESC LIMIT 1
		 )
		 SELECT created.branch_id,
		        CASE WHEN latest.kind = 'record' THEN latest.seq ELSE latest.head_seq_id END AS current_head_seq_id,
		        created.metadata, created.committed_at_ms
		   FROM created CROSS JOIN latest`, [runId, branchId]);
	return rows[0] === undefined ? undefined : decodeBranchRow(rows[0]);
}
async function findRecordDirect(client: PgClientLike, runId: string, seqId: number, access: PostgresLogAccess): Promise<DurableLogRecord | undefined> {
	const rows = await queryRows(client, access, `SELECT seq, kind, branch_id, parent_id, head_seq_id, record_type, payload, metadata, committed_at_ms FROM ${JOURNAL_TABLE} WHERE run_id = $1 AND seq = $2 AND kind = 'record'`, [runId, seqId]);
	return rows[0] === undefined ? undefined : decodeRecordRow(rows[0] as JournalSqlRow);
}
async function readAncestryDirect(client: PgClientLike, runId: string, branchId: BranchId, access: PostgresLogAccess): Promise<DurableLogRecord[]> {
	const branch = await findBranchDirect(client, runId, branchId, access);
	if (branch === undefined) {
		if (!await hasAnyEntryDirect(client, runId, access)) return [];
		throw new Error(`Unknown Hyperchart branch '${branchId}'`);
	}
	return readAncestryToHeadDirect(client, runId, branch.headSeqId, access);
}
async function readAncestryToHeadDirect(client: PgClientLike, runId: string, headSeqId: number | null, access: PostgresLogAccess): Promise<DurableLogRecord[]> {
	if (headSeqId === null) return [];
	const rows = await queryRows(client, access,
		`WITH RECURSIVE ancestry AS (
		   SELECT seq, kind, branch_id, parent_id, head_seq_id, record_type, payload, metadata, committed_at_ms, 0 AS depth
		     FROM ${JOURNAL_TABLE}
		    WHERE run_id = $1 AND seq = $2 AND kind = 'record'
		   UNION ALL
		   SELECT parent.seq, parent.kind, parent.branch_id, parent.parent_id, parent.head_seq_id,
		          parent.record_type, parent.payload, parent.metadata, parent.committed_at_ms, child.depth + 1
		     FROM ancestry child
		     JOIN ${JOURNAL_TABLE} parent ON parent.run_id = $1 AND parent.seq = child.parent_id
		    WHERE parent.kind = 'record'
		 )
		 SELECT seq, kind, branch_id, parent_id, head_seq_id, record_type, payload, metadata, committed_at_ms
		   FROM ancestry ORDER BY depth DESC`, [runId, headSeqId]);
	if (rows.length === 0) throw new Error(`No durable log record with seqId ${headSeqId}`);
	return rows.map((row) => decodeRecordRow(row as JournalSqlRow));
}
async function requireSnapshotBranchDirect(client: PgClientLike, runId: string, snapshot: HistorySnapshot, access: PostgresLogAccess): Promise<void> {
	if (await findBranchDirect(client, runId, snapshot.branchId, access) === undefined) throw new Error(`Unknown Hyperchart branch '${snapshot.branchId}'`);
	if (snapshot.headSeqId !== null && await findRecordDirect(client, runId, snapshot.headSeqId, access) === undefined) throw new Error(`No durable log record with seqId ${snapshot.headSeqId}`);
}
async function containsInAncestryDirect(client: PgClientLike, runId: string, branchId: BranchId, seqId: number, access: PostgresLogAccess): Promise<boolean> {
	const branch = await findBranchDirect(client, runId, branchId, access);
	if (branch === undefined) {
		if (!await hasAnyEntryDirect(client, runId, access)) return false;
		throw new Error(`Unknown Hyperchart branch '${branchId}'`);
	}
	return containsInHistoryDirect(client, runId, branch.headSeqId, seqId, access);
}
async function containsInHistoryDirect(client: PgClientLike, runId: string, headSeqId: number | null, seqId: number, access: PostgresLogAccess): Promise<boolean> {
	if (headSeqId === null) return false;
	const rows = await queryRows(client, access,
		`WITH RECURSIVE ancestry AS (
		   SELECT seq, parent_id FROM ${JOURNAL_TABLE} WHERE run_id = $1 AND seq = $2 AND kind = 'record'
		   UNION ALL
		   SELECT parent.seq, parent.parent_id
		     FROM ancestry child JOIN ${JOURNAL_TABLE} parent ON parent.run_id = $1 AND parent.seq = child.parent_id
		    WHERE parent.kind = 'record'
		 ) SELECT EXISTS (SELECT 1 FROM ancestry WHERE seq = $3) AS present`, [runId, headSeqId, seqId]);
	return rows[0]?.present === true;
}
async function hasAnyEntryDirect(client: PgClientLike, runId: string, access: PostgresLogAccess): Promise<boolean> {
	const rows = await queryRows(client, access, `SELECT EXISTS (SELECT 1 FROM ${JOURNAL_TABLE} WHERE run_id = $1) AS present`, [runId]);
	return rows[0]?.present === true;
}
async function countRecordsDirect(client: PgClientLike, runId: string, access: PostgresLogAccess): Promise<number> {
	const rows = await queryRows(client, access, `SELECT COUNT(*) AS count FROM ${JOURNAL_TABLE} WHERE run_id = $1 AND kind = 'record'`, [runId]);
	return rows.length === 0 ? 0 : pgNumber(rows[0]?.count);
}
async function saveCheckpointDirect(client: PgClientLike, runId: string, checkpoint: StoredProjectionCheckpoint): Promise<void> {
	if (checkpoint.checkpointId.length === 0 || !Number.isSafeInteger(checkpoint.projectorVersion) || checkpoint.projectorVersion <= 0 || checkpoint.astDigest.length === 0 || !Number.isSafeInteger(checkpoint.createdAt)) {
		throw new Error("Invalid opaque Hyperchart projection checkpoint coordinates");
	}
	await client.query(
		`INSERT INTO ${PROJECTION_CHECKPOINT_TABLE}
		   (run_id, checkpoint_id, head_seq_id, projector_version, ast_digest, projection, created_at_ms)
		 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
		 ON CONFLICT DO NOTHING`,
		[runId, checkpoint.checkpointId, checkpoint.headSeqId, checkpoint.projectorVersion, checkpoint.astDigest, JSON.stringify(checkpoint.payload), checkpoint.createdAt],
	);
}
function decodeCheckpointRow(row: Record<string, unknown>): StoredProjectionCheckpoint {
	return {
		checkpointId: row.checkpoint_id as string,
		headSeqId: row.head_seq_id === null ? null : pgNumber(row.head_seq_id),
		projectorVersion: pgNumber(row.projector_version),
		astDigest: row.ast_digest as string,
		payload: row.projection,
		createdAt: pgNumber(row.created_at_ms),
	};
}
async function queryRows(client: PgClientLike, access: PostgresLogAccess, text: string, values: readonly unknown[]): Promise<Record<string, unknown>[]> {
	try { return (await client.query(text, values)).rows; }
	catch (error) { if (access === "read" && isUndefinedTable(error)) return []; throw error; }
}
function decodeRecordRow(row: JournalSqlRow): DurableLogRecord {
	return {
		...(row.payload as Record<string, unknown>),
		type: row.record_type!,
		seqId: pgNumber(row.seq),
		parentId: row.parent_id === null ? null : pgNumber(row.parent_id),
		branchId: row.branch_id,
	} as unknown as DurableLogRecord;
}
function decodeBranchRow(row: Record<string, unknown>): BranchHead {
	const metadata = row.metadata === null || row.metadata === undefined ? undefined : row.metadata as BranchMetadata;
	return {
		branchId: row.branch_id as string,
		headSeqId: row.current_head_seq_id === null ? null : pgNumber(row.current_head_seq_id),
		createdAt: pgNumber(row.committed_at_ms),
		...(metadata === undefined ? {} : { metadata }),
	};
}
function requireBranch(branch: BranchHead | undefined, branchId: BranchId): BranchHead {
	if (branch === undefined) throw new Error(`Unknown Hyperchart branch '${branchId}'`);
	return branch;
}
function decodeRunMeta(row: Record<string, unknown>): RunMeta {
	const exportName = row.export_name === null || row.export_name === undefined ? undefined : row.export_name as string;
	const originSessionId = row.origin_session_id === null || row.origin_session_id === undefined ? undefined : row.origin_session_id as string;
	return {
		chartPath: row.chart_path as string,
		...(exportName === undefined ? {} : { exportName }),
		workDir: row.work_dir as string,
		chartId: row.chart_id as string,
		createdAt: row.created_at as string,
		...(originSessionId === undefined ? {} : { originSessionId }),
	};
}
function pgNumber(value: unknown): number { return typeof value === "number" ? value : Number(value); }
function restrictTransaction(tx: PostgresRunTransaction): SqlCommitTransaction { return { query: (text, values) => tx.query(text, values) }; }
export function supportsSqlTransactions(store: RunLogStore): store is SqlTransactionalRunLogStore { return store instanceof PostgresLogStore; }
function normalizeUnique(error: unknown, runId: string): unknown {
	return pgErrorCode(error) === "23505" && pgErrorConstraint(error) === "hyperchart_journal_pkey"
		? new Error(`Stale Hyperchart journal writer for run '${runId}'; retry the serialized transaction`)
		: error;
}
function pgErrorCode(error: unknown): string | undefined { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined; }
function pgErrorConstraint(error: unknown): string | undefined { return typeof error === "object" && error !== null && "constraint" in error && typeof error.constraint === "string" ? error.constraint : undefined; }
function isUndefinedTable(error: unknown): boolean { return pgErrorCode(error) === "42P01"; }
function isDuplicateObject(error: unknown): boolean { const code = pgErrorCode(error); return code === "42P07" || code === "23505"; }
