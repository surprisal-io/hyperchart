import type {
	BranchHead,
	BranchId,
	DurableLogRecord,
	DurableRecordDraft,
	StorageEntry,
} from "../../core/durable_events.js";
import {
	BranchHeadMovedError,
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
	type AppendAtHeadInput,
	type PrepareStampedCommit,
	type MapVisitHistoryItem,
	type CheckpointQuery,
	type OpaqueCheckpointEnvelope,
	boundedForwardReplayPage,
	cloneOpaqueCheckpoint,
	cursorAtItems,
	decodeBranchListCursor,
	encodeBranchListCursor,
	findUserInteractionResponseInAncestry,
	historyChunkFromItems,
	historyItemsForSubject,
	materializeJournal,
	registerReplayPageReader,
	stampDrafts,
	type StateVisitHistoryItem,
} from "./log_store.js";

export class MemoryLogStore implements LogStore {
	private readonly index;
	private readonly checkpoints: OpaqueCheckpointEnvelope[] = [];
	private writeChain: Promise<void> = Promise.resolve();
	private poisoned = false;
	readonly canStoreCheckpoints = true;

	constructor(readonly branchId: BranchId = DEFAULT_BRANCH_ID) {
		assertBranchId(branchId);
		this.index = materializeJournal([
			{ kind: "branch", op: "create", seqId: 1, branchId, headSeqId: null, metadata: { name: branchId }, committedAt: Date.now() },
		]);
		registerReplayPageReader(this, async (input) => boundedForwardReplayPage(this.index, input));
	}

	async appendDrafts(drafts: readonly DurableRecordDraft[], prepare?: PrepareStampedCommit): Promise<readonly DurableLogRecord[]> {
		return this.enqueueCommit(undefined, drafts, prepare);
	}
	async appendDraftsAtHead(input: AppendAtHeadInput, prepare?: PrepareStampedCommit): Promise<readonly DurableLogRecord[]> {
		return this.enqueueCommit(input.expectedHeadSeqId, input.drafts, prepare, true);
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
		return findUserInteractionResponseInAncestry(this.index.materializeHistoryToHead(input.headSeqId), input.gateSeqId);
	}
	async countRecords(): Promise<number> { return this.index.recordsBySeqId.size; }
	async loadExactCheckpoint(input: CheckpointQuery): Promise<OpaqueCheckpointEnvelope | undefined> {
		const checkpoint = this.checkpoints.find((candidate) => candidate.headSeqId === input.targetHeadSeqId && candidate.selectorKey === input.selectorKey);
		return checkpoint === undefined ? undefined : structuredClone(checkpoint);
	}
	async findNearestCheckpoint(input: CheckpointQuery): Promise<OpaqueCheckpointEnvelope | undefined> {
		const ancestry = this.index.materializeHistoryToHead(input.targetHeadSeqId);
		const distance = new Map(ancestry.map((record, index) => [record.seqId, ancestry.length - index - 1]));
		const checkpoint = this.checkpoints
			.filter((candidate) => candidate.selectorKey === input.selectorKey && (candidate.headSeqId === null || distance.has(candidate.headSeqId)))
			.sort((left, right) => (left.headSeqId === null ? Number.MAX_SAFE_INTEGER : distance.get(left.headSeqId)!) - (right.headSeqId === null ? Number.MAX_SAFE_INTEGER : distance.get(right.headSeqId)!) || right.createdAt - left.createdAt)[0];
		return checkpoint === undefined ? undefined : structuredClone(checkpoint);
	}
	async discardCheckpoint(checkpointId: string): Promise<void> {
		const index = this.checkpoints.findIndex((checkpoint) => checkpoint.checkpointId === checkpointId);
		if (index >= 0) this.checkpoints.splice(index, 1);
	}
	async storeCheckpoint(checkpoint: OpaqueCheckpointEnvelope): Promise<void> {
		this.rememberClonedCheckpoint(cloneOpaqueCheckpoint(checkpoint));
	}

	private readSubject(snapshot: HistorySnapshot, subject: HistorySubject, cursor?: HistoryCursor): HistoryChunk<DurableLogRecord | StateVisitHistoryItem | MapVisitHistoryItem | ActorGenerationHistoryItem | ActorMessageHistoryItem> {
		return historyChunkFromItems(snapshot, subject, historyItemsForSubject(this.ancestryForSnapshot(snapshot), subject), cursor);
	}
	private ancestryForSnapshot(snapshot: HistorySnapshot): readonly DurableLogRecord[] {
		this.index.branch(snapshot.branchId);
		if (snapshot.headSeqId !== null && !this.index.recordsBySeqId.has(snapshot.headSeqId)) throw new Error(`No durable log record with seqId ${snapshot.headSeqId}`);
		return this.index.materializeHistoryToHead(snapshot.headSeqId);
	}

	private enqueueCommit(expectedHeadSeqId: number | null | undefined, drafts: readonly DurableRecordDraft[], prepare?: PrepareStampedCommit, compareHead = false): Promise<readonly DurableLogRecord[]> {
		if (drafts.length === 0) return Promise.resolve([]);
		return this.enqueue(async () => {
			if (this.poisoned) throw new Error("Memory Hyperchart journal is unusable after a post-commit confirmation failure");
			const branch = this.index.branch(this.branchId);
			if (compareHead && branch.headSeqId !== expectedHeadSeqId) throw new BranchHeadMovedError(this.branchId, expectedHeadSeqId ?? null, branch.headSeqId);
			const records = stampDrafts(this.index, this.branchId, drafts, Date.now());
			const prepared = prepare?.(records);
			const checkpoints = (prepared?.checkpoints ?? []).map(cloneOpaqueCheckpoint);
			for (const record of records) this.index.applyEntry(record);
			for (const checkpoint of checkpoints) this.rememberClonedCheckpoint(checkpoint);
			try { prepared?.committed(); } catch (error) { this.poisoned = true; throw error; }
			return records;
		});
	}

	private rememberClonedCheckpoint(checkpoint: OpaqueCheckpointEnvelope): void {
		if (this.checkpoints.some((candidate) => candidate.headSeqId === checkpoint.headSeqId && candidate.selectorKey === checkpoint.selectorKey)) return;
		this.checkpoints.push(checkpoint);
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const result = this.writeChain.then(task);
		this.writeChain = result.then(() => undefined, () => undefined);
		return result;
	}

}

function assertBranchId(value: BranchId): void {
	if (value.trim().length === 0 || value.length > 128 || /[\0/\\]/.test(value)) {
		throw new Error("selected branch must be a non-empty branch id without path separators");
	}
}
