import { dirname, resolve } from "node:path";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import type {
	BranchHead,
	BranchId,
	BranchMetadata,
	DurableLogRecord,
	DurableRecordDraft,
	RecordBatchMutation,
	StorageMutation,
} from "../../core/durable_events.js";
import { prepareUserInteractionResponse, prepareUserInteractionResponseSync, type RespondToUserInteractionInput, type UserInteractionResponseCommit } from "./user_interaction_admission.js";

export const DEFAULT_BRANCH_ID: BranchId = "main";

export class CorruptRunLogError extends Error {
	constructor(message: string) {
		super(`Corrupt Hyperchart log: ${message}`);
		this.name = "CorruptRunLogError";
	}
}

type AncestryNode = Readonly<{ record: DurableLogRecord; parent?: AncestryNode }>;

export class NormalizedRunLog {
	readonly mutations: readonly StorageMutation[];
	readonly records: readonly DurableLogRecord[];
	readonly recordsBySeqId: ReadonlyMap<number, DurableLogRecord>;
	readonly branches: ReadonlyMap<BranchId, BranchHead>;
	private currentNextSeqId: number;
	private readonly ancestryNodes: Map<number, AncestryNode>;
	private readonly ancestryCache: Map<number, readonly DurableLogRecord[]>;

	constructor(input: {
		mutations: readonly StorageMutation[];
		records: readonly DurableLogRecord[];
		recordsBySeqId: ReadonlyMap<number, DurableLogRecord>;
		branches: ReadonlyMap<BranchId, BranchHead>;
		nextSeqId: number;
		ancestryNodes?: Map<number, AncestryNode>;
		ancestryCache?: Map<number, readonly DurableLogRecord[]>;
	}) {
		this.mutations = input.mutations;
		this.records = input.records;
		this.recordsBySeqId = input.recordsBySeqId;
		this.branches = input.branches;
		this.currentNextSeqId = input.nextSeqId;
		this.ancestryNodes = input.ancestryNodes ?? buildAncestryNodes(input.records);
		this.ancestryCache = input.ancestryCache ?? new Map();
	}

	get nextSeqId(): number { return this.currentNextSeqId; }

	/** Publish one already-durable mutation into the shared in-memory projection. */
	applyMutation(mutation: StorageMutation): void {
		const mutations = this.mutations as StorageMutation[];
		const records = this.records as DurableLogRecord[];
		const recordsBySeqId = this.recordsBySeqId as Map<number, DurableLogRecord>;
		const branches = this.branches as Map<BranchId, BranchHead>;
		mutations.push(mutation);
		if (mutation.kind === "branch") {
			const previous = branches.get(mutation.branchId);
			branches.set(mutation.branchId, mutation.op === "create"
				? { branchId: mutation.branchId, headSeqId: mutation.headSeqId, createdAt: mutation.committedAt, ...(mutation.metadata === undefined ? {} : { metadata: mutation.metadata }) }
				: { ...previous!, headSeqId: mutation.headSeqId });
			return;
		}
		const branch = branches.get(mutation.branchId)!;
		for (const record of mutation.records) {
			records.push(record);
			recordsBySeqId.set(record.seqId, record);
			const parent = record.parentId === null ? undefined : this.ancestryNodes.get(record.parentId);
			this.ancestryNodes.set(record.seqId, { record, ...(parent === undefined ? {} : { parent }) });
		}
		this.currentNextSeqId = mutation.headSeqId + 1;
		branches.set(mutation.branchId, { ...branch, headSeqId: mutation.headSeqId });
	}

	branch(branchId: BranchId): BranchHead {
		const branch = this.branches.get(branchId);
		if (branch === undefined) throw new Error(`Unknown Hyperchart branch '${branchId}'`);
		return branch;
	}

	ancestry(branchId: BranchId): readonly DurableLogRecord[] {
		return this.ancestryTo(this.branch(branchId).headSeqId);
	}

