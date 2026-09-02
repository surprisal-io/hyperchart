import type { BranchId, DurableLogRecord } from "../../packages/hyperchart/src/core/durable_events.js";
import type { HistoryCursor, RunHistoryStore } from "../../packages/hyperchart/src/runtime/generic/log_store.js";

/** Test-only collector over the public bounded history contract. */
export async function collectHistoryRecords(
	store: Pick<RunHistoryStore, "captureSnapshot" | "readRecords">,
	branchId: BranchId,
): Promise<readonly DurableLogRecord[]> {
	const snapshot = await store.captureSnapshot(branchId);
	const newestFirst: DurableLogRecord[] = [];
	let cursor: HistoryCursor | undefined;
	do {
		const chunk = await store.readRecords({ snapshot, ...(cursor === undefined ? {} : { cursor }) });
		newestFirst.push(...chunk.items);
		cursor = chunk.older;
	} while (cursor !== undefined);
	return newestFirst.reverse();
}
