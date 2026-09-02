import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
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
import { actionUidKey } from "../../core/action_uid.js";
import { actorLogicalOccurrencePath } from "../../core/actors.js";
import type { StatePath } from "../../core/types.js";
import { prepareUserInteractionResponse, prepareUserInteractionResponseSync, type RespondToUserInteractionInput, type UserInteractionResponseCommit } from "./user_interaction_admission.js";

export const DEFAULT_BRANCH_ID: BranchId = "main";
export const HISTORY_READ_ITEMS = 100;
export const PROJECTION_READ_RECORDS = 500;

/** Opaque derived projection cache row. Storage must not interpret payload. */
export type StoredProjectionCheckpoint = Readonly<{
	checkpointId: string;
	headSeqId: number | null;
	projectorVersion: number;
	astDigest: string;
	payload: unknown;
	createdAt: number;
}>;
export type ProjectionCheckpointLookup = Readonly<{
	targetHeadSeqId: number | null;
	projectorVersion: number;
	astDigest: string;
}>;
/** @internal AST-free checkpoint repository consumed only by projection_loader. */
export interface ProjectionCheckpointStore extends RunHistoryStore {
	readonly canSaveProjectionCheckpoints: boolean;
	loadExactProjectionCheckpoint(input: ProjectionCheckpointLookup): Promise<StoredProjectionCheckpoint | undefined>;
	findNearestProjectionCheckpoint(input: ProjectionCheckpointLookup): Promise<StoredProjectionCheckpoint | undefined>;
	discardProjectionCheckpoint(checkpointId: string): Promise<void>;
	saveProjectionCheckpoint(checkpoint: StoredProjectionCheckpoint): Promise<void>;
}

export type HistorySnapshot = Readonly<{ branchId: BranchId; headSeqId: number | null }>;
/** Opaque versioned cursor bound to an exact snapshot, typed subject, boundary, and direction. */
export type HistoryCursor = string;
export type BranchListCursor = string;
export type HistoryChunk<T> = Readonly<{
	snapshot: HistorySnapshot;
	/** Canonical order is always newest-first; length is backend-capped at 100. */
	items: readonly T[];
	older?: HistoryCursor;
	newer?: HistoryCursor;
}>;
export type BranchListChunk = Readonly<{
	items: readonly BranchHead[];
	totalCount: number;
	next?: BranchListCursor;
}>;

export type HistorySubject =
	| Readonly<{ kind: "records" }>
	| Readonly<{ kind: "state-visits"; state: StatePath }>
	| Readonly<{ kind: "map-visits"; mapPath: StatePath }>
	| Readonly<{ kind: "actor-generations"; logicalOccurrence: StatePath }>
	| Readonly<{ kind: "actor-messages"; occurrence: StatePath }>;

export type StateVisitHistoryItem = Readonly<{
	kind: "state-visit";
	state: StatePath;
	seqId: number;
	invoke: Extract<DurableLogRecord, { type: "state_action"; kind: "invoke" }>;
	records: readonly DurableLogRecord[];
}>;
export type MapVisitHistoryItem = Readonly<{
	kind: "map-visit";
	mapPath: StatePath;
	seqId: number;
	spawn: Extract<DurableLogRecord, { type: "spawned" }>;
	records: readonly DurableLogRecord[];
}>;
export type ActorGenerationHistoryItem = Readonly<{
	kind: "actor-generation";
	logicalOccurrence: StatePath;
	seqId: number;
	created: Extract<DurableLogRecord, { type: "actor_created" }>;
	records: readonly DurableLogRecord[];
}>;
export type ActorMessageHistoryItem = Readonly<{
	kind: "actor-message-batch";
	occurrence: StatePath;
	seqId: number;
	enqueued: Extract<DurableLogRecord, { type: "actor_messages_enqueued" }>;
	records: readonly DurableLogRecord[];
}>;

export class HistoryCursorError extends Error {
	readonly name = "HistoryCursorError";
}

export type RunMeta = {
	chartPath: string;
	exportName?: string;
	workDir: string;
	chartId: string;
	createdAt: string;
	originSessionId?: string;
};

