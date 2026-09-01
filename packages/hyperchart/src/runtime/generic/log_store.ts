import { dirname, join, resolve } from "node:path";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {
	mkdir,
	open,
	stat,
} from "node:fs/promises";
import {
	isDurableRecordEntry,
	type BranchHead,
	type BranchId,
	type BranchMetadata,
	type DurableLogRecord,
	type DurableRecordDraft,
	type StorageEntry,
} from "../../core/durable_events.js";
import { prepareUserInteractionResponse, prepareUserInteractionResponseSync, type RespondToUserInteractionInput, type UserInteractionResponseCommit } from "./user_interaction_admission.js";

export const DEFAULT_BRANCH_ID: BranchId = "main";

export type RunMeta = {
	chartPath: string;
	exportName?: string;
	workDir: string;
	chartId: string;
	createdAt: string;
	originSessionId?: string;
};

/** Backend-neutral read model. Implementations may materialize it or answer with targeted queries. */
export interface RunLogReader {
	listBranches(): Promise<readonly BranchHead[]>;
	getBranch(branchId: BranchId): Promise<BranchHead>;
	getRecord(seqId: number): Promise<DurableLogRecord | undefined>;
	readAncestry(branchId: BranchId): Promise<readonly DurableLogRecord[]>;
	containsInAncestry(branchId: BranchId, seqId: number): Promise<boolean>;
	countRecords(): Promise<number>;
}

/** @internal Materialized index used only by file and memory backends. */
export class MaterializedRunLogIndex {
	readonly entries: StorageEntry[];
	readonly recordsBySeqId: Map<number, DurableLogRecord>;
	readonly branches: Map<BranchId, BranchHead>;
	nextSeqId: number;

	constructor(input: {
		entries: StorageEntry[];
		recordsBySeqId: Map<number, DurableLogRecord>;
		branches: Map<BranchId, BranchHead>;
		nextSeqId: number;
	}) {
		this.entries = input.entries;
		this.recordsBySeqId = input.recordsBySeqId;
		this.branches = input.branches;
		this.nextSeqId = input.nextSeqId;
	}

	applyEntry(entry: StorageEntry): void {
		this.entries.push(entry);
		if (!isDurableRecordEntry(entry)) {
			const previous = this.branches.get(entry.branchId);
			this.branches.set(entry.branchId, entry.op === "create"
				? { branchId: entry.branchId, headSeqId: entry.headSeqId, createdAt: entry.committedAt, ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }) }
				: { ...previous!, headSeqId: entry.headSeqId });
			this.nextSeqId = entry.seqId + 1;
			return;
		}
		const branch = this.branches.get(entry.branchId)!;
		this.recordsBySeqId.set(entry.seqId, entry);
		this.nextSeqId = entry.seqId + 1;
		this.branches.set(entry.branchId, { ...branch, headSeqId: entry.seqId });
	}

	branch(branchId: BranchId): BranchHead {
		const branch = this.branches.get(branchId);
		if (branch === undefined) throw new Error(`Unknown Hyperchart branch '${branchId}'`);
		return branch;
	}

	ancestry(branchId: BranchId): readonly DurableLogRecord[] {
		return this.ancestryTo(this.branch(branchId).headSeqId);
	}

	containsInAncestry(branchId: BranchId, targetSeqId: number): boolean {
		let seqId = this.branch(branchId).headSeqId;
		while (seqId !== null) {
			if (seqId === targetSeqId) return true;
			seqId = this.recordsBySeqId.get(seqId)!.parentId;
		}
		return false;
	}

	ancestryTo(headSeqId: number | null): readonly DurableLogRecord[] {
		if (headSeqId === null) return [];
		const reversed: DurableLogRecord[] = [];
		let seqId: number | null = headSeqId;
		while (seqId !== null) {
			const record: DurableLogRecord = this.recordsBySeqId.get(seqId)!;
			reversed.push(record);
			seqId = record.parentId;
		}
		return reversed.reverse();
	}

}

