import type { DurableLogRecord } from "../core/durable_events.js";
import type { MachineState } from "../core/machine.js";
import { nodeAt } from "../core/paths.js";
import { createBranchProjection, projectBranch } from "../core/projection.js";

export type RunTerminalState = "complete" | "failed";

/** Terminal outcome is explicit chart data. Names and the event that entered a terminal are irrelevant. */
export function terminalStateForFinalMachine(state: MachineState): RunTerminalState {
	if (state.projection.failure !== undefined) return "failed";
	return state.projection.activeLeaves.some((leaf) => {
		const node = nodeAt(state.ast, leaf);
		return node?.kind === "final" && node.outcome === "failed";
	}) ? "failed" : "complete";
}

export function createFailureProvenanceTracker(state: MachineState): {
	push(records: readonly DurableLogRecord[]): void;
	message(): string | undefined;
} {
	const failedLeaves = state.projection.activeLeaves.filter((leaf) => {
		const node = nodeAt(state.ast, leaf);
		return node?.kind === "final" && node.outcome === "failed";
	});
	const projection = createBranchProjection(state.ast);
	const enteredBy = new Map<string, Extract<DurableLogRecord, { type: "state_action"; kind: "complete" }>>();
	return {
		push(records) {
			for (const record of records) {
				const before = new Set(projection.activeLeaves);
				projectBranch(projection, state.ast, [record]);
				for (const leaf of projection.activeLeaves) {
					if (before.has(leaf)) continue;
					const node = nodeAt(state.ast, leaf);
					if (node?.kind !== "final" || node.outcome !== "failed") continue;
					if (record.type === "state_action" && record.kind === "complete" && record.event.type === "FAILED") enteredBy.set(leaf, record);
					else enteredBy.delete(leaf);
				}
			}
		},
		message() {
			if (state.projection.failure !== undefined) return describeEventError(state.projection.failure.error);
			if (failedLeaves.length === 0) return undefined;
			let latest: Extract<DurableLogRecord, { type: "state_action"; kind: "complete" }> | undefined;
			for (const leaf of failedLeaves) {
				const candidate = enteredBy.get(leaf);
				if (candidate !== undefined && (latest === undefined || candidate.seqId > latest.seqId)) latest = candidate;
			}
			if (latest !== undefined && "error" in latest.event && latest.event.error !== undefined) return describeEventError(latest.event.error);
			return `chart reached failed terminal state '${failedLeaves[0]}'`;
		},
	};
}

export function finalMachineFailureMessage(state: MachineState, log: readonly DurableLogRecord[]): string | undefined {
	const tracker = createFailureProvenanceTracker(state);
	tracker.push(log);
	return tracker.message();
}

function describeEventError(error: unknown): string {
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error) ?? String(error);
	} catch {
		return String(error);
	}
}