	ancestryTo(headSeqId: number | null): readonly DurableLogRecord[] {
		if (headSeqId === null) return [];
		const cached = this.ancestryCache.get(headSeqId);
		if (cached !== undefined) return cached;
		const reversed: DurableLogRecord[] = [];
		const seen = new Set<number>();
		let node = this.ancestryNodes.get(headSeqId);
		if (node === undefined) throw new CorruptRunLogError(`missing record seqId ${headSeqId}`);
		while (node !== undefined) {
			if (seen.has(node.record.seqId)) throw new CorruptRunLogError(`parent cycle at seqId ${node.record.seqId}`);
			seen.add(node.record.seqId);
			reversed.push(node.record);
			node = node.parent;
		}
		const ancestry = reversed.reverse();
		this.ancestryCache.set(headSeqId, ancestry);
		return ancestry;
	}
}

export interface LogStore {
	readonly branchId: BranchId;
	/** Resolves only after the mutation is durable in the backend; the in-memory snapshot is published at the same boundary. */
	appendDrafts(drafts: readonly DurableRecordDraft[]): Promise<readonly DurableLogRecord[]>;
	/** Synchronous already-normalized snapshot for effect addressing in the serialized runtime. */
	snapshot(): NormalizedRunLog;
	read(): Promise<NormalizedRunLog>;
	readAll(): Promise<readonly DurableLogRecord[]>;
}

/** Full run-journal handle: branch mutations plus lifecycle, shared across branch handles. */
export interface RunLogStore extends LogStore {
	forBranch(branchId: BranchId): RunLogStore;
	initializeRootBranch(metadata?: BranchMetadata): Promise<BranchHead>;
	createBranch(branchId: BranchId, headSeqId: number, metadata?: BranchMetadata): Promise<BranchHead>;
	moveBranch(branchId: BranchId, headSeqId: number | null): Promise<BranchHead>;
	respondToUserInteraction(input: RespondToUserInteractionInput): Promise<UserInteractionResponseCommit>;
	close(): Promise<void>;
}

export type { RespondToUserInteractionInput, UserInteractionResponseCommit } from "./user_interaction_admission.js";

/** Stamp drafts with global seqIds/parent linkage for one branch of an already-normalized journal. */
export function stampDrafts(
	normalized: NormalizedRunLog,
	branchId: BranchId,
	drafts: readonly DurableRecordDraft[],
	now: number,
): { records: DurableLogRecord[]; mutation: RecordBatchMutation } {
	const branch = normalized.branches.get(branchId);
	if (branch === undefined) throw new Error(`Unknown Hyperchart branch '${branchId}'`);
	let nextSeqId = normalized.nextSeqId;
	let parentId = branch.headSeqId;
	const records = drafts.map((draft) => {
		assertDraft(draft);
		const record = { ...draft, seqId: nextSeqId++, parentId, branchId, timestamp: now } as DurableLogRecord;
		parentId = record.seqId;
		return record;
	});
	const tail = records.at(-1)!;
	return { records, mutation: { kind: "record_batch", branchId, records, headSeqId: tail.seqId, committedAt: now } };
}

