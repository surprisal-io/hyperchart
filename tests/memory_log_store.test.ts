import { describe, expect, it } from "vitest";
import type { DurableRecordDraft } from "../packages/hyperchart/src/index.js";
import { MemoryLogStore } from "../packages/hyperchart/src/runtime/generic/memory_log_store.js";

function argsDraft(args: Readonly<Record<string, unknown>> = { topic: "test" }): DurableRecordDraft {
	return { type: "args", args };
}

function invokeDraft(): DurableRecordDraft {
	const actionUid = { chart: "chart", state: "work", action: "agent" };
	return { type: "state_action", kind: "invoke", sessionId: "session-id", actionUid, definition: { kind: "agent", uid: actionUid, name: "worker" } };
}

describe("MemoryLogStore", () => {
	it("stamps drafts from the selected durable head", async () => {
		const store = new MemoryLogStore();
		const first = await store.appendDrafts([argsDraft(), invokeDraft()]);
		expect(first.map(({ seqId, parentId, branchId }) => ({ seqId, parentId, branchId }))).toEqual([
			{ seqId: 2, parentId: null, branchId: "main" },
			{ seqId: 3, parentId: 2, branchId: "main" },
		]);
		await expect(store.readAncestry(store.branchId)).resolves.toEqual(first);
		const entries = store.storageEntries();
		expect(entries).toEqual([expect.objectContaining({ kind: "branch", seqId: 1 }), ...first]);
	});
});