export interface LogStore extends RunLogReader {
	readonly branchId: BranchId;
	appendDrafts(drafts: readonly DurableRecordDraft[]): Promise<readonly DurableLogRecord[]>;
}

/** Full run-journal handle: branch entries plus lifecycle, shared across branch handles. */
export interface RunLogStore extends LogStore {
	forBranch(branchId: BranchId): RunLogStore;
	readRunMeta(): Promise<RunMeta | undefined>;
	writeRunMeta(meta: RunMeta): Promise<void>;
	deleteRunData(): Promise<void>;
	initializeRootBranch(metadata?: BranchMetadata): Promise<BranchHead>;
	createBranch(branchId: BranchId, headSeqId: number, metadata?: BranchMetadata): Promise<BranchHead>;
	moveBranch(branchId: BranchId, headSeqId: number | null): Promise<BranchHead>;
	respondToUserInteraction(input: RespondToUserInteractionInput): Promise<UserInteractionResponseCommit>;
	close(): Promise<void>;
}

export type { RespondToUserInteractionInput, UserInteractionResponseCommit } from "./user_interaction_admission.js";

/** @internal Stamp drafts against the file/memory writer's materialized index. */
export function stampDrafts(
	index: MaterializedRunLogIndex,
	branchId: BranchId,
	drafts: readonly DurableRecordDraft[],
	now: number,
): DurableLogRecord[] {
	const branch = index.branches.get(branchId);
	if (branch === undefined) throw new Error(`Unknown Hyperchart branch '${branchId}'`);
	let nextSeqId = index.nextSeqId;
	let parentId = branch.headSeqId;
	return drafts.map((draft) => {
		assertDurableRecordDraft(draft);
		const record = { ...draft, seqId: nextSeqId++, parentId, branchId, timestamp: now } as DurableLogRecord;
		parentId = record.seqId;
		return record;
	});
}

/** @internal */
export function materializeJournal(values: readonly unknown[]): MaterializedRunLogIndex {
	const entries = [...values] as StorageEntry[];
	const index = new MaterializedRunLogIndex({ entries: [], recordsBySeqId: new Map(), branches: new Map(), nextSeqId: 1 });
	for (const entry of entries) index.applyEntry(entry);
	return index;
}

type SharedJournalState = {
	filePath: string;
	index?: MaterializedRunLogIndex;
	/** Exact durable byte boundary represented by the index. Shared branch handles advance it together. */
	expectedByteLength?: number;
	fullReadCount: number;
};

function newJournal(filePath: string): SharedJournalState {
	return { filePath: resolve(filePath), fullReadCount: 0 };
}

export class JsonlLogStore implements RunLogStore {
	private journal: SharedJournalState;

	constructor(
		readonly filePath: string,
		readonly branchId: BranchId = DEFAULT_BRANCH_ID,
	) {
		requireBranchId(branchId, "selected branch");
		this.journal = newJournal(filePath);
	}

	/** Create another branch handle over this store's already-open incremental journal. */
	forBranch(branchId: BranchId): JsonlLogStore {
		const store = new JsonlLogStore(this.journal.filePath, branchId);
		store.journal = this.journal;
		return store;
	}

	/** Number of full-file reads performed by this shared journal. */
	fullReadCount(): number { return this.journal.fullReadCount; }

	async initializeRootBranch(metadata: BranchMetadata = { name: this.branchId }): Promise<BranchHead> {
		return this.commitBuilt((index) => {
			if (index.entries.length !== 0) throw new Error("Cannot initialize a non-empty Hyperchart journal");
			const committedAt = Date.now();
			const entry: StorageEntry = { kind: "branch", op: "create", seqId: index.nextSeqId, branchId: this.branchId, headSeqId: null, metadata, committedAt };
			return { entries: [entry], result: { branchId: this.branchId, headSeqId: null, createdAt: committedAt, metadata } };
		});
	}