/** Final public stateless history contract. Backends may temporarily scan trusted ancestry internally. */
export interface RunHistoryStore {
	captureSnapshot(branchId: BranchId): Promise<HistorySnapshot>;
	/** Read-committed keyset pagination; branch-list pages are deliberately not snapshot-stable. */
	listBranches(cursor?: BranchListCursor): Promise<BranchListChunk>;
	getBranch(branchId: BranchId): Promise<BranchHead>;
	getRecord(seqId: number): Promise<DurableLogRecord | undefined>;
	containsInHistory(input: { headSeqId: number | null; seqId: number }): Promise<boolean>;
	countRecords(): Promise<number>;
	readRecords(input: { snapshot: HistorySnapshot; cursor?: HistoryCursor }): Promise<HistoryChunk<DurableLogRecord>>;
	readStateVisits(input: { snapshot: HistorySnapshot; state: StatePath; cursor?: HistoryCursor }): Promise<HistoryChunk<StateVisitHistoryItem>>;
	readMapVisits(input: { snapshot: HistorySnapshot; mapPath: StatePath; cursor?: HistoryCursor }): Promise<HistoryChunk<MapVisitHistoryItem>>;
	readActorGenerations(input: { snapshot: HistorySnapshot; logicalOccurrence: StatePath; cursor?: HistoryCursor }): Promise<HistoryChunk<ActorGenerationHistoryItem>>;
	readActorMessages(input: { snapshot: HistorySnapshot; occurrence: StatePath; cursor?: HistoryCursor }): Promise<HistoryChunk<ActorMessageHistoryItem>>;
	cursorAt(input: { snapshot: HistorySnapshot; subject: HistorySubject; seqId: number }): Promise<HistoryCursor | undefined>;
	findUserInteractionResponse(input: { headSeqId: number | null; gateSeqId: number }): Promise<Extract<DurableLogRecord, { type: "user_interaction"; kind: "resolved" }> | undefined>;
}

/** @internal Runtime compatibility/replay seams removed or hidden in Phase 6. */
export interface RunLogReader extends RunHistoryStore {
	/** @internal Temporary compatibility seam removed in Phase 6. */
	readAncestry(branchId: BranchId): Promise<readonly DurableLogRecord[]>;
	/** @internal Temporary compatibility seam removed in Phase 6. */
	containsInAncestry(branchId: BranchId, seqId: number): Promise<boolean>;
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

type HistoryCursorPayload = Readonly<{
	version: 1;
	snapshot: HistorySnapshot;
	subject: string;
	direction: "at" | "older" | "newer";
	boundarySeqId: number;
}>;
type BranchCursorPayload = Readonly<{ version: 1; createdSeqId: number; branchId: BranchId }>;

type AnyHistoryItem = DurableLogRecord | StateVisitHistoryItem | MapVisitHistoryItem | ActorGenerationHistoryItem | ActorMessageHistoryItem;

/** @internal Canonical subject identity shared by cursor validation across backends. */
export function historySubjectKey(subject: HistorySubject): string {
	switch (subject.kind) {
		case "records": return JSON.stringify([subject.kind]);
		case "state-visits": return JSON.stringify([subject.kind, subject.state]);
		case "map-visits": return JSON.stringify([subject.kind, subject.mapPath]);
		case "actor-generations": return JSON.stringify([subject.kind, subject.logicalOccurrence]);
		case "actor-messages": return JSON.stringify([subject.kind, subject.occurrence]);
	}
}

function encodeOpaque(value: object): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function decodeOpaque(value: string, kind: "history" | "branch"): unknown {
	try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown; }
	catch { throw new HistoryCursorError(`Invalid Hyperchart ${kind} cursor`); }
}
function sameSnapshot(left: HistorySnapshot, right: HistorySnapshot): boolean {
	return left.branchId === right.branchId && left.headSeqId === right.headSeqId;
}
function itemSeqId(item: AnyHistoryItem): number { return item.seqId; }

/** @internal */
export function encodeBranchListCursor(createdSeqId: number, branchId: BranchId): BranchListCursor {
	return encodeOpaque({ version: 1, createdSeqId, branchId } satisfies BranchCursorPayload);
}
/** @internal */
export function decodeBranchListCursor(cursor: BranchListCursor): BranchCursorPayload {
	const value = decodeOpaque(cursor, "branch");
	if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.createdSeqId) || (value.createdSeqId as number) <= 0 || typeof value.branchId !== "string") {
		throw new HistoryCursorError("Invalid Hyperchart branch cursor");
	}
	return value as unknown as BranchCursorPayload;
}

