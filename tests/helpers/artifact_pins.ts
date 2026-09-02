import type { ArtifactPin, DurableLogRecord } from "../../packages/hyperchart/src/core/durable_events.js";

/** Test-only reconstruction for fixtures that deliberately start from durable facts. */
export function latestArtifactPins(records: readonly DurableLogRecord[]): ReadonlyMap<string, ArtifactPin> {
	const pins = new Map<string, ArtifactPin>();
	for (const record of records) {
		if (record.type !== "state_action" || record.kind !== "complete" || record.artifacts === undefined) continue;
		for (const [path, pin] of Object.entries(record.artifacts)) pins.set(path, pin);
	}
	return pins;
}
