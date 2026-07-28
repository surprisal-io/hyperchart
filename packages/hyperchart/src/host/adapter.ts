import type { HyperchartInfo, HyperchartRunInfo, HyperchartRunStatus, HyperchartUsageInfo } from "./models.js";

/** Definition metadata safe to retain in a host/dashboard session. */
export interface HyperchartSummaryInfo {
	name: string;
	description: string;
	scope: "user" | "project";
	source?: string;
	/** Present only when discovery can count literal states without evaluating the chart module. */
	stateCount?: number;
	updatedAt?: number;
}

/** Scalar run/status/progress metadata safe to retain in a host/dashboard session. */
export interface HyperchartRunSummaryInfo {
	runId: string;
	chartName: string;
	originSessionId?: string;
	status: HyperchartRunStatus;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	pid?: number;
	detached?: boolean;
	/** Graph-derived fields are absent when the host would need to evaluate a chart module to compute them. */
	stateCount?: number;
	progressDone?: number;
	progressTotal?: number;
	progressPercent?: number;
	activeState?: string;
	activeStateCount?: number;
	totalUsage?: HyperchartUsageInfo;
}

/** Lightweight list payload; never contains chart graphs, state snapshots, or transcripts. */
export interface HyperchartSessionSnapshot {
	hypercharts: HyperchartSummaryInfo[];
	runs: HyperchartRunSummaryInfo[];
}

export interface HyperchartSnapshotOptions {
	runLimit?: number;
}

export interface HyperchartHostAdapter {
	readSessionSnapshot(cwd: string, options?: HyperchartSnapshotOptions): Promise<HyperchartSessionSnapshot>;
	/** Load one full chart definition for an on-demand definition or launch dialog. */
	readChartSnapshot(cwd: string, chartName: string): Promise<HyperchartInfo | undefined>;
	/** Load a full run model, including transcripts, for an open inspector only. */
	readRunSnapshot(cwd: string, runId: string): Promise<HyperchartRunInfo | undefined>;
}
