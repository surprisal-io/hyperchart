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

	appendDrafts(drafts: readonly DurableRecordDraft[]): readonly DurableLogRecord[] {
		if (drafts.length === 0) return [];
		const normalized = validateAndProjectJournal(this.mutations);
		const now = Date.now();
		const branch = normalized.branches.get(this.branchId);
		if (branch === undefined) throw new Error(`Unknown Hyperchart branch '${this.branchId}'`);
		let nextSeqId = normalized.nextSeqId;
		let parentId = branch.headSeqId;
		const records = drafts.map((draft) => {
			assertDraft(draft);
			const record = { ...draft, seqId: nextSeqId++, parentId, branchId: this.branchId, timestamp: now } as DurableLogRecord;
			parentId = record.seqId;
			return record;
		});
		const tail = records.at(-1);
		if (tail !== undefined) {
			this.mutations.push({ kind: "record_batch", branchId: this.branchId, records, headSeqId: tail.seqId, committedAt: now });
		}
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

function assertDraft(value: DurableRecordDraft): void {
	if (typeof value !== "object" || value === null || Array.isArray(value) || typeof value.type !== "string") {
		throw new Error("Durable record draft must contain a machine record type");
	}
	if ("seqId" in value || "parentId" in value || "branchId" in value || "timestamp" in value) {
		throw new Error("Durable record coordinates are assigned only by the run writer");
	}
}
