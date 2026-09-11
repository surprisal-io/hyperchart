import type { DurableLogRecord } from "../../core/durable_events.js";
import type { ChartAst } from "../../core/types.js";

/** Coordinates/session identities are capture context, not scripted scenario identity. */
export function storyCaptureIdentity(ast: ChartAst, schedule: readonly DurableLogRecord[]): string {
	return JSON.stringify({
		ast,
		schedule: schedule.map(
			({ seqId: _seqId, parentId: _parentId, branchId: _branchId, timestamp: _timestamp, ...record }) => {
				if (record.type === "state_action" && record.kind === "invoke") {
					const { sessionId: _sessionId, ...invoke } = record;
					return invoke;
				}
				return record;
			},
		),
	});
}

export function storyCaptureKey(ast: ChartAst, schedule: readonly DurableLogRecord[]): string {
	const identity = storyCaptureIdentity(ast, schedule);
	// A compact registry key; the generator independently detects collisions.
	let hash = 2166136261;
	for (let i = 0; i < identity.length; i++) {
		hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619);
	}
	return `${ast.id}:${(hash >>> 0).toString(16)}`;
}
