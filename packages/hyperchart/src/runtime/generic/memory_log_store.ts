import type {
	BranchId,
	DurableLogRecord,
	DurableRecordDraft,
	StorageMutation,
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
	private mutations: StorageMutation[];
	private writeChain: Promise<void> = Promise.resolve();

	constructor(
		mutations: readonly StorageMutation[] | undefined = undefined,
		readonly branchId: BranchId = DEFAULT_BRANCH_ID,
	) {
		assertBranchId(branchId);
		this.mutations = mutations === undefined
			? [{ kind: "branch", op: "create", branchId, headSeqId: null, metadata: { name: branchId }, committedAt: Date.now() }]
			: [...mutations];
		validateAndProjectJournal(this.mutations);
	}

	async appendDrafts(drafts: readonly DurableRecordDraft[]): Promise<readonly DurableLogRecord[]> {
		if (drafts.length === 0) return [];
		const normalized = validateAndProjectJournal(this.mutations);
		const { records, mutation } = stampDrafts(normalized, this.branchId, drafts, Date.now());
		this.mutations.push(mutation);
		return records;
	}

	snapshot(): NormalizedRunLog {
		return validateAndProjectJournal(this.mutations);
	}

	async read(): Promise<NormalizedRunLog> {
		return this.snapshot();
	}

	respondToUserInteraction(input: RespondToUserInteractionInput): Promise<UserInteractionResponseCommit> {
		return this.enqueue(async () => {
			await prepareUserInteractionResponse(validateAndProjectJournal(this.mutations), this.branchId, input);
			const normalized = validateAndProjectJournal(this.mutations);
			const prepared = prepareUserInteractionResponseSync(normalized, this.branchId, input);
			if (prepared.kind === "idempotent") return { record: prepared.record, idempotent: true };
			const { records, mutation } = stampDrafts(normalized, this.branchId, [prepared.draft], Date.now());
			this.mutations.push(mutation);
			return { record: records[0] as UserInteractionResponseCommit["record"], idempotent: false };
		});
	}

	async readAll(): Promise<readonly DurableLogRecord[]> {
		const normalized = await this.read();
		if (normalized.mutations.length === 0) return [];
		return normalized.ancestry(this.branchId);
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const result = this.writeChain.then(task);
		this.writeChain = result.then(() => undefined, () => undefined);
		return result;
	}

	storageMutations(): readonly StorageMutation[] {
		return [...this.mutations];
	}
}

function assertBranchId(value: BranchId): void {
	if (value.trim().length === 0 || value.length > 128 || /[\0/\\]/.test(value)) {
		throw new Error("selected branch must be a non-empty branch id without path separators");
	}
}
