import type { HyperchartInfo, HyperchartRunInfo } from "./models.js";

export interface HyperchartSessionSnapshot {
	hypercharts: HyperchartInfo[];
	runs: HyperchartRunInfo[];
}

export interface HyperchartSnapshotOptions {
	runLimit?: number;
}

export interface HyperchartHostAdapter {
	readSessionSnapshot(cwd: string, options?: HyperchartSnapshotOptions): Promise<HyperchartSessionSnapshot>;
}
