import { afterEach, describe, expect, it, vi } from "vitest";
import { browserHistoryDataSource } from "../packages/hyperchart/src/inspect/inspector_http_client.js";

afterEach(() => vi.unstubAllGlobals());

describe("browser inspector history transport", () => {
	it("decodes explicit absence for missing cursors and visit sessions", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ found: false }) });
		vi.stubGlobal("fetch", fetchMock);
		const source = browserHistoryDataSource("token");
		const snapshot = { branchId: "main", headSeqId: null } as const;
		await expect(source.cursorAt({ runId: "run", snapshot, subject: { kind: "records" }, seqId: 9 })).resolves.toBeUndefined();
		await expect(source.readVisitSession({ runId: "run", branchId: "main", invokeSeqId: 9 })).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("rejects malformed success envelopes", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
		await expect(browserHistoryDataSource("token").readVisitSession({ runId: "run", branchId: "main", invokeSeqId: 9 })).rejects.toThrow(/History request failed/);
	});
});