function encodeHistoryCursor(payload: Omit<HistoryCursorPayload, "version">): HistoryCursor {
	return encodeOpaque({ version: 1, ...payload } satisfies HistoryCursorPayload);
}
function decodeHistoryCursor(cursor: HistoryCursor, snapshot: HistorySnapshot, subject: string): HistoryCursorPayload {
	const value = decodeOpaque(cursor, "history");
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.snapshot) || typeof value.snapshot.branchId !== "string"
		|| !(value.snapshot.headSeqId === null || Number.isSafeInteger(value.snapshot.headSeqId))
		|| typeof value.subject !== "string" || !["at", "older", "newer"].includes(String(value.direction))
		|| !Number.isSafeInteger(value.boundarySeqId)) {
		throw new HistoryCursorError("Invalid Hyperchart history cursor");
	}
	const decoded = value as unknown as HistoryCursorPayload;
	if (!sameSnapshot(decoded.snapshot, snapshot)) throw new HistoryCursorError("Hyperchart history cursor belongs to a different snapshot");
	if (decoded.subject !== subject) throw new HistoryCursorError("Hyperchart history cursor belongs to a different subject");
	return decoded;
}

/** @internal Build the final bounded stateless response from a newest-first subject chain. */
export function historyChunkFromItems<T extends AnyHistoryItem>(
	snapshot: HistorySnapshot,
	subject: HistorySubject,
	itemsNewestFirst: readonly T[],
	cursor?: HistoryCursor,
): HistoryChunk<T> {
	const subjectKey = historySubjectKey(subject);
	let start = 0;
	if (cursor !== undefined) {
		const decoded = decodeHistoryCursor(cursor, snapshot, subjectKey);
		const boundary = itemsNewestFirst.findIndex((item) => itemSeqId(item) === decoded.boundarySeqId);
		if (boundary < 0) throw new HistoryCursorError("Hyperchart history cursor boundary is not visible in its snapshot subject");
		start = decoded.direction === "older"
			? boundary + 1
			: decoded.direction === "newer"
				? Math.max(0, boundary - HISTORY_READ_ITEMS)
				: boundary;
		const end = decoded.direction === "newer" ? boundary : start + HISTORY_READ_ITEMS;
		const page = itemsNewestFirst.slice(start, end);
		return chunkWithEdges(snapshot, subjectKey, itemsNewestFirst, page, start, end);
	}
	const page = itemsNewestFirst.slice(0, HISTORY_READ_ITEMS);
	return chunkWithEdges(snapshot, subjectKey, itemsNewestFirst, page, 0, HISTORY_READ_ITEMS);
}

function chunkWithEdges<T extends AnyHistoryItem>(
	snapshot: HistorySnapshot,
	subject: string,
	all: readonly T[],
	page: readonly T[],
	start: number,
	requestedEnd: number,
): HistoryChunk<T> {
	if (page.length === 0) return { snapshot, items: [] };
	const end = Math.min(requestedEnd, all.length);
	const first = page[0]!;
	const last = page.at(-1)!;
	return {
		snapshot,
		items: page,
		...(end < all.length ? { older: encodeHistoryCursor({ snapshot, subject, direction: "older", boundarySeqId: itemSeqId(last) }) } : {}),
		...(start > 0 ? { newer: encodeHistoryCursor({ snapshot, subject, direction: "newer", boundarySeqId: itemSeqId(first) }) } : {}),
	};
}

/** @internal Mint an exact-subject deep-link cursor. */
export function cursorAtItems<T extends AnyHistoryItem>(
	snapshot: HistorySnapshot,
	subject: HistorySubject,
	itemsNewestFirst: readonly T[],
	seqId: number,
): HistoryCursor | undefined {
	const item = itemsNewestFirst.find((candidate) => itemSeqId(candidate) === seqId);
	return item === undefined ? undefined : encodeHistoryCursor({ snapshot, subject: historySubjectKey(subject), direction: "at", boundarySeqId: itemSeqId(item) });
}

