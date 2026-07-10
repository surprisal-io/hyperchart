import type { HyperchartRunInfo } from "../../types.js";

export function runSortTime(run: HyperchartRunInfo): number {
	return run.updatedAt ?? run.createdAt ?? 0;
}