export function validateAndProjectJournal(values: readonly unknown[]): NormalizedRunLog {
	const mutations: StorageMutation[] = [];
	const records: DurableLogRecord[] = [];
	const recordsBySeqId = new Map<number, DurableLogRecord>();
	const branches = new Map<BranchId, BranchHead>();
	let nextSeqId = 1;

	for (let index = 0; index < values.length; index++) {
		const value = values[index];
		const coordinate = `mutation ${index + 1}`;
		if (!isRecord(value)) throw new CorruptRunLogError(`${coordinate} is not an object`);
		if (value.kind !== "branch" && value.kind !== "record_batch") {
			throw new CorruptRunLogError(`${coordinate} is not a storage mutation`);
		}
		if (value.kind === "branch") {
			const branchId = requireBranchId(value.branchId, coordinate);
			const committedAt = requireTimestamp(value.committedAt, `${coordinate}.committedAt`);
			if (value.op === "create") {
				if (branches.has(branchId)) throw new CorruptRunLogError(`${coordinate} creates duplicate branch '${branchId}'`);
				const headSeqId = requireNullableSeqId(value.headSeqId, `${coordinate}.headSeqId`);
				if (headSeqId !== null && !recordsBySeqId.has(headSeqId)) {
					throw new CorruptRunLogError(`${coordinate} references missing head seqId ${headSeqId}`);
				}
				const metadata = normalizeBranchMetadata(value.metadata, coordinate);
				const mutation: StorageMutation = {
					kind: "branch", op: "create", branchId, headSeqId,
					...(metadata === undefined ? {} : { metadata }), committedAt,
				};
				mutations.push(mutation);
				branches.set(branchId, { branchId, headSeqId, createdAt: committedAt, ...(metadata === undefined ? {} : { metadata }) });
				continue;
			}
			if (value.op === "move") {
				const previous = branches.get(branchId);
				if (previous === undefined) throw new CorruptRunLogError(`${coordinate} moves unknown branch '${branchId}'`);
				const headSeqId = requireNullableSeqId(value.headSeqId, `${coordinate}.headSeqId`);
				if (headSeqId !== null && !recordsBySeqId.has(headSeqId)) throw new CorruptRunLogError(`${coordinate} references missing head seqId ${headSeqId}`);
				const mutation: StorageMutation = { kind: "branch", op: "move", branchId, headSeqId, committedAt };
				mutations.push(mutation);
				branches.set(branchId, { ...previous, headSeqId });
				continue;
			}
			throw new CorruptRunLogError(`${coordinate} has unknown branch operation`);
		}

		const branchId = requireBranchId(value.branchId, coordinate);
		const branch = branches.get(branchId);
		if (branch === undefined) throw new CorruptRunLogError(`${coordinate} appends to unknown branch '${branchId}'`);
		if (!Array.isArray(value.records) || value.records.length === 0) throw new CorruptRunLogError(`${coordinate} record batch must be non-empty`);
		const committedAt = requireTimestamp(value.committedAt, `${coordinate}.committedAt`);
		const batch: DurableLogRecord[] = [];
		let expectedParent = branch.headSeqId;
		for (let recordIndex = 0; recordIndex < value.records.length; recordIndex++) {
			const recordCoordinate = `${coordinate}.records[${recordIndex}]`;
			const record = normalizeDurableRecord(value.records[recordIndex], recordCoordinate);
			if (record.branchId !== branchId) throw new CorruptRunLogError(`${recordCoordinate} branchId '${record.branchId}' does not match batch '${branchId}'`);
			if (record.seqId !== nextSeqId) throw new CorruptRunLogError(`${recordCoordinate} seqId ${record.seqId} is not global next seqId ${nextSeqId}`);
			if (record.parentId !== expectedParent) throw new CorruptRunLogError(`${recordCoordinate} parentId ${String(record.parentId)} does not match branch head/batch predecessor ${String(expectedParent)}`);
			if (record.parentId !== null && !recordsBySeqId.has(record.parentId) && !batch.some((entry) => entry.seqId === record.parentId)) throw new CorruptRunLogError(`${recordCoordinate} references missing parent seqId ${record.parentId}`);
			if (recordsBySeqId.has(record.seqId)) throw new CorruptRunLogError(`${recordCoordinate} duplicates seqId ${record.seqId}`);
			batch.push(record);
			expectedParent = record.seqId;
			nextSeqId++;
		}
		const headSeqId = requireSeqId(value.headSeqId, `${coordinate}.headSeqId`);
		if (headSeqId !== batch.at(-1)?.seqId) throw new CorruptRunLogError(`${coordinate} headSeqId does not match the batch tail`);
		for (const record of batch) { records.push(record); recordsBySeqId.set(record.seqId, record); }
		const mutation: RecordBatchMutation = { kind: "record_batch", branchId, records: batch, headSeqId, committedAt };
		mutations.push(mutation);
		branches.set(branchId, { ...branch, headSeqId });
	}

	return new NormalizedRunLog({ mutations, records, recordsBySeqId, branches, nextSeqId });
}

