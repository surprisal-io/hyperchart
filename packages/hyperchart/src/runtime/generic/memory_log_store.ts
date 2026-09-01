import type {
	BranchHead,
	BranchId,
	DurableLogRecord,
	DurableRecordDraft,
	StorageEntry,
} from "../../core/durable_events.js";
import {
	DEFAULT_BRANCH_ID,
	type LogStore,
	materializeJournal,
	stampDrafts,
	type RespondToUserInteractionInput,
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

	async listBranches(): Promise<readonly BranchHead[]> { return [...this.index.branches.values()]; }
	async getBranch(branchId: BranchId): Promise<BranchHead> { return this.index.branch(branchId); }
	async getRecord(seqId: number): Promise<DurableLogRecord | undefined> { return this.index.recordsBySeqId.get(seqId); }
	async readAncestry(branchId: BranchId): Promise<readonly DurableLogRecord[]> { return this.index.entries.length === 0 ? [] : this.index.ancestry(branchId); }
	async containsInAncestry(branchId: BranchId, seqId: number): Promise<boolean> { return this.index.entries.length === 0 ? false : this.index.containsInAncestry(branchId, seqId); }
	async countRecords(): Promise<number> { return this.index.recordsBySeqId.size; }

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