/** @internal Derive durable record-level subject groups without importing AST/projector/host layers. */
export function historyItemsForSubject(ancestry: readonly DurableLogRecord[], subject: HistorySubject): readonly AnyHistoryItem[] {
	switch (subject.kind) {
		case "records": return [...ancestry].reverse();
		case "state-visits": return stateVisitItems(ancestry, subject.state);
		case "map-visits": return ancestry
			.filter((record): record is Extract<DurableLogRecord, { type: "spawned" }> => record.type === "spawned" && record.path === subject.mapPath)
			.map((spawn): MapVisitHistoryItem => ({ kind: "map-visit", mapPath: subject.mapPath, seqId: spawn.seqId, spawn, records: [spawn] }))
			.reverse();
		case "actor-generations": return actorGenerationItems(ancestry, subject.logicalOccurrence);
		case "actor-messages": return actorMessageItems(ancestry, subject.occurrence);
	}
}

function stateVisitItems(ancestry: readonly DurableLogRecord[], state: StatePath): StateVisitHistoryItem[] {
	type Mutable = { kind: "state-visit"; state: StatePath; seqId: number; invoke: Extract<DurableLogRecord, { type: "state_action"; kind: "invoke" }>; records: DurableLogRecord[] };
	const items: Mutable[] = [];
	const current = new Map<string, Mutable>();
	for (const record of ancestry) {
		if (record.type === "state_action" && record.kind === "invoke") {
			if (record.actionUid.state !== state) continue;
			const item: Mutable = { kind: "state-visit", state, seqId: record.seqId, invoke: record, records: [record] };
			items.push(item);
			current.set(actionUidKey(record.actionUid), item);
			continue;
		}
		const actionUid = "actionUid" in record ? record.actionUid : undefined;
		if (actionUid !== undefined && actionUid.state === state) current.get(actionUidKey(actionUid))?.records.push(record);
		else if (record.type === "failure_intent" && record.origin === state) items.at(-1)?.records.push(record);
	}
	return items.reverse();
}

function actorGenerationItems(ancestry: readonly DurableLogRecord[], logicalOccurrence: StatePath): ActorGenerationHistoryItem[] {
	type Mutable = { kind: "actor-generation"; logicalOccurrence: StatePath; seqId: number; created: Extract<DurableLogRecord, { type: "actor_created" }>; records: DurableLogRecord[] };
	const items: Mutable[] = [];
	const byOccurrence = new Map<StatePath, Mutable>();
	for (const record of ancestry) {
		if (record.type === "actor_created") {
			if (actorLogicalOccurrencePath(record.occurrence, record.generation) !== logicalOccurrence) continue;
			const item: Mutable = { kind: "actor-generation", logicalOccurrence, seqId: record.seqId, created: record, records: [record] };
			items.push(item);
			byOccurrence.set(record.occurrence, item);
			continue;
		}
		const occurrence = recordOccurrence(record);
		if (occurrence !== undefined) byOccurrence.get(occurrence)?.records.push(record);
	}
	return items.reverse();
}

function actorMessageItems(ancestry: readonly DurableLogRecord[], occurrence: StatePath): ActorMessageHistoryItem[] {
	type Mutable = { kind: "actor-message-batch"; occurrence: StatePath; seqId: number; enqueued: Extract<DurableLogRecord, { type: "actor_messages_enqueued" }>; records: DurableLogRecord[] };
	const items: Mutable[] = [];
	const byMessageId = new Map<string, Mutable>();
	for (const record of ancestry) {
		if (record.type === "actor_messages_enqueued" && record.occurrence === occurrence) {
			const item: Mutable = { kind: "actor-message-batch", occurrence, seqId: record.seqId, enqueued: record, records: [record] };
			items.push(item);
			for (const message of record.messages) byMessageId.set(message.messageId, item);
			continue;
		}
		if (record.type === "actor_message" && record.occurrence === occurrence) byMessageId.get(record.messageId)?.records.push(record);
		if (record.type === "actor_call_resolved") byMessageId.get(record.messageId)?.records.push(record);
		if (record.type === "actor_batch_call_resolved") {
			const targets = new Set(record.messageIds.map((messageId) => byMessageId.get(messageId)).filter((item): item is Mutable => item !== undefined));
			for (const item of targets) item.records.push(record);
		}
	}
	return items.reverse();
}

function recordOccurrence(record: DurableLogRecord): StatePath | undefined {
	return "occurrence" in record && typeof record.occurrence === "string" ? record.occurrence : undefined;
}

