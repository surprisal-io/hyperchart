import type { DurableLogRecord, DurableRecordDraft } from "../../packages/hyperchart/src/core/durable_events.js";
import { MemoryLogStore } from "../../packages/hyperchart/src/runtime/generic/memory_log_store.js";

/** Test-only seeding through the same public append path used by execution. */
export async function seedMemoryLogStore(records: readonly DurableLogRecord[]): Promise<MemoryLogStore> {
	const store = new MemoryLogStore();
	const drafts = records.map(({ seqId: _seqId, parentId: _parentId, branchId: _branchId, timestamp: _timestamp, ...draft }) => draft as DurableRecordDraft);
	await store.appendDrafts(drafts);
	return store;
}
