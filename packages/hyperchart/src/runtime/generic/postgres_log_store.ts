import { isDeepStrictEqual } from "node:util";
import { isDurableRecordEntry, type BranchHead, type BranchId, type BranchMetadata, type DurableLogRecord, type DurableRecordDraft, type StorageEntry } from "../../core/durable_events.js";
import { CorruptRunLogError, DEFAULT_BRANCH_ID, type NormalizedRunLog, type RunLogStore, type RunMeta, stampDrafts, validateAndProjectJournal, type RespondToUserInteractionInput, type UserInteractionResponseCommit } from "./log_store.js";
import { prepareUserInteractionResponse } from "./user_interaction_admission.js";

export const JOURNAL_TABLE = "hyperchart_journal";
export const JOURNAL_CHANNEL = "hyperchart_journal";
export const RUN_META_TABLE = "hyperchart_run_meta";
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
  chart_path text NOT NULL,
  export_name text,
  work_dir text NOT NULL,
  chart_id text NOT NULL,
  created_at text NOT NULL,
  origin_session_id text
)`;
const JOURNAL_PARENT_INDEX_DDL = `CREATE INDEX IF NOT EXISTS hyperchart_journal_parent_idx
  ON ${JOURNAL_TABLE}(run_id, parent_id) WHERE kind = 'record'`;
const JOURNAL_BRANCH_INDEX_DDL = `CREATE INDEX IF NOT EXISTS hyperchart_journal_branch_idx
  ON ${JOURNAL_TABLE}(run_id, branch_id, seq) WHERE kind = 'record'`;

export type PostgresLogAccess = "writer" | "read";
export type OpenPostgresLogStoreOptions = Readonly<{ dsn: string; runId: string; branchId?: BranchId; onWarn?: (message: string) => void; access?: PostgresLogAccess; loadJournal?: boolean }>;
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
	snapshot: NormalizedRunLog | undefined;
	writeChain: Promise<void>;
	closed: boolean;
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
	private constructor(private readonly journal: SharedPgJournal, readonly branchId: BranchId) {}

	static async open(options: OpenPostgresLogStoreOptions): Promise<PostgresLogStore> {
		const access = options.access ?? "read";
		const branchId = options.branchId ?? DEFAULT_BRANCH_ID;
		const onWarn = options.onWarn ?? (() => {});
		const client = await connectPg(options.dsn, onWarn);
		try {
			if (access === "writer") {
				await ensureJournalTable(client);
				await ensureRunMetaTable(client);
				const locked = await client.query("SELECT pg_try_advisory_lock(hashtextextended('hyperchart:run:' || $1, 0)) AS locked", [options.runId]);
				if (locked.rows[0]?.locked !== true) throw new Error(`Another live writer holds Hyperchart run '${options.runId}' in Postgres; stop it before writing`);
			}
			const snapshot = options.loadJournal === false
				? undefined
				: validateAndProjectJournal(await readJournalEntries(client, options.runId, access));
			return new PostgresLogStore({ client, runId: options.runId, access, snapshot, writeChain: Promise.resolve(), closed: false }, branchId);
		} catch (error) { await client.end().catch(() => {}); throw error; }
	}

	forBranch(branchId: BranchId): PostgresLogStore { return new PostgresLogStore(this.journal, branchId); }
	async readRunMeta(): Promise<RunMeta | undefined> {
		await this.journal.writeChain;
		try {
			const result = await this.journal.client.query(
				`SELECT chart_path, export_name, work_dir, chart_id, created_at, origin_session_id FROM ${RUN_META_TABLE} WHERE run_id = $1`,
				[this.journal.runId],
			);
			const row = result.rows[0];
			return row === undefined ? undefined : decodeRunMeta(row);
		} catch (error) {
			if (isUndefinedTable(error)) return undefined;
			throw error;
		}
	}
	writeRunMeta(meta: RunMeta): Promise<void> {
		return this.enqueueWrite(async () => {
			const { client, runId } = this.journal;
			try {
				await client.query("BEGIN");
				await client.query(
					`INSERT INTO ${RUN_META_TABLE} (run_id, chart_path, export_name, work_dir, chart_id, created_at, origin_session_id)
					 VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (run_id) DO NOTHING`,
					[runId, meta.chartPath, meta.exportName ?? null, meta.workDir, meta.chartId, meta.createdAt, meta.originSessionId ?? null],
				);
				const stored = await this.readRunMetaDirect();
				if (stored === undefined || !isDeepStrictEqual(stored, meta)) throw new Error(`Conflicting metadata for Hyperchart run '${runId}'`);
				await client.query("COMMIT");
			} catch (error) {
				await client.query("ROLLBACK").catch(() => {});
				throw error;
			}
		});
	}
	deleteRunData(): Promise<void> {
		return this.enqueueWrite(async () => {
			const { client, runId } = this.journal;
			try {
				await client.query("BEGIN");
				await client.query(`DELETE FROM ${RUN_META_TABLE} WHERE run_id = $1`, [runId]);
				await client.query(`DELETE FROM ${JOURNAL_TABLE} WHERE run_id = $1`, [runId]);
				await client.query("COMMIT");
				this.journal.snapshot = validateAndProjectJournal([]);
			} catch (error) {
				await client.query("ROLLBACK").catch(() => {});
				throw error;
			}
		});
	}
	private async readRunMetaDirect(): Promise<RunMeta | undefined> {
		const result = await this.journal.client.query(
			`SELECT chart_path, export_name, work_dir, chart_id, created_at, origin_session_id FROM ${RUN_META_TABLE} WHERE run_id = $1`,
			[this.journal.runId],
		);
		const row = result.rows[0];
		return row === undefined ? undefined : decodeRunMeta(row);
	}
	snapshot(): NormalizedRunLog {
		if (this.journal.closed) throw new Error("Postgres Hyperchart journal is closed");
		if (this.journal.snapshot === undefined) throw new Error("Postgres Hyperchart journal has not been loaded; call read() first");
		return this.journal.snapshot;
	}
	async read(): Promise<NormalizedRunLog> { await this.journal.writeChain; await this.refresh(); return this.snapshot(); }
	async readAll(): Promise<readonly DurableLogRecord[]> { const log = await this.read(); return log.entries.length === 0 ? [] : log.ancestry(this.branchId); }

	async initializeRootBranch(metadata: BranchMetadata = { name: this.branchId }): Promise<BranchHead> {
		return this.transaction(async (tx) => {
			if ((tx as TransactionImpl).snapshot.entries.length !== 0) throw new Error("Cannot initialize a non-empty Hyperchart journal");
			// A root branch has no record head, so use the transaction's direct move helper shape.
			const committedAt = Date.now();
			await (tx as TransactionImpl).commitEntries([{ kind: "branch", op: "create", seqId: (tx as TransactionImpl).snapshot.nextSeqId, branchId: this.branchId, headSeqId: null, metadata, committedAt }]);
			return { branchId: this.branchId, headSeqId: null, createdAt: committedAt, metadata };
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
			try {
				await client.query("BEGIN");
				const values = await readJournalEntries(client, runId, "writer");
				const tx = new TransactionImpl(client, runId, validateAndProjectJournal(values));
				const result = await task(tx);
				await client.query("COMMIT");
				this.journal.snapshot = tx.snapshot;
				return result;
			} catch (error) { await client.query("ROLLBACK").catch(() => {}); throw normalizeUnique(error, runId); }
		});
	}

	commitUserInteraction<T>(branchId: BranchId, response: RespondToUserInteractionInput, participate: SqlCommitParticipant<T>): Promise<{ response: UserInteractionResponseCommit; participant: T }> {
		return this.transaction(async (tx) => ({
			response: await tx.respondToUserInteraction(branchId, response),
			participant: await participate(restrictTransaction(tx)),
		}));
	}

	/** Atomically creates or verifies a fork, commits its response, and joins trusted SQL. */
	forkAndCommitUserInteraction<T>(input: PostgresForkAndCommitInput, participate: SqlCommitParticipant<T>): Promise<{ branch: BranchHead; response: UserInteractionResponseCommit; participant: T }> {
		if (input.responseBranchId !== input.sourceBranchId && input.responseBranchId !== input.newBranchId) {
			return Promise.reject(new Error("responseBranchId must be the source branch or the newly created branch"));
		}
		return this.transaction(async (tx) => {
			const impl = tx as TransactionImpl;
			const sourceContainsForkPoint = impl.snapshot.ancestry(input.sourceBranchId)
				.some((record) => record.seqId === input.fromSeqId);
			if (!sourceContainsForkPoint) throw new Error(`Fork point ${input.fromSeqId} is not in source branch '${input.sourceBranchId}' ancestry`);
			const branch = await impl.ensureExactBranch(input.newBranchId, input.fromSeqId, input.metadata);
			const response = await tx.respondToUserInteraction(input.responseBranchId, input.response);
			const participant = await participate(restrictTransaction(tx));
			return { branch, response, participant };
		});
	}

	async close(): Promise<void> { if (this.journal.closed) return; this.journal.closed = true; await this.journal.writeChain.catch(() => {}); await this.journal.client.end(); }
	private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
		if (this.journal.access !== "writer") return Promise.reject(new Error(`Hyperchart run '${this.journal.runId}' was opened read-only`));
		if (this.journal.closed) return Promise.reject(new Error("Postgres Hyperchart journal is closed"));
		const result = this.journal.writeChain.then(task); this.journal.writeChain = result.then(() => undefined, () => undefined); return result;
	}
	private async refresh(): Promise<void> {
		const values = await readJournalEntries(this.journal.client, this.journal.runId, this.journal.access);
		if (this.journal.snapshot === undefined || values.length !== this.journal.snapshot.entries.length) {
			this.journal.snapshot = validateAndProjectJournal(values);
		}
	}
}

class TransactionImpl implements PostgresRunTransaction {
	constructor(readonly client: PgClientLike, readonly runId: string, public snapshot: NormalizedRunLog) {}
	query(text: string, values?: readonly unknown[]): Promise<PgQueryResult> { return this.client.query(text, values); }
	async appendDrafts(branchId: BranchId, drafts: readonly DurableRecordDraft[]): Promise<readonly DurableLogRecord[]> {
		if (drafts.length === 0) return [];
		const records = stampDrafts(this.snapshot, branchId, drafts, Date.now()); await this.commitEntries(records); return records;
	}
	async createBranch(branchId: BranchId, headSeqId: number, metadata?: BranchMetadata): Promise<BranchHead> {
		if (this.snapshot.branches.has(branchId)) throw new Error(`Hyperchart branch '${branchId}' already exists`);
		if (!this.snapshot.recordsBySeqId.has(headSeqId)) throw new Error(`No durable log record with seqId ${headSeqId}`);
		const committedAt = Date.now(); await this.commitEntries([{ kind: "branch", op: "create", seqId: this.snapshot.nextSeqId, branchId, headSeqId, ...(metadata === undefined ? {} : { metadata }), committedAt }]);
		return { branchId, headSeqId, createdAt: committedAt, ...(metadata === undefined ? {} : { metadata }) };
	}
	async ensureExactBranch(branchId: BranchId, headSeqId: number, metadata?: BranchMetadata): Promise<BranchHead> {
		const existing = this.snapshot.branches.get(branchId);
		if (existing === undefined) return this.createBranch(branchId, headSeqId, metadata);
		const ancestryContainsSource = existing.headSeqId === headSeqId || this.snapshot.ancestry(branchId).some((record) => record.seqId === headSeqId);
		if (!ancestryContainsSource || !isDeepStrictEqual(existing.metadata, metadata)) {
			throw new Error(`Conflicting retry for Hyperchart branch '${branchId}'`);
		}
		return existing;
	}
	async moveBranch(branchId: BranchId, headSeqId: number | null): Promise<BranchHead> {
		const branch = this.snapshot.branches.get(branchId); if (branch === undefined) throw new Error(`Unknown Hyperchart branch '${branchId}'`);
		if (headSeqId !== null && !this.snapshot.recordsBySeqId.has(headSeqId)) throw new Error(`No durable log record with seqId ${headSeqId}`);
		await this.commitEntries([{ kind: "branch", op: "move", seqId: this.snapshot.nextSeqId, branchId, headSeqId, committedAt: Date.now() }]); return { ...branch, headSeqId };
	}
	async respondToUserInteraction(branchId: BranchId, input: RespondToUserInteractionInput): Promise<UserInteractionResponseCommit> {
		const prepared = await prepareUserInteractionResponse(this.snapshot, branchId, input);
		if (prepared.kind === "idempotent") return { record: prepared.record, idempotent: true };
		const records = await this.appendDrafts(branchId, [prepared.draft]); return { record: records[0] as UserInteractionResponseCommit["record"], idempotent: false };
	}
	async commitEntries(entries: readonly StorageEntry[]): Promise<void> {
		if (entries.length === 0) return;
		const values: unknown[] = [this.runId];
		const rows = entries.map((entry, index) => {
			const parameter = 2 + index * 9;
			if (isDurableRecordEntry(entry)) {
				const { seqId, parentId, branchId, type, ...payload } = entry;
				values.push(seqId, "record", branchId, parentId, null, type, JSON.stringify(payload), null, payload.timestamp);
			} else {
				values.push(
					entry.seqId,
					entry.op === "create" ? "branch_create" : "branch_move",
					entry.branchId,
					null,
					entry.headSeqId,
					null,
					null,
					entry.op === "create" && entry.metadata !== undefined ? JSON.stringify(entry.metadata) : null,
					entry.committedAt,
				);
			}
			return `($1, $${parameter}, $${parameter + 1}, $${parameter + 2}, $${parameter + 3}, $${parameter + 4}, $${parameter + 5}, $${parameter + 6}::jsonb, $${parameter + 7}::jsonb, $${parameter + 8})`;
		});
		await this.client.query(
			`INSERT INTO ${JOURNAL_TABLE}
			   (run_id, seq, kind, branch_id, parent_id, head_seq_id,
			    record_type, payload, metadata, committed_at_ms)
			 VALUES ${rows.join(", ")}`,
			values,
		);
		const latestSeq = entries.at(-1)!.seqId;
		await this.client.query("SELECT pg_notify($1, $2)", [JOURNAL_CHANNEL, `${this.runId}:${latestSeq}`]);
		for (const entry of entries) this.snapshot.applyEntry(entry);
	}

}

async function connectPg(dsn: string, onWarn: (message: string) => void): Promise<PgClientLike> {
	let pg: { Client: new (config: { connectionString: string }) => PgClientLike };
	try { pg = (await import("pg")) as unknown as typeof pg; }
	catch { throw new Error("Postgres Hyperchart log storage requires the optional 'pg' package; install it to use HYPERCHART_PG_DSN"); }
	const client = new pg.Client({ connectionString: dsn }); client.on("error", (error) => onWarn(`Hyperchart Postgres journal connection error: ${error.message}`)); await client.connect(); return client;
}
async function ensureRunMetaTable(client: PgClientLike): Promise<void> {
	try { await client.query(RUN_META_DDL); }
	catch (error) { if (!isDuplicateObject(error)) throw error; await client.query(RUN_META_DDL); }
}
async function ensureJournalTable(client: PgClientLike): Promise<void> {
	try { await client.query(JOURNAL_DDL); }
	catch (error) { if (!isDuplicateObject(error)) throw error; await client.query(JOURNAL_DDL); }
	await client.query(JOURNAL_PARENT_INDEX_DDL);
	await client.query(JOURNAL_BRANCH_INDEX_DDL);
}
async function readJournalEntries(client: PgClientLike, runId: string, access: PostgresLogAccess): Promise<unknown[]> {
	try {
		const result = await client.query(
			`SELECT seq, kind, branch_id, parent_id, head_seq_id,
			        record_type, payload, metadata, committed_at_ms
			   FROM ${JOURNAL_TABLE}
			  WHERE run_id = $1 ORDER BY seq`,
			[runId],
		);
		return decodeJournalRows(result.rows as JournalSqlRow[]);
	} catch (error) { if (access === "read" && isUndefinedTable(error)) return []; throw error; }
}
function decodeJournalRows(rows: readonly JournalSqlRow[]): StorageEntry[] {
	return rows.map((row, index) => {
		const seqId = safeInteger(row.seq, "journal seq");
		if (seqId !== index + 1) throw new CorruptRunLogError(`Hyperchart journal sequence gap: expected ${index + 1}, got ${seqId}`);
		const committedAt = safeInteger(row.committed_at_ms, "committed_at_ms");
		if (row.kind === "record") {
			const record = {
				...requiredObject(row.payload, `record ${seqId} payload`),
				type: requiredString(row.record_type, "record_type"),
				seqId,
				parentId: row.parent_id === null ? null : safeInteger(row.parent_id, "parent_id"),
				branchId: row.branch_id,
			} as unknown as DurableLogRecord;
			return record;
		}
		const headSeqId = row.head_seq_id === null ? null : safeInteger(row.head_seq_id, "head_seq_id");
		if (row.kind === "branch_create") {
			const metadata = optionalObject(row.metadata);
			return { kind: "branch", op: "create", seqId, branchId: row.branch_id, headSeqId, ...(metadata === undefined ? {} : { metadata }), committedAt };
		}
		if (row.kind === "branch_move") return { kind: "branch", op: "move", seqId, branchId: row.branch_id, headSeqId, committedAt };
		throw new CorruptRunLogError(`Hyperchart journal entry ${seqId} has invalid kind`);
	});
}
function requiredObject(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CorruptRunLogError(`${label} must be an object`);
	return value as Record<string, unknown>;
}
function decodeRunMeta(row: Record<string, unknown>): RunMeta {
	const exportName = optionalMetaString(row.export_name, "export_name");
	const originSessionId = optionalMetaString(row.origin_session_id, "origin_session_id");
	return {
		chartPath: requiredMetaString(row.chart_path, "chart_path"),
		...(exportName === undefined ? {} : { exportName }),
		workDir: requiredMetaString(row.work_dir, "work_dir"),
		chartId: requiredMetaString(row.chart_id, "chart_id"),
		createdAt: requiredMetaString(row.created_at, "created_at"),
		...(originSessionId === undefined ? {} : { originSessionId }),
	};
}
function requiredMetaString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`Corrupt Hyperchart run metadata: ${label} must be a non-empty string`);
	return value;
}
function optionalMetaString(value: unknown, label: string): string | undefined {
	return value === null || value === undefined ? undefined : requiredMetaString(value, label);
}
function optionalObject(value: unknown): BranchMetadata | undefined {
	return value === null ? undefined : requiredObject(value, "branch metadata") as BranchMetadata;
}
function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new CorruptRunLogError(`${label} must be a non-empty string`);
	return value;
}
function safeInteger(value: unknown, label: string): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	if (!Number.isSafeInteger(parsed)) throw new CorruptRunLogError(`${label} must be a safe integer`);
	return parsed;
}
function restrictTransaction(tx: PostgresRunTransaction): SqlCommitTransaction {
	return { query: (text, values) => tx.query(text, values) };
}

export function supportsSqlTransactions(store: RunLogStore): store is SqlTransactionalRunLogStore {
	return store instanceof PostgresLogStore;
}

function normalizeUnique(error: unknown, runId: string): unknown {
	return pgErrorCode(error) === "23505" && pgErrorConstraint(error) === "hyperchart_journal_pkey"
		? new Error(`Stale Hyperchart journal writer for run '${runId}'; retry the serialized transaction`)
		: error;
}
function pgErrorCode(error: unknown): string | undefined { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined; }
function pgErrorConstraint(error: unknown): string | undefined { return typeof error === "object" && error !== null && "constraint" in error && typeof error.constraint === "string" ? error.constraint : undefined; }
function isUndefinedTable(error: unknown): boolean { return pgErrorCode(error) === "42P01"; }
function isDuplicateObject(error: unknown): boolean { const code = pgErrorCode(error); return code === "42P07" || code === "23505"; }
