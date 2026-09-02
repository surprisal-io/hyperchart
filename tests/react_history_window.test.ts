import { describe, expect, it } from "vitest";
import type { HistoryChunk } from "../packages/hyperchart/src/runtime/generic/log_store.js";
import { HISTORY_WINDOW_ITEMS, mergeHistoryWindow } from "../packages/hyperchart/src/react/components/inspector/history/useHistoryWindow.js";

const snapshot = { branchId: "main", headSeqId: 2_000 } as const;
type Item = { seqId: number };
const chunk = (start: number, count: number, edges: { older?: string; newer?: string } = {}): HistoryChunk<Item> => ({
	snapshot,
	items: Array.from({ length: count }, (_, index) => ({ seqId: start - index })),
	...edges,
});
const identity = (item: Item) => String(item.seqId);

describe("bidirectional inspector history window", () => {
	it("deduplicates overlaps and preserves canonical newest-first order", () => {
		const initial = mergeHistoryWindow({ segments: [] }, chunk(200, 100, { older: "older-1" }), "initial", identity);
		const older = mergeHistoryWindow(initial, {
			snapshot,
			items: [{ seqId: 101 }, { seqId: 100 }, { seqId: 99 }],
			older: "older-2",
			newer: "newer-2",
		}, "older", identity);
		expect(older.segments.flatMap((segment) => segment.items).map((item) => item.seqId)).toEqual([
			...Array.from({ length: 100 }, (_, index) => 200 - index), 100, 99,
		]);
	});

	it("never retains more than 1,000 rows and retains a reload cursor at the evicted edge", () => {
		let state = mergeHistoryWindow({ segments: [] }, chunk(2_000, 100, { older: "older-0" }), "initial", identity);
		for (let page = 1; page <= 10; page++) {
			state = mergeHistoryWindow(state, chunk(2_000 - page * 100, 100, { older: `older-${page}`, newer: `newer-${page}` }), "older", identity);
			expect(state.segments.flatMap((segment) => segment.items)).toHaveLength(Math.min((page + 1) * 100, HISTORY_WINDOW_ITEMS));
		}
		const items = state.segments.flatMap((segment) => segment.items);
		expect(items).toHaveLength(HISTORY_WINDOW_ITEMS);
		expect(items[0]?.seqId).toBe(1_900);
		expect(state.newer).toBe("newer-1");
		expect(state.older).toBe("older-10");
	});

	it("evicts whole opposite-edge chunks when reloading newer rows", () => {
		let state = mergeHistoryWindow({ segments: [] }, chunk(1_000, 100, { older: "o0", newer: "n0" }), "initial", identity);
		for (let page = 1; page < 10; page++) state = mergeHistoryWindow(state, chunk(1_000 - page * 100, 100, { older: `o${page}`, newer: `n${page}` }), "older", identity);
		state = mergeHistoryWindow(state, chunk(1_100, 100, { older: "o-new", newer: "n-new" }), "newer", identity);
		const items = state.segments.flatMap((segment) => segment.items);
		expect(items).toHaveLength(1_000);
		expect(items[0]?.seqId).toBe(1_100);
		expect(items.at(-1)?.seqId).toBe(101);
		expect(state.older).toBe("o8");
	});
});