/** @internal Validate a replay boundary and return the first record after it. */
/** @internal */
export function findUserInteractionResponseInAncestry(ancestry: readonly DurableLogRecord[], gateSeqId: number): Extract<DurableLogRecord, { type: "user_interaction"; kind: "resolved" }> | undefined {
	for (let index = ancestry.length - 1; index >= 0; index--) {
		const record = ancestry[index]!;
		if (record.type === "user_interaction" && record.kind === "resolved" && record.gateSeqId === gateSeqId) return record;
	}
	return undefined;
}

export function replayStart(ancestry: readonly DurableLogRecord[], afterSeqId: number | null): number {
	if (afterSeqId === null) return 0;
	const index = ancestry.findIndex((record) => record.seqId === afterSeqId);
	if (index < 0) throw new Error(`Projection replay boundary ${afterSeqId} is not in target ancestry`);
	return index + 1;
}

/** @internal Package-private projection stream; intentionally absent from exported store declarations. */
export async function* openProjectionReplay(
	reader: Pick<RunHistoryStore, "getRecord">,
	input: { targetHeadSeqId: number | null; afterSeqId: number | null },
): AsyncIterable<readonly DurableLogRecord[]> {
	const newestFirst: DurableLogRecord[] = [];
	let seqId = input.targetHeadSeqId;
	while (seqId !== null) {
		const record = await reader.getRecord(seqId);
		if (record === undefined) throw new Error(`Missing durable parent record ${seqId}`);
		newestFirst.push(record);
		seqId = record.parentId;
	}
	const ancestry = newestFirst.reverse();
	const start = replayStart(ancestry, input.afterSeqId);
	for (let offset = start; offset < ancestry.length; offset += PROJECTION_READ_RECORDS) {
		yield ancestry.slice(offset, offset + PROJECTION_READ_RECORDS);
	}
}

/** @internal Compatibility helper for control paths that still need every branch in Phase 1. */
export async function collectBranches(reader: Pick<RunHistoryStore, "listBranches">): Promise<readonly BranchHead[]> {
	const items: BranchHead[] = [];
	let cursor: BranchListCursor | undefined;
	do {
		const chunk = await reader.listBranches(cursor);
		items.push(...chunk.items);
		cursor = chunk.next;
	} while (cursor !== undefined);
	return items;
}

export interface LogStore extends RunLogReader {
	readonly branchId: BranchId;
	appendDrafts(drafts: readonly DurableRecordDraft[]): Promise<readonly DurableLogRecord[]>;
	/** @internal Stamp facts, prepare an opaque cache row, and commit both atomically when durable. */
	appendDraftsWithCheckpoint(
		drafts: readonly DurableRecordDraft[],
		prepare: (records: readonly DurableLogRecord[]) => StoredProjectionCheckpoint | readonly StoredProjectionCheckpoint[] | undefined,
	): Promise<readonly DurableLogRecord[]>;
}

/** Full run-journal handle: branch entries plus lifecycle, shared across branch handles. */
export interface RunLogStore extends LogStore, ProjectionCheckpointStore {
	forBranch(branchId: BranchId): RunLogStore;
	readRunMeta(): Promise<RunMeta | undefined>;
	writeRunMeta(meta: RunMeta): Promise<void>;
	deleteRunData(): Promise<void>;
	initializeRootBranch(metadata?: BranchMetadata): Promise<BranchHead>;
	initializeRootBranchWithCheckpoint(metadata: BranchMetadata | undefined, checkpoint: StoredProjectionCheckpoint): Promise<BranchHead>;
	createBranch(branchId: BranchId, headSeqId: number, metadata?: BranchMetadata): Promise<BranchHead>;
	createBranchWithCheckpoint(branchId: BranchId, headSeqId: number, metadata: BranchMetadata | undefined, checkpoint: StoredProjectionCheckpoint): Promise<BranchHead>;
	moveBranch(branchId: BranchId, headSeqId: number | null): Promise<BranchHead>;
	moveBranchWithCheckpoint(branchId: BranchId, headSeqId: number | null, checkpoint: StoredProjectionCheckpoint): Promise<BranchHead>;
	respondToUserInteraction(input: RespondToUserInteractionInput): Promise<UserInteractionResponseCommit>;
	commitPreparedUserInteraction(input: PreparedUserInteractionCommit): Promise<UserInteractionResponseCommit>;
	close(): Promise<void>;
}

