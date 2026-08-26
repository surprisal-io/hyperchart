import type {
	BranchId,
	DurableLogRecord,
	DurableRecordDraft,
	StorageEntry,
} from "../../core/durable_events.js";
import {
	DEFAULT_BRANCH_ID,
	type LogStore,
	type NormalizedRunLog,
	stampDrafts,
	validateAndProjectJournal,
	type RespondToUserInteractionInput,
	type UserInteractionResponseCommit,
} from "./log_store.js";
import { prepareUserInteractionResponse, prepareUserInteractionResponseSync } from "./user_interaction_admission.js";

export class MemoryLogStore implements LogStore {
	private entries: StorageEntry[];
	private writeChain: Promise<void> = Promise.resolve();

	constructor(
		entries: readonly StorageEntry[] | undefined = undefined,
		readonly branchId: BranchId = DEFAULT_BRANCH_ID,
	) {
		assertBranchId(branchId);
		this.entries = entries === undefined
			? [{ kind: "branch", op: "create", seqId: 1, branchId, headSeqId: null, metadata: { name: branchId }, committedAt: Date.now() }]
			: [...entries];
		validateAndProjectJournal(this.entries);
	}

	async appendDrafts(drafts: readonly DurableRecordDraft[]): Promise<readonly DurableLogRecord[]> {
		if (drafts.length === 0) return [];
		const normalized = validateAndProjectJournal(this.entries);
		const records = stampDrafts(normalized, this.branchId, drafts, Date.now());
		this.entries.push(...records);
		return records;
	}

	snapshot(): NormalizedRunLog {
		return validateAndProjectJournal(this.entries);
	}

	async read(): Promise<NormalizedRunLog> {
		return this.snapshot();
	}

	respondToUserInteraction(input: RespondToUserInteractionInput): Promise<UserInteractionResponseCommit> {
		return this.enqueue(async () => {
			await prepareUserInteractionResponse(validateAndProjectJournal(this.entries), this.branchId, input);
			const normalized = validateAndProjectJournal(this.entries);
			const prepared = prepareUserInteractionResponseSync(normalized, this.branchId, input);
			if (prepared.kind === "idempotent") return { record: prepared.record, idempotent: true };
			const records = stampDrafts(normalized, this.branchId, [prepared.draft], Date.now());
			this.entries.push(...records);
			return { record: records[0] as UserInteractionResponseCommit["record"], idempotent: false };
		});
	}

	async readAll(): Promise<readonly DurableLogRecord[]> {
		const normalized = await this.read();
		if (normalized.entries.length === 0) return [];
		return normalized.ancestry(this.branchId);
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const result = this.writeChain.then(task);
		this.writeChain = result.then(() => undefined, () => undefined);
		return result;
	}

	storageEntries(): readonly StorageEntry[] {
		return [...this.entries];
	}
}

function assertBranchId(value: BranchId): void {
	if (value.trim().length === 0 || value.length > 128 || /[\0/\\]/.test(value)) {
		throw new Error("selected branch must be a non-empty branch id without path separators");
	}
}
