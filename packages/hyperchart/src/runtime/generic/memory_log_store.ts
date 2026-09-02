import type {
	BranchHead,
	BranchId,
	DurableLogRecord,
	DurableRecordDraft,
	StorageEntry,
} from "../../core/durable_events.js";
import {
	DEFAULT_BRANCH_ID,
	HISTORY_READ_ITEMS,
	type ActorGenerationHistoryItem,
	type ActorMessageHistoryItem,
	type BranchListChunk,
	type BranchListCursor,
	type HistoryChunk,
	type HistoryCursor,
	type HistorySnapshot,
	type HistorySubject,
	type LogStore,
	type MapVisitHistoryItem,
	type ProjectionCheckpointLookup,
	type StoredProjectionCheckpoint,
	cursorAtItems,
	decodeBranchListCursor,
	encodeBranchListCursor,
	findUserInteractionResponseInAncestry,
	historyChunkFromItems,
	historyItemsForSubject,
	materializeJournal,
	stampDrafts,
	type RespondToUserInteractionInput,
	type StateVisitHistoryItem,
	type UserInteractionResponseCommit,
} from "./log_store.js";
import { prepareUserInteractionResponse } from "./user_interaction_admission.js";

export class MemoryLogStore implements LogStore {
	private readonly index;
	private readonly projectionCheckpoints: StoredProjectionCheckpoint[] = [];
	private writeChain: Promise<void> = Promise.resolve();
	readonly canSaveProjectionCheckpoints = true;

	constructor(
		entries: readonly StorageEntry[] | undefined = undefined,
		readonly branchId: BranchId = DEFAULT_BRANCH_ID,
	) {
		assertBranchId(branchId);
		this.index = materializeJournal(entries === undefined
			? [{ kind: "branch", op: "create", seqId: 1, branchId, headSeqId: null, metadata: { name: branchId }, committedAt: Date.now() }]
			: entries);
	}

	async appendDrafts(drafts: readonly DurableRecordDraft[]): Promise<readonly DurableLogRecord[]> {
		return this.appendDraftsWithCheckpoint(drafts, () => undefined);
	}
	async appendDraftsWithCheckpoint(
		drafts: readonly DurableRecordDraft[],
		prepare: (records: readonly DurableLogRecord[]) => StoredProjectionCheckpoint | readonly StoredProjectionCheckpoint[] | undefined,
	): Promise<readonly DurableLogRecord[]> {
		if (drafts.length === 0) return [];
		const records = stampDrafts(this.index, this.branchId, drafts, Date.now());
		const prepared = prepare(records);
		for (const record of records) this.index.applyEntry(record);
		for (const checkpoint of prepared === undefined ? [] : Array.isArray(prepared) ? prepared : [prepared]) await this.saveProjectionCheckpoint(checkpoint);
		return records;
	}