export type PreparedUserInteractionCommit = Readonly<{
	expectedHeadSeqId: number | null;
	gateSeqId: number;
	draft: Extract<DurableRecordDraft, { type: "user_interaction"; kind: "resolved" }>;
	/** Execution-owned synchronous callback over the stamped response; storage persists only opaque rows. */
	prepareCheckpoints?: (record: Extract<DurableLogRecord, { type: "user_interaction"; kind: "resolved" }>) => readonly StoredProjectionCheckpoint[];
}>;

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
	/** Disposable process-local projection cache. Never persisted beside JSONL. */
	projectionCheckpoints: StoredProjectionCheckpoint[];
	/** Exact durable byte boundary represented by the index. Shared branch handles advance it together. */
	expectedByteLength?: number;
	fullReadCount: number;
};

function newJournal(filePath: string): SharedJournalState {
	return { filePath: resolve(filePath), projectionCheckpoints: [], fullReadCount: 0 };
}

export class JsonlLogStore implements RunLogStore {
	private journal: SharedJournalState;
	readonly canSaveProjectionCheckpoints = true;

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

	async initializeRootBranchWithCheckpoint(metadata: BranchMetadata | undefined, checkpoint: StoredProjectionCheckpoint): Promise<BranchHead> {
		const branch = await this.initializeRootBranch(metadata);
		await this.saveProjectionCheckpoint(checkpoint);
		return branch;
	}

	async appendDrafts(drafts: readonly DurableRecordDraft[]): Promise<readonly DurableLogRecord[]> {
		return this.appendDraftsWithCheckpoint(drafts, () => undefined);
	}

	async appendDraftsWithCheckpoint(
		drafts: readonly DurableRecordDraft[],
		prepare: (records: readonly DurableLogRecord[]) => StoredProjectionCheckpoint | readonly StoredProjectionCheckpoint[] | undefined,
	): Promise<readonly DurableLogRecord[]> {
		if (drafts.length === 0) return [];
		const records = await this.commitBuilt((index) => {
			const stamped = stampDrafts(index, this.branchId, drafts, Date.now());
			return { entries: stamped, result: stamped };
		});
		const prepared = prepare(records);
		for (const checkpoint of prepared === undefined ? [] : Array.isArray(prepared) ? prepared : [prepared]) await this.saveProjectionCheckpoint(checkpoint);
		return records;
	}