type SharedJournalState = {
	filePath: string;
	onWarn: (message: string) => void;
	snapshot?: NormalizedRunLog;
	/** Exact durable byte boundary represented by snapshot. Shared branch handles advance it together. */
	expectedByteLength?: number;
	fullReadCount: number;
};

function newJournal(filePath: string, onWarn: (message: string) => void): SharedJournalState {
	return { filePath: resolve(filePath), onWarn, fullReadCount: 0 };
}

export class JsonlLogStore implements RunLogStore {
	private journal: SharedJournalState;

	constructor(
		readonly filePath: string,
		onWarn: (message: string) => void = () => {},
		readonly branchId: BranchId = DEFAULT_BRANCH_ID,
	) {
		requireBranchId(branchId, "selected branch");
		this.journal = newJournal(filePath, onWarn);
	}

	/** Create another branch handle over this store's already-open incremental journal. */
	forBranch(branchId: BranchId): JsonlLogStore {
		const store = new JsonlLogStore(this.journal.filePath, this.journal.onWarn, branchId);
		store.journal = this.journal;
		return store;
	}

	/** Number of full-file reads performed by this shared journal. */
	fullReadCount(): number { return this.journal.fullReadCount; }

	async initializeRootBranch(metadata: BranchMetadata = { name: this.branchId }): Promise<BranchHead> {
		return this.commitBuilt((normalized) => {
			if (normalized.mutations.length !== 0) throw new Error("Cannot initialize a non-empty Hyperchart journal");
			const committedAt = Date.now();
			const mutation: StorageMutation = { kind: "branch", op: "create", branchId: this.branchId, headSeqId: null, metadata, committedAt };
			return { mutation, result: { branchId: this.branchId, headSeqId: null, createdAt: committedAt, metadata } };
		});
	}

	async appendDrafts(drafts: readonly DurableRecordDraft[]): Promise<readonly DurableLogRecord[]> {
		if (drafts.length === 0) return [];
		return this.commitBuilt((normalized) => {
			const { records, mutation } = stampDrafts(normalized, this.branchId, drafts, Date.now());
			return { mutation, result: records };
		});
	}

	snapshot(): NormalizedRunLog {
		this.openJournal();
		if (this.journal.snapshot === undefined) throw new Error("Hyperchart journal failed to open");
		return this.journal.snapshot;
	}
	async read(): Promise<NormalizedRunLog> { return this.snapshot(); }
	readSync(): NormalizedRunLog { return this.snapshot(); }
	async close(): Promise<void> {}
	async readAll(): Promise<readonly DurableLogRecord[]> {
		const normalized = await this.read();
		return normalized.mutations.length === 0 ? [] : normalized.ancestry(this.branchId);
	}

	async createBranch(branchId: BranchId, headSeqId: number, metadata?: BranchMetadata): Promise<BranchHead> {
		requireBranchId(branchId, "branchId");
		return this.commitBuilt((normalized) => {
			if (normalized.branches.has(branchId)) throw new Error(`Hyperchart branch '${branchId}' already exists`);
			if (!normalized.recordsBySeqId.has(headSeqId)) throw new Error(`No durable log record with seqId ${headSeqId}`);
			const committedAt = Date.now();
			return {
				mutation: { kind: "branch", op: "create", branchId, headSeqId, ...(metadata === undefined ? {} : { metadata }), committedAt },
				result: { branchId, headSeqId, createdAt: committedAt, ...(metadata === undefined ? {} : { metadata }) },
			};
		});
	}

	async moveBranch(branchId: BranchId, headSeqId: number | null): Promise<BranchHead> {
		requireBranchId(branchId, "branchId");
		return this.commitBuilt((normalized) => {
			const branch = normalized.branches.get(branchId);
			if (branch === undefined) throw new Error(`Unknown Hyperchart branch '${branchId}'`);
			if (headSeqId !== null && !normalized.recordsBySeqId.has(headSeqId)) throw new Error(`No durable log record with seqId ${headSeqId}`);
			return {
				mutation: { kind: "branch", op: "move", branchId, headSeqId, committedAt: Date.now() },
				result: { ...branch, headSeqId },
			};
		});
	}

