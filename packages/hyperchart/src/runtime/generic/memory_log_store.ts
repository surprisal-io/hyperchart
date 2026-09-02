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
	private writeChain: Promise<void> = Promise.resolve();

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
		if (drafts.length === 0) return [];
		const records = stampDrafts(this.index, this.branchId, drafts, Date.now());
		for (const record of records) this.index.applyEntry(record);
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
