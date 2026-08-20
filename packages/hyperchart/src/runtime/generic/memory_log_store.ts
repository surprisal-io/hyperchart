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
} from "./log_store.js";

export class MemoryLogStore implements LogStore {
	private mutations: StorageMutation[];

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

	async readAll(): Promise<readonly DurableLogRecord[]> {
		const normalized = await this.read();
		if (normalized.mutations.length === 0) return [];
		return normalized.ancestry(this.branchId);
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
