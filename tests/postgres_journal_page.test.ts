import { describe, expect, it, vi } from "vitest";
import {
	decodePostgresJournalRow,
	readPostgresJournalPage,
	type PostgresJournalRow,
} from "../packages/hyperchart/src/runtime/index.js";

function row(seq: number, overrides: Partial<PostgresJournalRow> = {}): PostgresJournalRow {
	return {
		seq: String(seq),
		kind: "record",
		branch_id: "main",
		parent_id: null,
		head_seq_id: null,
		record_type: "args",
		payload: { args: { topic: "test" }, timestamp: 42 },
		metadata: null,
		committed_at_ms: "42",
		...overrides,
	};
}

describe("physical PostgreSQL journal pages", () => {
	it("reads one globally ordered page including branch mutations, without ancestry filtering", async () => {
		const rows = [
			row(1, { kind: "branch_create", record_type: null, payload: null, metadata: { name: "main" } }),
			row(2),
			row(3, {
				kind: "branch_create",
				branch_id: "fork",
				record_type: null,
				payload: null,
				head_seq_id: "2",
				metadata: { sourceBranchId: "main", sourceSeqId: 2 },
			}),
			row(4, {
				branch_id: "fork",
				parent_id: "2",
				record_type: "emit",
				payload: {
					event: "DONE",
					payload: { ok: true },
					actionUid: { chart: "test", state: "work", action: "emit" },
					timestamp: 43,
				},
			}),
			row(5, { kind: "branch_move", branch_id: "fork", head_seq_id: "2", record_type: null, payload: null }),
		];
		const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({ rows }));
		const page = await readPostgresJournalPage({ query }, { runId: "run", afterSeq: 0, limit: 5 });
		expect(query).toHaveBeenCalledTimes(1);
		expect(query.mock.calls[0]).toEqual([expect.stringContaining("ORDER BY seq LIMIT $3"), ["run", 0, 5]]);
		expect(page.map((entry) => entry.seqId)).toEqual([1, 2, 3, 4, 5]);
		expect(page[0]).toEqual({
			kind: "branch",
			op: "create",
			seqId: 1,
			branchId: "main",
			headSeqId: null,
			committedAt: 42,
			metadata: { name: "main" },
		});
		expect(page[1]).toEqual({
			type: "args",
			seqId: 2,
			branchId: "main",
			parentId: null,
			args: { topic: "test" },
			timestamp: 42,
		});
		expect(page[3]).toMatchObject({
			type: "emit",
			seqId: 4,
			branchId: "fork",
			parentId: 2,
			event: "DONE",
			payload: { ok: true },
		});
		expect(page[4]).toEqual({ kind: "branch", op: "move", seqId: 5, branchId: "fork", headSeqId: 2, committedAt: 42 });
	});
	it("resumes strictly after the supplied cursor and returns an empty tail", async () => {
		const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({ rows: [row(8)] }));
		expect(await readPostgresJournalPage({ query }, { runId: "run", afterSeq: 7 })).toHaveLength(1);
		expect(query.mock.calls[0]?.[1]).toEqual(["run", 7, 500]);
		expect(await readPostgresJournalPage({ query: async () => ({ rows: [] }) }, { runId: "run", afterSeq: 8 })).toEqual(
			[],
		);
	});
	it("rejects sequence gaps", async () => {
		await expect(
			readPostgresJournalPage({ query: async () => ({ rows: [row(2)] }) }, { runId: "run", afterSeq: 0 }),
		).rejects.toThrow("expected 1, got 2");
	});
	it.each([0, 501, 1.5, Infinity])("rejects invalid page size %s before SQL", async (limit) => {
		const query = vi.fn();
		await expect(readPostgresJournalPage({ query }, { runId: "run", afterSeq: 0, limit })).rejects.toThrow(
			"page limit",
		);
		expect(query).not.toHaveBeenCalled();
	});
	it("rejects invalid cursors and unsafe stored coordinates", async () => {
		await expect(readPostgresJournalPage({ query: vi.fn() }, { runId: "run", afterSeq: -1 })).rejects.toThrow(
			"afterSeq",
		);
		expect(() => decodePostgresJournalRow(row(1, { seq: "9007199254740993" }))).toThrow("safe integer");
	});
});