	async respondToUserInteraction(input: RespondToUserInteractionInput): Promise<UserInteractionResponseCommit> {
		// Runtime-schema validation may await, so serialize the final prefix check and append
		// with every other in-process writer operation. No second live process may own this store.
		await prepareUserInteractionResponse(this.snapshot(), this.branchId, input);
		return enqueueJsonlWrite(this.journal.filePath, async () => {
			const release = acquireWriterLock(this.journal.filePath);
			try {
				const normalized = this.snapshot();
				const prepared = prepareUserInteractionResponseSync(normalized, this.branchId, input);
				if (prepared.kind === "idempotent") return { record: prepared.record, idempotent: true };
				const { records, mutation } = stampDrafts(normalized, this.branchId, [prepared.draft], Date.now());
				this.appendLocked(mutation);
				return { record: records[0] as UserInteractionResponseCommit["record"], idempotent: false };
			} finally { release(); }
		});
	}

	private openJournal(): void {
		if (this.journal.snapshot !== undefined) return;
		const opened = readMutationValues(this.journal.filePath, this.journal.onWarn);
		this.journal.fullReadCount++;
		this.journal.expectedByteLength = opened.byteLength;
		this.journal.snapshot = validateAndProjectJournal(opened.values);
	}

	private commitBuilt<T>(builder: (normalized: NormalizedRunLog) => { mutation: StorageMutation; result: T }): T {
		this.openJournal();
		const release = acquireWriterLock(this.journal.filePath);
		try {
			const built = builder(this.snapshot());
			this.appendLocked(built.mutation);
			return built.result;
		} finally { release(); }
	}

	private appendLocked(mutation: StorageMutation): void {
		const snapshot = this.journal.snapshot;
		const expectedByteLength = this.journal.expectedByteLength;
		if (snapshot === undefined || expectedByteLength === undefined) throw new Error("Hyperchart journal is not open");
		const currentByteLength = journalByteLength(this.journal.filePath);
		if (currentByteLength !== expectedByteLength) {
			throw new Error(`Stale Hyperchart journal writer: expected ${expectedByteLength} bytes but found ${currentByteLength}; reopen the run before writing`);
		}
		const line = `${JSON.stringify(mutation)}\n`;
		appendMutationLine(this.journal.filePath, line);
		this.journal.expectedByteLength = expectedByteLength + Buffer.byteLength(line, "utf8");
		snapshot.applyMutation(mutation);
	}
}

type OpenedMutationValues = { values: unknown[]; byteLength: number };

