import captured from "./captured-story-records.json" with { type: "json" };
import type { DurableLogRecord } from "../../core/durable_events.js";
import type { ChartAst } from "../../core/types.js";
import { storyCaptureKey } from "./story-capture-key.js";

/** Offline execution-loop output, never a rewritten or replay-fabricated log. */
export function capturedStorySchedule(ast: ChartAst, schedule: readonly DurableLogRecord[]): DurableLogRecord[] {
	return capturedStoryRecords(storyCaptureKey(ast, schedule));
}

export function capturedStoryRecords(name: string): DurableLogRecord[] {
	const records = (captured.snapshots as unknown as Record<string, DurableLogRecord[]>)[name];
	if (records === undefined) throw new Error(`Missing captured story ${name}; run node scripts/record-story-fixtures.mjs --write`);
	return records;
}