	async appendDrafts(drafts: readonly DurableRecordDraft[]): Promise<readonly DurableLogRecord[]> {
		if (drafts.length === 0) return [];
		return this.commitBuilt((index) => {
			const records = stampDrafts(index, this.branchId, drafts, Date.now());
			return { entries: records, result: records };
		});
	}

	async listBranches(): Promise<readonly BranchHead[]> { return [...this.index().branches.values()]; }
	async getBranch(branchId: BranchId): Promise<BranchHead> { return this.index().branch(branchId); }
	async getRecord(seqId: number): Promise<DurableLogRecord | undefined> { return this.index().recordsBySeqId.get(seqId); }
	async readAncestry(branchId: BranchId): Promise<readonly DurableLogRecord[]> {
		const index = this.index();
		return index.entries.length === 0 ? [] : index.ancestry(branchId);
	}
	async containsInAncestry(branchId: BranchId, seqId: number): Promise<boolean> {
		const index = this.index();
		return index.entries.length === 0 ? false : index.containsInAncestry(branchId, seqId);
	}
	async countRecords(): Promise<number> { return this.index().recordsBySeqId.size; }
	async close(): Promise<void> {}
	async readRunMeta(): Promise<RunMeta | undefined> {
		const path = join(dirname(this.journal.filePath), "meta.json");
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8")) as RunMeta;
	}
	async writeRunMeta(meta: RunMeta): Promise<void> {
		mkdirSync(dirname(this.journal.filePath), { recursive: true });
		writeFileSync(join(dirname(this.journal.filePath), "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
	}
	async deleteRunData(): Promise<void> {
		rmSync(join(dirname(this.journal.filePath), "meta.json"), { force: true });
		rmSync(this.journal.filePath, { force: true });
	}
	async createBranch(branchId: BranchId, headSeqId: number, metadata?: BranchMetadata): Promise<BranchHead> {
		requireBranchId(branchId, "branchId");
		return this.commitBuilt((index) => {
			if (index.branches.has(branchId)) throw new Error(`Hyperchart branch '${branchId}' already exists`);
			if (!index.recordsBySeqId.has(headSeqId)) throw new Error(`No durable log record with seqId ${headSeqId}`);
			const committedAt = Date.now();
			return {
				entries: [{ kind: "branch", op: "create", seqId: index.nextSeqId, branchId, headSeqId, ...(metadata === undefined ? {} : { metadata }), committedAt }],
				result: { branchId, headSeqId, createdAt: committedAt, ...(metadata === undefined ? {} : { metadata }) },
			};
		});
	}

	async moveBranch(branchId: BranchId, headSeqId: number | null): Promise<BranchHead> {
		requireBranchId(branchId, "branchId");
		return this.commitBuilt((index) => {
			const branch = index.branches.get(branchId);
			if (branch === undefined) throw new Error(`Unknown Hyperchart branch '${branchId}'`);
			if (headSeqId !== null && !index.recordsBySeqId.has(headSeqId)) throw new Error(`No durable log record with seqId ${headSeqId}`);
			return {
				entries: [{ kind: "branch", op: "move", seqId: index.nextSeqId, branchId, headSeqId, committedAt: Date.now() }],
				result: { ...branch, headSeqId },
			};
		});
	}

	async respondToUserInteraction(input: RespondToUserInteractionInput): Promise<UserInteractionResponseCommit> {
		// Runtime-schema validation may await, so serialize the final prefix check and append
		// with every other in-process writer operation. No second live process may own this store.
		await prepareUserInteractionResponse(this.index().ancestry(this.branchId), this.branchId, input);
		return enqueueJsonlWrite(this.journal.filePath, async () => {
			const index = this.index();
			const prepared = prepareUserInteractionResponseSync(index.ancestry(this.branchId), this.branchId, input);
			if (prepared.kind === "idempotent") return { record: prepared.record, idempotent: true };
			const records = stampDrafts(index, this.branchId, [prepared.draft], Date.now());
			await this.appendLocked(records);
			return { record: records[0] as UserInteractionResponseCommit["record"], idempotent: false };
		});
	}

	private openJournal(): void {
		if (this.journal.index !== undefined) return;
		const opened = readEntryValues(this.journal.filePath);
		this.journal.fullReadCount++;
		this.journal.expectedByteLength = opened.byteLength;
		this.journal.index = materializeJournal(opened.values);
	}

	private index(): MaterializedRunLogIndex {
		this.openJournal();
		if (this.journal.index === undefined) throw new Error("Hyperchart journal failed to open");
		return this.journal.index;
	}

	private commitBuilt<T>(builder: (index: MaterializedRunLogIndex) => { entries: readonly StorageEntry[]; result: T }): Promise<T> {
		return enqueueJsonlWrite(this.journal.filePath, async () => {
			this.openJournal();
			const built = builder(this.index());
			await this.appendLocked(built.entries);
			return built.result;
		});
	}

	private async appendLocked(entries: readonly StorageEntry[]): Promise<void> {
		const index = this.journal.index;
		const expectedByteLength = this.journal.expectedByteLength;
		if (index === undefined || expectedByteLength === undefined) throw new Error("Hyperchart journal is not open");
		const currentByteLength = await journalByteLengthAsync(this.journal.filePath);
		if (currentByteLength !== expectedByteLength) {
			throw new Error(`Stale Hyperchart journal writer: expected ${expectedByteLength} bytes but found ${currentByteLength}; reopen the run before writing`);
		}
		const payload = Buffer.from(entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
		await appendEntriesOnce(this.journal.filePath, payload);
		this.journal.expectedByteLength = expectedByteLength + payload.byteLength;
		for (const entry of entries) index.applyEntry(entry);
	}
}

type OpenedEntryValues = { values: unknown[]; byteLength: number };

function readEntryValues(filePath: string): OpenedEntryValues {
	if (!existsSync(filePath)) return { values: [], byteLength: 0 };
	const content = readFileSync(filePath, "utf8");
	const values: unknown[] = [];
	for (const [index, line] of content.split(/\r?\n/).entries()) {
		if (line.length === 0) continue;
		try { values.push(JSON.parse(line) as unknown); }
		catch (error) { throw new Error(`Failed to parse durable log ${filePath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
	}
	return { values, byteLength: Buffer.byteLength(content, "utf8") };
}

async function journalByteLengthAsync(filePath: string): Promise<number> {
	try { return (await stat(filePath)).size; }
	catch (error) { if (isNodeError(error) && error.code === "ENOENT") return 0; throw error; }
}

async function appendEntriesOnce(filePath: string, payload: Buffer): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const handle = await open(filePath, "a");
	try {
		const { bytesWritten } = await handle.write(payload, 0, payload.byteLength, null);
		if (bytesWritten !== payload.byteLength) throw new Error(`Short Hyperchart journal append: wrote ${bytesWritten} of ${payload.byteLength} bytes`);
	} finally { await handle.close(); }
}

const jsonlWriteChains = new Map<string, Promise<void>>();

function enqueueJsonlWrite<T>(filePath: string, task: () => Promise<T>): Promise<T> {
	const key = resolve(filePath);
	const previous = jsonlWriteChains.get(key) ?? Promise.resolve();
	const result = previous.then(task);
	const settled = result.then(() => undefined, () => undefined);
	jsonlWriteChains.set(key, settled);
	void settled.finally(() => { if (jsonlWriteChains.get(key) === settled) jsonlWriteChains.delete(key); });
	return result;
}

/** @internal */
export function assertDurableRecordDraft(value: DurableRecordDraft): void {
	if (!isRecord(value) || typeof value.type !== "string") throw new Error("Durable record draft must contain a machine record type");
	if ("seqId" in value || "parentId" in value || "branchId" in value || "timestamp" in value) throw new Error("Durable record coordinates are assigned only by the run writer");
}

function requireBranchId(value: unknown, coordinate: string): BranchId {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > 128 || /[\0/\\]/.test(value)) throw new Error(`${coordinate} must be a non-empty branch id without path separators`);
	return value;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
