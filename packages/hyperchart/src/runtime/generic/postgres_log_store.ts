import type {
	BranchHead,
	BranchId,
	BranchMetadata,
	DurableLogRecord,
	DurableRecordDraft,
	StorageMutation,
} from "../../core/durable_events.js";
import {
	DEFAULT_BRANCH_ID,
	type NormalizedRunLog,
	type RunLogStore,
	stampDrafts,
	validateAndProjectJournal,
} from "./log_store.js";

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

export type OpenPostgresLogStoreOptions = Readonly<{
	dsn: string;
	runId: string;
	branchId?: BranchId;
	onWarn?: (message: string) => void;
	access?: PostgresLogAccess;
}>;

/** Minimal structural surface of a `pg` client so the published types do not depend on `pg`. */
type PgClientLike = {
	connect(): Promise<void>;
	query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
	end(): Promise<void>;
	on(event: "error", listener: (error: Error) => void): unknown;
};

type SharedPgJournal = {
	client: PgClientLike;
	runId: string;
	access: PostgresLogAccess;
	snapshot: NormalizedRunLog;
	/** Next journal mutation position; the (run_id, seq) primary key is the stale-writer check. */
	nextSeq: number;
	/** Serializes writers sharing this journal: records are stamped only after prior commits publish. */
	writeChain: Promise<void>;
	closed: boolean;
};

export class PostgresLogStore implements RunLogStore {
	private constructor(
		private readonly journal: SharedPgJournal,
		readonly branchId: BranchId,
	) {}

	static async open(options: OpenPostgresLogStoreOptions): Promise<PostgresLogStore> {
		const access = options.access ?? "read";
		const branchId = options.branchId ?? DEFAULT_BRANCH_ID;
		const client = await connectPg(options.dsn, options.onWarn ?? (() => {}));
		try {
			if (access === "writer") {
				await ensureJournalTable(client);
				const locked = await client.query(
					"SELECT pg_try_advisory_lock(hashtextextended('hyperchart:run:' || $1, 0)) AS locked",
					[options.runId],
				);
				if (locked.rows[0]?.locked !== true) {
					throw new Error(`Another live writer holds Hyperchart run '${options.runId}' in Postgres; stop it before writing`);
				}
			}
			const values = await readJournalMutations(client, options.runId, access);
			const snapshot = validateAndProjectJournal(values);
			const journal: SharedPgJournal = {
				client,
				runId: options.runId,
				access,
				snapshot,
				nextSeq: values.length + 1,
				writeChain: Promise.resolve(),
				closed: false,
			};
			return new PostgresLogStore(journal, branchId);
		} catch (error) {
			await client.end().catch(() => {});
			throw error;
		}
	}

	/** Create another branch handle over this store's already-open shared journal. */
	forBranch(branchId: BranchId): PostgresLogStore {
		return new PostgresLogStore(this.journal, branchId);
	}

	snapshot(): NormalizedRunLog {
		if (this.journal.closed) throw new Error("Postgres Hyperchart journal is closed");
		return this.journal.snapshot;
	}

	async read(): Promise<NormalizedRunLog> {
		await this.journal.writeChain;
		return this.snapshot();
	}

	async readAll(): Promise<readonly DurableLogRecord[]> {
		const normalized = await this.read();
		return normalized.mutations.length === 0 ? [] : normalized.ancestry(this.branchId);
	}

	async initializeRootBranch(metadata: BranchMetadata = { name: this.branchId }): Promise<BranchHead> {
		return this.enqueueWrite(async () => {
			if (this.snapshot().mutations.length !== 0) throw new Error("Cannot initialize a non-empty Hyperchart journal");
			const committedAt = Date.now();
			await this.commitMutation({ kind: "branch", op: "create", branchId: this.branchId, headSeqId: null, metadata, committedAt });
			return { branchId: this.branchId, headSeqId: null, createdAt: committedAt, metadata };
		});
	}

	appendDrafts(drafts: readonly DurableRecordDraft[]): Promise<readonly DurableLogRecord[]> {
		if (drafts.length === 0) return Promise.resolve([]);
		return this.enqueueWrite(async () => {
			const { records, mutation } = stampDrafts(this.snapshot(), this.branchId, drafts, Date.now());
			await this.commitMutation(mutation);
			return records;
		});
	}

