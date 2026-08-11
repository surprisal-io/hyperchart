import { describe, expect, it } from "vitest";
import type { DurableLogRecord } from "../packages/hyperchart/src/core/durable_events.js";
import { semanticStatesForRecord } from "../packages/hyperchart/src/runtime/generic/rewind.js";

const stamp = (seqId: number) => ({ seqId, parentId: seqId === 1 ? null : seqId - 1, timestamp: seqId });

describe("rewind actor-pool state matching", () => {
	it("attributes accepted, replied, and settled facts to the concrete worker receive visit", () => {
		const records: DurableLogRecord[] = [
			{
				type: "actor_message",
				kind: "accepted",
				occurrence: "projects#a.@pool~2",
				messageId: "message-1",
				receiveState: "projects#a.@pool~2.$worker-1.alternateIdle",
				workerIndex: 1,
				...stamp(1),
			},
			{
				type: "actor_message",
				kind: "replied",
				occurrence: "projects#a.@pool~2",
				messageId: "message-1",
				message: "WORK",
				workerIndex: 1,
				...stamp(2),
			},
			{
				type: "actor_message",
				kind: "settled",
				occurrence: "projects#a.@pool~2",
				messageId: "message-1",
				workerIndex: 1,
				...stamp(3),
			},
		];

		for (const [index, record] of records.entries()) {
			expect(semanticStatesForRecord(record, records, index)).toEqual([
				"projects#a.@pool~2",
				"projects#a.@pool~2.$worker-1",
				"projects#a.@pool~2.$worker-1.alternateIdle",
			]);
		}
	});
});