function readMutationValues(filePath: string, onWarn: (message: string) => void): OpenedMutationValues {
	if (!existsSync(filePath)) return { values: [], byteLength: 0 };
	let content = readFileSync(filePath, "utf8");
	if (!content.endsWith("\n") && content.length > 0) {
		// The first read only detects a possible torn tail. The repair decision and
		// boundary are recomputed from a second read while holding the append lock,
		// so a writer that completed the line meanwhile can never be truncated.
		let repaired = false;
		const release = acquireWriterLock(filePath);
		try {
			content = readFileSync(filePath, "utf8");
			if (!content.endsWith("\n") && content.length > 0) {
				const end = content.lastIndexOf("\n") + 1;
				const complete = content.slice(0, end);
				truncateSync(filePath, Buffer.byteLength(complete, "utf8"));
				content = complete;
				repaired = true;
			}
		} finally { release(); }
		if (repaired) onWarn(`Discarded incomplete trailing JSONL mutation in ${filePath}`);
	}
	const values: unknown[] = [];
	for (const [index, line] of content.split(/\r?\n/).entries()) {
		if (line.length === 0) continue;
		try { values.push(JSON.parse(line) as unknown); }
		catch (error) { throw new Error(`Failed to parse durable log ${filePath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
	}
	return { values, byteLength: Buffer.byteLength(content, "utf8") };
}

function journalByteLength(filePath: string): number {
	try { return statSync(filePath).size; }
	catch (error) { if (isNodeError(error) && error.code === "ENOENT") return 0; throw error; }
}

function appendMutationLine(filePath: string, line: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	appendFileSync(filePath, line, "utf8");
}

function buildAncestryNodes(records: readonly DurableLogRecord[]): Map<number, AncestryNode> {
	const nodes = new Map<number, AncestryNode>();
	for (const record of records) {
		const parent = record.parentId === null ? undefined : nodes.get(record.parentId);
		nodes.set(record.seqId, { record, ...(parent === undefined ? {} : { parent }) });
	}
	return nodes;
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

function acquireWriterLock(filePath: string): () => void {
	const lockDir = `${filePath}.writer-lock`;
	mkdirSync(dirname(filePath), { recursive: true });
	const started = Date.now();
	for (;;) {
		try {
			mkdirSync(lockDir);
			writeFileSync(`${lockDir}/owner.json`, `${JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })}\n`, "utf8");
			return () => rmSync(lockDir, { recursive: true, force: true });
		} catch (error) {
			if (!isNodeError(error) || error.code !== "EEXIST") throw error;
			if (writerLockIsStale(lockDir)) { rmSync(lockDir, { recursive: true, force: true }); continue; }
			if (Date.now() - started > 10_000) throw new Error(`Timed out waiting for Hyperchart run writer claim ${lockDir}`);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
		}
	}
}

function writerLockIsStale(lockDir: string): boolean {
	try {
		const owner = JSON.parse(readFileSync(`${lockDir}/owner.json`, "utf8")) as { pid?: unknown };
		if (typeof owner.pid !== "number") return Date.now() - statSync(lockDir).mtimeMs > 30_000;
		try { process.kill(owner.pid, 0); return false; } catch { return true; }
	} catch {
		try { return Date.now() - statSync(lockDir).mtimeMs > 30_000; } catch { return false; }
	}
}

function normalizeDurableRecord(value: unknown, coordinate: string): DurableLogRecord {
	if (!isRecord(value) || typeof value.type !== "string") throw new CorruptRunLogError(`${coordinate} is not a machine record`);
	const seqId = requireSeqId(value.seqId, `${coordinate}.seqId`);
	const parentId = requireNullableSeqId(value.parentId, `${coordinate}.parentId`);
	const branchId = requireBranchId(value.branchId, `${coordinate}.branchId`);
	const timestamp = requireTimestamp(value.timestamp, `${coordinate}.timestamp`);
	const knownSimple = new Set(["session_ref", "args", "spawned", "failure_intent", "actor_created", "actor_messages_enqueued", "actor_call_resolved", "actor_batch_call_resolved"]);
	if (value.type === "state_action") {
		if (value.kind !== "invoke" && value.kind !== "complete" && value.kind !== "validated" && value.kind !== "timer_fired") {
			throw new CorruptRunLogError(`${coordinate}.kind is not a state-action record kind`);
		}
		requireActionUid(value.actionUid, `${coordinate}.actionUid`);
		if ((value.kind === "complete" || value.kind === "validated") && value.event !== undefined) requireChartEvent(value.event, `${coordinate}.event`);
	} else if (value.type === "user_interaction") {
		if (value.kind !== "opened" && value.kind !== "resolved") throw new CorruptRunLogError(`${coordinate}.kind is not a user-interaction record kind`);
		requireActionUid(value.actionUid, `${coordinate}.actionUid`);
		if (value.kind === "opened") {
			requireSeqId(value.phaseSeqId, `${coordinate}.phaseSeqId`);
			if (typeof value.prompt !== "string") throw new CorruptRunLogError(`${coordinate}.prompt must be a string`);
			if (!isStringArray(value.options)) throw new CorruptRunLogError(`${coordinate}.options must be an array of strings`);
			if (!isStringArray(value.events) || value.events.length === 0 || value.events.some((event) => event.length === 0 || event === "FAILED") || new Set(value.events).size !== value.events.length) {
				throw new CorruptRunLogError(`${coordinate}.events must contain unique non-empty non-FAILED event names`);
			}
			if (value.reply !== undefined) requireSchema(value.reply, `${coordinate}.reply`);
			if (value.rejection !== undefined) {
				if (!isRecord(value.rejection) || !Number.isSafeInteger(value.rejection.attempt) || (value.rejection.attempt as number) < 1 || (value.rejection.onReject !== "resume" && value.rejection.onReject !== "restart") || (value.rejection.reason !== undefined && typeof value.rejection.reason !== "string")) {
					throw new CorruptRunLogError(`${coordinate}.rejection is malformed`);
				}
			}
		} else {
			requireSeqId(value.gateSeqId, `${coordinate}.gateSeqId`);
			requireChartEvent(value.event, `${coordinate}.event`);
		}
	} else if (value.type === "actor_message") {
		if (value.kind !== "accepted" && value.kind !== "replied" && value.kind !== "settled") throw new CorruptRunLogError(`${coordinate}.kind is not an actor-message record kind`);
	} else if (value.type === "actor_scope") {
		if (value.kind !== "closing" && value.kind !== "stopped") throw new CorruptRunLogError(`${coordinate}.kind is not an actor-scope record kind`);
	} else if (!knownSimple.has(value.type)) {
		throw new CorruptRunLogError(`${coordinate}.type '${value.type}' is not a known machine record type`);
	}
	return { ...value, seqId, parentId, branchId, timestamp } as DurableLogRecord;
}

function requireActionUid(value: unknown, coordinate: string): void {
	if (!isRecord(value) || typeof value.chart !== "string" || value.chart.length === 0 || typeof value.state !== "string" || value.state.length === 0 || typeof value.action !== "string" || value.action.length === 0) {
		throw new CorruptRunLogError(`${coordinate} must contain non-empty chart/state/action strings`);
	}
}

function requireChartEvent(value: unknown, coordinate: string): void {
	if (!isRecord(value) || typeof value.type !== "string" || value.type.length === 0) throw new CorruptRunLogError(`${coordinate} must contain a non-empty event type`);
}

function requireSchema(value: unknown, coordinate: string): void {
	if (!isRecord(value) || value.kind !== "jsonSchema" || !isRecord(value.schema)) throw new CorruptRunLogError(`${coordinate} must be a normalized jsonSchema`);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function assertDraft(value: DurableRecordDraft): void {
	if (!isRecord(value) || typeof value.type !== "string") throw new Error("Durable record draft must contain a machine record type");
	if ("seqId" in value || "parentId" in value || "branchId" in value || "timestamp" in value) throw new Error("Durable record coordinates are assigned only by the run writer");
}

function requireBranchId(value: unknown, coordinate: string): BranchId {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > 128 || /[\0/\\]/.test(value)) throw new CorruptRunLogError(`${coordinate} must be a non-empty branch id without path separators`);
	return value;
}
function requireSeqId(value: unknown, coordinate: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new CorruptRunLogError(`${coordinate} must be a positive safe integer`);
	return value;
}
function requireNullableSeqId(value: unknown, coordinate: string): number | null { return value === null ? null : requireSeqId(value, coordinate); }
function requireTimestamp(value: unknown, coordinate: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new CorruptRunLogError(`${coordinate} must be a finite non-negative timestamp`);
	return value;
}
function normalizeBranchMetadata(value: unknown, coordinate: string): BranchMetadata | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new CorruptRunLogError(`${coordinate}.metadata must be an object`);
	const metadata: { name?: string; reason?: string; sourceBranchId?: BranchId; sourceSeqId?: number } = {};
	if (value.name !== undefined) { if (typeof value.name !== "string") throw new CorruptRunLogError(`${coordinate}.metadata.name must be a string`); metadata.name = value.name; }
	if (value.reason !== undefined) { if (typeof value.reason !== "string") throw new CorruptRunLogError(`${coordinate}.metadata.reason must be a string`); metadata.reason = value.reason; }
	if (value.sourceBranchId !== undefined) metadata.sourceBranchId = requireBranchId(value.sourceBranchId, `${coordinate}.metadata.sourceBranchId`);
	if (value.sourceSeqId !== undefined) metadata.sourceSeqId = requireSeqId(value.sourceSeqId, `${coordinate}.metadata.sourceSeqId`);
	return metadata;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