	async createBranch(branchId: BranchId, headSeqId: number, metadata?: BranchMetadata): Promise<BranchHead> {
		return this.enqueueWrite(async () => {
			const normalized = this.snapshot();
			if (normalized.branches.has(branchId)) throw new Error(`Hyperchart branch '${branchId}' already exists`);
			if (!normalized.recordsBySeqId.has(headSeqId)) throw new Error(`No durable log record with seqId ${headSeqId}`);
			const committedAt = Date.now();
			await this.commitMutation({ kind: "branch", op: "create", branchId, headSeqId, ...(metadata === undefined ? {} : { metadata }), committedAt });
			return { branchId, headSeqId, createdAt: committedAt, ...(metadata === undefined ? {} : { metadata }) };
		});
	}

	async moveBranch(branchId: BranchId, headSeqId: number | null): Promise<BranchHead> {
		return this.enqueueWrite(async () => {
			const normalized = this.snapshot();
			const branch = normalized.branches.get(branchId);
			if (branch === undefined) throw new Error(`Unknown Hyperchart branch '${branchId}'`);
			if (headSeqId !== null && !normalized.recordsBySeqId.has(headSeqId)) throw new Error(`No durable log record with seqId ${headSeqId}`);
			await this.commitMutation({ kind: "branch", op: "move", branchId, headSeqId, committedAt: Date.now() });
			return { ...branch, headSeqId };
		});
	}

	async close(): Promise<void> {
		if (this.journal.closed) return;
		this.journal.closed = true;
		await this.journal.writeChain.catch(() => {});
		await this.journal.client.end();
	}

	private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
		if (this.journal.access !== "writer") {
			return Promise.reject(new Error(`Hyperchart run '${this.journal.runId}' was opened read-only`));
		}
		if (this.journal.closed) return Promise.reject(new Error("Postgres Hyperchart journal is closed"));
		const result = this.journal.writeChain.then(task);
		this.journal.writeChain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async commitMutation(mutation: StorageMutation): Promise<void> {
		const { client, runId, nextSeq } = this.journal;
		try {
			await client.query("BEGIN");
			await client.query(
				`INSERT INTO ${JOURNAL_TABLE} (run_id, seq, mutation) VALUES ($1, $2, $3::jsonb)`,
				[runId, nextSeq, JSON.stringify(mutation)],
			);
			await client.query("SELECT pg_notify($1, $2)", [JOURNAL_CHANNEL, `${runId}:${nextSeq}`]);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK").catch(() => {});
			if (isUniqueViolation(error)) {
				throw new Error(`Stale Hyperchart journal writer: run '${runId}' already has mutation ${nextSeq}; reopen the run before writing`);
			}
			throw error;
		}
		// Commit is the publication boundary: readers never observe an undurable mutation.
		this.journal.nextSeq = nextSeq + 1;
		this.journal.snapshot.applyMutation(mutation);
	}
}

async function connectPg(dsn: string, onWarn: (message: string) => void): Promise<PgClientLike> {
	let pg: { Client: new (config: { connectionString: string }) => PgClientLike };
	try {
		pg = (await import("pg")) as unknown as typeof pg;
	} catch {
		throw new Error("Postgres Hyperchart log storage requires the optional 'pg' package; install it to use HYPERCHART_PG_DSN");
	}
	const client = new pg.Client({ connectionString: dsn });
	client.on("error", (error) => onWarn(`Hyperchart Postgres journal connection error: ${error.message}`));
	await client.connect();
	return client;
}

async function ensureJournalTable(client: PgClientLike): Promise<void> {
	try {
		await client.query(JOURNAL_DDL);
	} catch (error) {
		// Concurrent CREATE TABLE IF NOT EXISTS can race on the catalog; one retry settles it.
		if (!isDuplicateObject(error)) throw error;
		await client.query(JOURNAL_DDL);
	}
}

async function readJournalMutations(client: PgClientLike, runId: string, access: PostgresLogAccess): Promise<unknown[]> {
	try {
		const result = await client.query(`SELECT mutation FROM ${JOURNAL_TABLE} WHERE run_id = $1 ORDER BY seq`, [runId]);
		return result.rows.map((row) => row.mutation);
	} catch (error) {
		// A read-only open before any writer created the table is an empty journal, like a missing log.jsonl.
		if (access === "read" && isUndefinedTable(error)) return [];
		throw error;
	}
}

function pgErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
function isUniqueViolation(error: unknown): boolean {
	return pgErrorCode(error) === "23505";
}
function isUndefinedTable(error: unknown): boolean {
	return pgErrorCode(error) === "42P01";
}
function isDuplicateObject(error: unknown): boolean {
	const code = pgErrorCode(error);
	return code === "42P07" || code === "23505";
}
