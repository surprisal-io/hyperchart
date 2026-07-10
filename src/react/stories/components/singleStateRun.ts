import type { HyperchartRunInfo } from "../../types.js";

export function singleStateRun(source: HyperchartRunInfo, stateId: string): HyperchartRunInfo | undefined {
	const selected = source.states.find((state) => state.id === stateId);
	if (!selected) return undefined;
	const { transitions: _transitions, ...standalone } = selected;
	return {
		...source,
		runId: `${source.runId}:${stateId}`,
		chartName: stateId,
		status: selected.status === "failed" ? "failed" : selected.status === "running" ? "running" : source.status,
		states: [standalone],
		stateCount: 1,
	};
}