	async captureSnapshot(branchId: BranchId): Promise<HistorySnapshot> { return { branchId, headSeqId: this.index.branch(branchId).headSeqId }; }
	async listBranches(cursor?: BranchListCursor): Promise<BranchListChunk> {
		const decoded = cursor === undefined ? undefined : decodeBranchListCursor(cursor);
		const creates = this.index.entries
			.filter((entry): entry is Extract<StorageEntry, { kind: "branch"; op: "create" }> => !("type" in entry) && entry.op === "create")
			.sort((left, right) => left.seqId - right.seqId || left.branchId.localeCompare(right.branchId));
		const after = creates.filter((entry) => decoded === undefined || entry.seqId > decoded.createdSeqId || entry.seqId === decoded.createdSeqId && entry.branchId > decoded.branchId);
		const page = after.slice(0, HISTORY_READ_ITEMS);
		return { items: page.map((entry) => this.index.branch(entry.branchId)), totalCount: creates.length,
			...(after.length > page.length ? { next: encodeBranchListCursor(page.at(-1)!.seqId, page.at(-1)!.branchId) } : {}) };
	}
	async getBranch(branchId: BranchId): Promise<BranchHead> { return this.index.branch(branchId); }
	async getRecord(seqId: number): Promise<DurableLogRecord | undefined> { return this.index.recordsBySeqId.get(seqId); }
	async containsInHistory(input: { headSeqId: number | null; seqId: number }): Promise<boolean> {
		if (input.headSeqId === null) return false;
		let current: number | null = input.headSeqId;
		while (current !== null) {
			if (current === input.seqId) return true;
			const record = this.index.recordsBySeqId.get(current);
			if (record === undefined) throw new Error(`No durable log record with seqId ${current}`);
			current = record.parentId;
		}
		return false;
	}
	async readRecords(input: { snapshot: HistorySnapshot; cursor?: HistoryCursor }): Promise<HistoryChunk<DurableLogRecord>> { return this.readSubject(input.snapshot, { kind: "records" }, input.cursor) as HistoryChunk<DurableLogRecord>; }
	async readStateVisits(input: { snapshot: HistorySnapshot; state: string; cursor?: HistoryCursor }): Promise<HistoryChunk<StateVisitHistoryItem>> { return this.readSubject(input.snapshot, { kind: "state-visits", state: input.state }, input.cursor) as HistoryChunk<StateVisitHistoryItem>; }
	async readMapVisits(input: { snapshot: HistorySnapshot; mapPath: string; cursor?: HistoryCursor }): Promise<HistoryChunk<MapVisitHistoryItem>> { return this.readSubject(input.snapshot, { kind: "map-visits", mapPath: input.mapPath }, input.cursor) as HistoryChunk<MapVisitHistoryItem>; }
	async readActorGenerations(input: { snapshot: HistorySnapshot; logicalOccurrence: string; cursor?: HistoryCursor }): Promise<HistoryChunk<ActorGenerationHistoryItem>> { return this.readSubject(input.snapshot, { kind: "actor-generations", logicalOccurrence: input.logicalOccurrence }, input.cursor) as HistoryChunk<ActorGenerationHistoryItem>; }
	async readActorMessages(input: { snapshot: HistorySnapshot; occurrence: string; cursor?: HistoryCursor }): Promise<HistoryChunk<ActorMessageHistoryItem>> { return this.readSubject(input.snapshot, { kind: "actor-messages", occurrence: input.occurrence }, input.cursor) as HistoryChunk<ActorMessageHistoryItem>; }
	async cursorAt(input: { snapshot: HistorySnapshot; subject: HistorySubject; seqId: number }): Promise<HistoryCursor | undefined> {
		return cursorAtItems(input.snapshot, input.subject, historyItemsForSubject(this.ancestryForSnapshot(input.snapshot), input.subject), input.seqId);
	}
	async findUserInteractionResponse(input: { headSeqId: number | null; gateSeqId: number }): Promise<Extract<DurableLogRecord, { type: "user_interaction"; kind: "resolved" }> | undefined> {
		return findUserInteractionResponseInAncestry(this.index.ancestryTo(input.headSeqId), input.gateSeqId);
	}
	async readAncestry(branchId: BranchId): Promise<readonly DurableLogRecord[]> { return this.index.entries.length === 0 ? [] : this.index.ancestry(branchId); }
	async containsInAncestry(branchId: BranchId, seqId: number): Promise<boolean> { return this.containsInHistory({ headSeqId: this.index.branch(branchId).headSeqId, seqId }); }
	async countRecords(): Promise<number> { return this.index.recordsBySeqId.size; }
	async loadExactProjectionCheckpoint(input: ProjectionCheckpointLookup): Promise<StoredProjectionCheckpoint | undefined> {
		const checkpoint = this.projectionCheckpoints.find((candidate) => candidate.headSeqId === input.targetHeadSeqId && candidate.projectorVersion === input.projectorVersion && candidate.astDigest === input.astDigest);
		return checkpoint === undefined ? undefined : structuredClone(checkpoint);
	}
	async findNearestProjectionCheckpoint(input: ProjectionCheckpointLookup): Promise<StoredProjectionCheckpoint | undefined> {
		const ancestry = this.index.ancestryTo(input.targetHeadSeqId);
		const distance = new Map(ancestry.map((record, index) => [record.seqId, ancestry.length - index - 1]));
		const checkpoint = this.projectionCheckpoints
			.filter((candidate) => candidate.projectorVersion === input.projectorVersion && candidate.astDigest === input.astDigest && (candidate.headSeqId === null || distance.has(candidate.headSeqId)))
			.sort((left, right) => (left.headSeqId === null ? Number.MAX_SAFE_INTEGER : distance.get(left.headSeqId)!) - (right.headSeqId === null ? Number.MAX_SAFE_INTEGER : distance.get(right.headSeqId)!) || right.createdAt - left.createdAt)[0];
		return checkpoint === undefined ? undefined : structuredClone(checkpoint);
	}
	async discardProjectionCheckpoint(checkpointId: string): Promise<void> {
		const index = this.projectionCheckpoints.findIndex((checkpoint) => checkpoint.checkpointId === checkpointId);
		if (index >= 0) this.projectionCheckpoints.splice(index, 1);
	}
	async saveProjectionCheckpoint(checkpoint: StoredProjectionCheckpoint): Promise<void> {
		if (this.projectionCheckpoints.some((candidate) => candidate.headSeqId === checkpoint.headSeqId && candidate.projectorVersion === checkpoint.projectorVersion && candidate.astDigest === checkpoint.astDigest)) return;
		this.projectionCheckpoints.push(structuredClone(checkpoint));
	}

	private readSubject(snapshot: HistorySnapshot, subject: HistorySubject, cursor?: HistoryCursor): HistoryChunk<DurableLogRecord | StateVisitHistoryItem | MapVisitHistoryItem | ActorGenerationHistoryItem | ActorMessageHistoryItem> {
		return historyChunkFromItems(snapshot, subject, historyItemsForSubject(this.ancestryForSnapshot(snapshot), subject), cursor);
	}
	private ancestryForSnapshot(snapshot: HistorySnapshot): readonly DurableLogRecord[] {
		this.index.branch(snapshot.branchId);
		if (snapshot.headSeqId !== null && !this.index.recordsBySeqId.has(snapshot.headSeqId)) throw new Error(`No durable log record with seqId ${snapshot.headSeqId}`);
		return this.index.ancestryTo(snapshot.headSeqId);
	}

	respondToUserInteraction(input: RespondToUserInteractionInput): Promise<UserInteractionResponseCommit> {
		return this.enqueue(async () => {
			const ancestry = this.index.ancestry(this.branchId);
			const prepared = await prepareUserInteractionResponse(ancestry, this.branchId, input);
			if (prepared.kind === "idempotent") return { record: prepared.record, idempotent: true };
			const records = stampDrafts(this.index, this.branchId, [prepared.draft], Date.now());
			for (const record of records) this.index.applyEntry(record);
			return { record: records[0] as UserInteractionResponseCommit["record"], idempotent: false };
		});
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const result = this.writeChain.then(task);
		this.writeChain = result.then(() => undefined, () => undefined);
		return result;
	}

	storageEntries(): readonly StorageEntry[] { return [...this.index.entries]; }
}

function assertBranchId(value: BranchId): void {
	if (value.trim().length === 0 || value.length > 128 || /[\0/\\]/.test(value)) {
		throw new Error("selected branch must be a non-empty branch id without path separators");
	}
}
