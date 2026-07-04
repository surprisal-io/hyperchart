import type { DurableLogRecord } from "../../core/durable_events.js";
import type { MachineState } from "../../core/machine.js";
import { nodeAt } from "../../core/paths.js";

export type RunTerminalState = "complete" | "failed";

export function terminalStateForFinalMachine(state: MachineState, log: readonly DurableLogRecord[]): RunTerminalState {
	if (state.projection.activeLeaves.some((leaf) => isFailureFinalLeaf(state, leaf))) return "failed";
	return latestCompletionEvent(log)?.type === "FAILED" ? "failed" : "complete";
}

export function finalMachineFailureMessage(state: MachineState, log: readonly DurableLogRecord[]): string | undefined {
	const failed = latestFailedCompletion(log);
	if (failed !== undefined && "error" in failed.event && failed.event.error !== undefined) {
		return describeEventError(failed.event.error);
	}
	const failedLeaf = state.projection.activeLeaves.find((leaf) => isFailureFinalLeaf(state, leaf));
	return failedLeaf === undefined ? undefined : `chart reached failed final state '${failedLeaf}'`;
}

export function isFailureStatePath(path: string): boolean {
	const segment = path.split(".").at(-1) ?? path;
	const templateSegment = segment.split("#")[0] ?? segment;
	return ["failed", "failure", "error"].includes(templateSegment.toLowerCase());
}

function isFailureFinalLeaf(state: MachineState, leaf: string): boolean {
	const node = nodeAt(state.ast, leaf);
	return node?.kind === "final" && (node.id.toLowerCase() === "failed" || isFailureStatePath(leaf));
}

function describeEventError(error: unknown): string {
	// Chart FAILED events may carry structured JSON errors; keep that payload visible in
	// status/TUI output instead of collapsing plain objects to "[object Object]".
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error) ?? String(error);
	} catch {
		return String(error);
	}
}

function latestCompletionEvent(log: readonly DurableLogRecord[]) {
	for (let index = log.length - 1; index >= 0; index--) {
		const record = log[index];
		if (record?.type === "state_action" && record.kind === "complete") return record.event;
	}
	return undefined;
}

function latestFailedCompletion(log: readonly DurableLogRecord[]) {
	for (let index = log.length - 1; index >= 0; index--) {
		const record = log[index];
		if (record?.type === "state_action" && record.kind === "complete" && record.event.type === "FAILED") return record;
	}
	return undefined;
}