	async captureSnapshot(branchId: BranchId): Promise<HistorySnapshot> {
		const branch = this.index().branch(branchId);
		return { branchId, headSeqId: branch.headSeqId };
	}
	async listBranches(cursor?: BranchListCursor): Promise<BranchListChunk> {
		const index = this.index();
		const decoded = cursor === undefined ? undefined : decodeBranchListCursor(cursor);
		const creates = index.entries
			.filter((entry): entry is Extract<StorageEntry, { kind: "branch"; op: "create" }> => !isDurableRecordEntry(entry) && entry.op === "create")
			.sort((left, right) => left.seqId - right.seqId || left.branchId.localeCompare(right.branchId));
		const after = creates.filter((entry) => decoded === undefined || entry.seqId > decoded.createdSeqId || entry.seqId === decoded.createdSeqId && entry.branchId > decoded.branchId);
		const page = after.slice(0, HISTORY_READ_ITEMS);
		return {
			items: page.map((entry) => index.branch(entry.branchId)),
			totalCount: creates.length,
			...(after.length > page.length && page.at(-1) !== undefined ? { next: encodeBranchListCursor(page.at(-1)!.seqId, page.at(-1)!.branchId) } : {}),
		};
	}
	async getBranch(branchId: BranchId): Promise<BranchHead> { return this.index().branch(branchId); }
	async getRecord(seqId: number): Promise<DurableLogRecord | undefined> { return this.index().recordsBySeqId.get(seqId); }
	async containsInHistory(input: { headSeqId: number | null; seqId: number }): Promise<boolean> {
		if (input.headSeqId === null) return false;
		let current: number | null = input.headSeqId;
		while (current !== null) {
			if (current === input.seqId) return true;
			const record = this.index().recordsBySeqId.get(current);
			if (record === undefined) throw new Error(`No durable log record with seqId ${current}`);
			current = record.parentId;
		}
		return false;
	}
	async readRecords(input: { snapshot: HistorySnapshot; cursor?: HistoryCursor }): Promise<HistoryChunk<DurableLogRecord>> {
		return this.readSubject(input.snapshot, { kind: "records" }, input.cursor) as HistoryChunk<DurableLogRecord>;
	}
	async readStateVisits(input: { snapshot: HistorySnapshot; state: StatePath; cursor?: HistoryCursor }): Promise<HistoryChunk<StateVisitHistoryItem>> {
		return this.readSubject(input.snapshot, { kind: "state-visits", state: input.state }, input.cursor) as HistoryChunk<StateVisitHistoryItem>;
	}
	async readMapVisits(input: { snapshot: HistorySnapshot; mapPath: StatePath; cursor?: HistoryCursor }): Promise<HistoryChunk<MapVisitHistoryItem>> {
		return this.readSubject(input.snapshot, { kind: "map-visits", mapPath: input.mapPath }, input.cursor) as HistoryChunk<MapVisitHistoryItem>;
	}
	async readActorGenerations(input: { snapshot: HistorySnapshot; logicalOccurrence: StatePath; cursor?: HistoryCursor }): Promise<HistoryChunk<ActorGenerationHistoryItem>> {
		return this.readSubject(input.snapshot, { kind: "actor-generations", logicalOccurrence: input.logicalOccurrence }, input.cursor) as HistoryChunk<ActorGenerationHistoryItem>;
	}
	async readActorMessages(input: { snapshot: HistorySnapshot; occurrence: StatePath; cursor?: HistoryCursor }): Promise<HistoryChunk<ActorMessageHistoryItem>> {
		return this.readSubject(input.snapshot, { kind: "actor-messages", occurrence: input.occurrence }, input.cursor) as HistoryChunk<ActorMessageHistoryItem>;
	}
	async cursorAt(input: { snapshot: HistorySnapshot; subject: HistorySubject; seqId: number }): Promise<HistoryCursor | undefined> {
		const ancestry = this.ancestryForSnapshot(input.snapshot);
		return cursorAtItems(input.snapshot, input.subject, historyItemsForSubject(ancestry, input.subject), input.seqId);
	}
	async findUserInteractionResponse(input: { headSeqId: number | null; gateSeqId: number }): Promise<Extract<DurableLogRecord, { type: "user_interaction"; kind: "resolved" }> | undefined> {
		return findUserInteractionResponseInAncestry(this.index().ancestryTo(input.headSeqId), input.gateSeqId);
	}
	async readAncestry(branchId: BranchId): Promise<readonly DurableLogRecord[]> {
		const index = this.index();
		return index.entries.length === 0 ? [] : index.ancestry(branchId);
	}
	async containsInAncestry(branchId: BranchId, seqId: number): Promise<boolean> {
		const snapshot = await this.captureSnapshot(branchId);
		return this.containsInHistory({ headSeqId: snapshot.headSeqId, seqId });
	}
	async countRecords(): Promise<number> { return this.index().recordsBySeqId.size; }
	async loadExactProjectionCheckpoint(input: ProjectionCheckpointLookup): Promise<StoredProjectionCheckpoint | undefined> {
		const checkpoint = this.journal.projectionCheckpoints.find((candidate) => candidate.headSeqId === input.targetHeadSeqId && candidate.projectorVersion === input.projectorVersion && candidate.astDigest === input.astDigest);
		return checkpoint === undefined ? undefined : structuredClone(checkpoint);
	}
	async findNearestProjectionCheckpoint(input: ProjectionCheckpointLookup): Promise<StoredProjectionCheckpoint | undefined> {
		const ancestry = this.index().ancestryTo(input.targetHeadSeqId);
		const distance = new Map(ancestry.map((record, index) => [record.seqId, ancestry.length - index - 1]));
		const checkpoint = this.journal.projectionCheckpoints
			.filter((candidate) => candidate.projectorVersion === input.projectorVersion && candidate.astDigest === input.astDigest && (candidate.headSeqId === null || distance.has(candidate.headSeqId)))
			.sort((left, right) => checkpointDistance(left, distance) - checkpointDistance(right, distance) || right.createdAt - left.createdAt)[0];
		return checkpoint === undefined ? undefined : structuredClone(checkpoint);
	}
	async discardProjectionCheckpoint(checkpointId: string): Promise<void> {
		const index = this.journal.projectionCheckpoints.findIndex((checkpoint) => checkpoint.checkpointId === checkpointId);
		if (index >= 0) this.journal.projectionCheckpoints.splice(index, 1);
	}
	async saveProjectionCheckpoint(checkpoint: StoredProjectionCheckpoint): Promise<void> {
		const duplicate = this.journal.projectionCheckpoints.find((candidate) => candidate.headSeqId === checkpoint.headSeqId && candidate.projectorVersion === checkpoint.projectorVersion && candidate.astDigest === checkpoint.astDigest);
		if (duplicate !== undefined) return;
		this.journal.projectionCheckpoints.push(structuredClone(checkpoint));
	}
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
	async createBranchWithCheckpoint(branchId: BranchId, headSeqId: number, metadata: BranchMetadata | undefined, checkpoint: StoredProjectionCheckpoint): Promise<BranchHead> {
		const branch = await this.createBranch(branchId, headSeqId, metadata);
		await this.saveProjectionCheckpoint(checkpoint);
		return branch;
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

	async moveBranchWithCheckpoint(branchId: BranchId, headSeqId: number | null, checkpoint: StoredProjectionCheckpoint): Promise<BranchHead> {
		const branch = await this.moveBranch(branchId, headSeqId);
		await this.saveProjectionCheckpoint(checkpoint);
		return branch;
	}

	async commitPreparedUserInteraction(input: PreparedUserInteractionCommit): Promise<UserInteractionResponseCommit> {
		return enqueueJsonlWrite(this.journal.filePath, async () => {
			const index = this.index();
			const branch = index.branch(this.branchId);
			if (branch.headSeqId !== input.expectedHeadSeqId) throw new Error(`Branch '${this.branchId}' moved while admitting user interaction ${input.gateSeqId}`);
			const existing = findUserInteractionResponseInAncestry(index.ancestryTo(branch.headSeqId), input.gateSeqId);
			if (existing !== undefined) {
				if (isDeepStrictEqual(existing.event, input.draft.event)) return { record: existing, idempotent: true };
				throw new Error(`Conflicting response for user interaction ${input.gateSeqId}`);
			}
			const gate = index.recordsBySeqId.get(input.gateSeqId);
			if (gate?.type !== "user_interaction" || gate.kind !== "opened" || !index.containsInAncestry(this.branchId, input.gateSeqId) || !isDeepStrictEqual(gate.actionUid, input.draft.actionUid)) {
				throw new Error(`User interaction ${input.gateSeqId} is stale or missing from branch '${this.branchId}'`);
			}
			const records = stampDrafts(index, this.branchId, [input.draft], Date.now());
			const record = records[0] as UserInteractionResponseCommit["record"];
			const checkpoints = input.prepareCheckpoints?.(record) ?? [];
			await this.appendLocked(records);
			for (const checkpoint of checkpoints) await this.saveProjectionCheckpoint(checkpoint);
			return { record, idempotent: false };
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

	private readSubject(snapshot: HistorySnapshot, subject: HistorySubject, cursor?: HistoryCursor): HistoryChunk<AnyHistoryItem> {
		const ancestry = this.ancestryForSnapshot(snapshot);
		return historyChunkFromItems(snapshot, subject, historyItemsForSubject(ancestry, subject), cursor);
	}

	private ancestryForSnapshot(snapshot: HistorySnapshot): readonly DurableLogRecord[] {
		const index = this.index();
		index.branch(snapshot.branchId);
		if (snapshot.headSeqId !== null && !index.recordsBySeqId.has(snapshot.headSeqId)) throw new Error(`No durable log record with seqId ${snapshot.headSeqId}`);
		return index.ancestryTo(snapshot.headSeqId);
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

function checkpointDistance(checkpoint: StoredProjectionCheckpoint, distance: ReadonlyMap<number, number>): number {
	return checkpoint.headSeqId === null ? Number.MAX_SAFE_INTEGER : distance.get(checkpoint.headSeqId) ?? Number.MAX_SAFE_INTEGER;
}

function requireBranchId(value: unknown, coordinate: string): BranchId {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > 128 || /[\0/\\]/.test(value)) throw new Error(`${coordinate} must be a non-empty branch id without path separators`);
	return value;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
