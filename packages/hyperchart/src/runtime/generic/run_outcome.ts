import type { DurableLogRecord } from "../../core/durable_events.js";
import type { MachineState } from "../../core/machine.js";
import { nodeAt } from "../../core/paths.js";
import { createBranchProjection, projectBranch } from "../../core/projection.js";

export type RunTerminalState = "complete" | "failed";

/** Terminal outcome is explicit chart data. Names and the event that entered a terminal are irrelevant. */
export function terminalStateForFinalMachine(state: MachineState): RunTerminalState {
	if (state.projection.failure !== undefined) return "failed";
	return state.projection.activeLeaves.some((leaf) => {
		const node = nodeAt(state.ast, leaf);
		return node?.kind === "final" && node.outcome === "failed";
	}) ? "failed" : "complete";
}

export function finalMachineFailureMessage(state: MachineState, log: readonly DurableLogRecord[]): string | undefined {
	if (state.projection.failure !== undefined) return describeEventError(state.projection.failure.error);
	const failedLeaves = state.projection.activeLeaves.filter((leaf) => {
		const node = nodeAt(state.ast, leaf);
		return node?.kind === "final" && node.outcome === "failed";
	});
	if (failedLeaves.length === 0) return undefined;
	const failed = failedCompletionEnteringActiveTerminal(state, log, new Set(failedLeaves));
	if (failed !== undefined && "error" in failed.event && failed.event.error !== undefined) {
		return describeEventError(failed.event.error);
	}
	return `chart reached failed terminal state '${failedLeaves[0]}'`;
}

/**
 * Associate an error only with the FAILED fact that actually entered the final
 * failed leaf. An older recovered failure may remain in the log after the chart
 * routes through recovery and later reaches a different failed terminal.
 */
function failedCompletionEnteringActiveTerminal(
	state: MachineState,
	log: readonly DurableLogRecord[],
	activeFailedLeaves: ReadonlySet<string>,
) {
	const projection = createBranchProjection(state.ast);
	const enteredBy = new Map<string, Extract<DurableLogRecord, { type: "state_action"; kind: "complete" }>>();
	for (const record of log) {
		const before = new Set(projection.activeLeaves);
		projectBranch(projection, state.ast, [record]);
		for (const leaf of projection.activeLeaves) {
			if (before.has(leaf)) continue;
			const node = nodeAt(state.ast, leaf);
			if (node?.kind !== "final" || node.outcome !== "failed") continue;
			if (record.type === "state_action" && record.kind === "complete" && record.event.type === "FAILED") {
				enteredBy.set(leaf, record);
			} else {
				enteredBy.delete(leaf);
			}
		}
	}
	let latest: Extract<DurableLogRecord, { type: "state_action"; kind: "complete" }> | undefined;
	for (const leaf of activeFailedLeaves) {
		const candidate = enteredBy.get(leaf);
		if (candidate !== undefined && (latest === undefined || candidate.seqId > latest.seqId)) latest = candidate;
	}
	return latest;
}

function describeEventError(error: unknown): string {
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error) ?? String(error);
	} catch {
		return String(error);
	}
}
