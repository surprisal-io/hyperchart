import { isDeepStrictEqual } from "node:util";
import type { BranchHead, BranchId, BranchMetadata, DurableLogRecord, DurableRecordDraft, StorageMutation } from "../../core/durable_events.js";
import { DEFAULT_BRANCH_ID, type NormalizedRunLog, type RunLogStore, stampDrafts, validateAndProjectJournal, type RespondToUserInteractionInput, type UserInteractionResponseCommit } from "./log_store.js";
import { prepareUserInteractionResponse } from "./user_interaction_admission.js";

export const JOURNAL_TABLE = "hyperchart_journal";
export const JOURNAL_CHANNEL = "hyperchart_journal";
const JOURNAL_DDL = `CREATE TABLE IF NOT EXISTS ${JOURNAL_TABLE} (
  run_id text NOT NULL,
  seq bigint NOT NULL,
  mutation jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
)`;

export type PostgresLogAccess = "writer" | "read";
export type OpenPostgresLogStoreOptions = Readonly<{ dsn: string; runId: string; branchId?: BranchId; onWarn?: (message: string) => void; access?: PostgresLogAccess }>;
export type PgQueryResult = { rows: Record<string, unknown>[] };
export type PgClientLike = {
	connect(): Promise<void>;
	query(text: string, values?: readonly unknown[]): Promise<PgQueryResult>;
	end(): Promise<void>;
	on(event: "error", listener: (error: Error) => void): unknown;
};

type SharedPgJournal = {
	client: PgClientLike;
	runId: string;
	access: PostgresLogAccess;
	snapshot: NormalizedRunLog;
	nextSeq: number;
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
				const locked = await client.query("SELECT pg_try_advisory_lock(hashtextextended('hyperchart:run:' || $1, 0)) AS locked", [options.runId]);
				if (locked.rows[0]?.locked !== true) throw new Error(`Another live writer holds Hyperchart run '${options.runId}' in Postgres; stop it before writing`);
			}
			const values = await readJournalMutations(client, options.runId, access);
			return new PostgresLogStore({ client, runId: options.runId, access, snapshot: validateAndProjectJournal(values), nextSeq: values.length + 1, writeChain: Promise.resolve(), closed: false }, branchId);
		} catch (error) { await client.end().catch(() => {}); throw error; }
	}

	forBranch(branchId: BranchId): PostgresLogStore { return new PostgresLogStore(this.journal, branchId); }
	snapshot(): NormalizedRunLog { if (this.journal.closed) throw new Error("Postgres Hyperchart journal is closed"); return this.journal.snapshot; }
	async read(): Promise<NormalizedRunLog> { await this.journal.writeChain; await this.refresh(); return this.snapshot(); }
	async readAll(): Promise<readonly DurableLogRecord[]> { const log = await this.read(); return log.mutations.length === 0 ? [] : log.ancestry(this.branchId); }

	async initializeRootBranch(metadata: BranchMetadata = { name: this.branchId }): Promise<BranchHead> {
		return this.transaction(async (tx) => {
			if ((tx as TransactionImpl).snapshot.mutations.length !== 0) throw new Error("Cannot initialize a non-empty Hyperchart journal");
			// A root branch has no record head, so use the transaction's direct move helper shape.
			const committedAt = Date.now();
			await (tx as TransactionImpl).commitMutation({ kind: "branch", op: "create", branchId: this.branchId, headSeqId: null, metadata, committedAt });
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
				const values = await readJournalMutations(client, runId, "writer");
				const tx = new TransactionImpl(client, runId, validateAndProjectJournal(values), values.length + 1);
				const result = await task(tx);
				await client.query("COMMIT");
				this.journal.snapshot = tx.snapshot;
				this.journal.nextSeq = tx.nextSeq;
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
		const values = await readJournalMutations(this.journal.client, this.journal.runId, this.journal.access);
		if (values.length !== this.journal.snapshot.mutations.length) { this.journal.snapshot = validateAndProjectJournal(values); this.journal.nextSeq = values.length + 1; }
	}
}

class TransactionImpl implements PostgresRunTransaction {
	constructor(readonly client: PgClientLike, readonly runId: string, public snapshot: NormalizedRunLog, public nextSeq: number) {}
	query(text: string, values?: readonly unknown[]): Promise<PgQueryResult> { return this.client.query(text, values); }
	async appendDrafts(branchId: BranchId, drafts: readonly DurableRecordDraft[]): Promise<readonly DurableLogRecord[]> {
		if (drafts.length === 0) return [];
		const { records, mutation } = stampDrafts(this.snapshot, branchId, drafts, Date.now()); await this.commitMutation(mutation); return records;
	}
	async createBranch(branchId: BranchId, headSeqId: number, metadata?: BranchMetadata): Promise<BranchHead> {
		if (this.snapshot.branches.has(branchId)) throw new Error(`Hyperchart branch '${branchId}' already exists`);
		if (!this.snapshot.recordsBySeqId.has(headSeqId)) throw new Error(`No durable log record with seqId ${headSeqId}`);
		const committedAt = Date.now(); await this.commitMutation({ kind: "branch", op: "create", branchId, headSeqId, ...(metadata === undefined ? {} : { metadata }), committedAt });
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
		await this.commitMutation({ kind: "branch", op: "move", branchId, headSeqId, committedAt: Date.now() }); return { ...branch, headSeqId };
	}
	async respondToUserInteraction(branchId: BranchId, input: RespondToUserInteractionInput): Promise<UserInteractionResponseCommit> {
		const prepared = await prepareUserInteractionResponse(this.snapshot, branchId, input);
		if (prepared.kind === "idempotent") return { record: prepared.record, idempotent: true };
		const records = await this.appendDrafts(branchId, [prepared.draft]); return { record: records[0] as UserInteractionResponseCommit["record"], idempotent: false };
	}
	async commitMutation(mutation: StorageMutation): Promise<void> {
		await this.client.query(`INSERT INTO ${JOURNAL_TABLE} (run_id, seq, mutation) VALUES ($1, $2, $3::jsonb)`, [this.runId, this.nextSeq, JSON.stringify(mutation)]);
		await this.client.query("SELECT pg_notify($1, $2)", [JOURNAL_CHANNEL, `${this.runId}:${this.nextSeq}`]);
		this.nextSeq++; this.snapshot.applyMutation(mutation);
	}
}

async function connectPg(dsn: string, onWarn: (message: string) => void): Promise<PgClientLike> {
	let pg: { Client: new (config: { connectionString: string }) => PgClientLike };
	try { pg = (await import("pg")) as unknown as typeof pg; }
	catch { throw new Error("Postgres Hyperchart log storage requires the optional 'pg' package; install it to use HYPERCHART_PG_DSN"); }
	const client = new pg.Client({ connectionString: dsn }); client.on("error", (error) => onWarn(`Hyperchart Postgres journal connection error: ${error.message}`)); await client.connect(); return client;
}
async function ensureJournalTable(client: PgClientLike): Promise<void> { try { await client.query(JOURNAL_DDL); } catch (error) { if (!isDuplicateObject(error)) throw error; await client.query(JOURNAL_DDL); } }
async function readJournalMutations(client: PgClientLike, runId: string, access: PostgresLogAccess): Promise<unknown[]> {
	try { const result = await client.query(`SELECT mutation FROM ${JOURNAL_TABLE} WHERE run_id = $1 ORDER BY seq`, [runId]); return result.rows.map((row) => row.mutation); }
	catch (error) { if (access === "read" && isUndefinedTable(error)) return []; throw error; }
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
