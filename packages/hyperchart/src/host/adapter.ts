import type {
	BranchListChunk,
	BranchListCursor,
	HistoryChunk,
	HistoryCursor,
	HistorySnapshot,
	HistorySubject,
} from "../runtime/generic/log_store.js";
import type {
	HyperchartActorGenerationInfo,
	HyperchartActorMessageBatchInfo,
	HyperchartAgentSessionInfo,
	HyperchartInfo,
	HyperchartMapVisitInfo,
	HyperchartRecordInfo,
	HyperchartRunOverview,
	HyperchartRunStatus,
	HyperchartUsageInfo,
	HyperchartVisitInfo,
} from "./models.js";

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
	branchId?: string;
	runnerBranchIds?: string[];
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

/** Stateless, serializable inspector detail API. It never returns durable storage handles. */
export interface HyperchartInspectorDataSource {
	listBranches(input: { runId: string; cursor?: BranchListCursor }): Promise<BranchListChunk>;
	readStateVisits(input: { runId: string; snapshot: HistorySnapshot; stateId: string; cursor?: HistoryCursor }): Promise<HistoryChunk<HyperchartVisitInfo>>;
	readMapVisits(input: { runId: string; snapshot: HistorySnapshot; mapPath: string; cursor?: HistoryCursor }): Promise<HistoryChunk<HyperchartMapVisitInfo>>;
	readActorGenerations(input: { runId: string; snapshot: HistorySnapshot; logicalOccurrence: string; cursor?: HistoryCursor }): Promise<HistoryChunk<HyperchartActorGenerationInfo>>;
	readActorMessages(input: { runId: string; snapshot: HistorySnapshot; occurrence: string; cursor?: HistoryCursor }): Promise<HistoryChunk<HyperchartActorMessageBatchInfo>>;
	readRecords(input: { runId: string; snapshot: HistorySnapshot; cursor?: HistoryCursor }): Promise<HistoryChunk<HyperchartRecordInfo>>;
	cursorAt(input: { runId: string; snapshot: HistorySnapshot; subject: HistorySubject; seqId: number }): Promise<HistoryCursor | undefined>;
	readVisitSession(input: { runId: string; branchId: string; invokeSeqId: number }): Promise<HyperchartAgentSessionInfo | undefined>;
}

export interface HyperchartHostAdapter extends HyperchartInspectorDataSource {
	readSessionSnapshot(cwd: string, options?: HyperchartSnapshotOptions): Promise<HyperchartSessionSnapshot>;
	/** Load one full chart definition for an on-demand definition or launch dialog. */
	readChartSnapshot(cwd: string, chartName: string): Promise<HyperchartInfo | undefined>;
	/** Load graph/control state plus bounded summaries; elapsed histories are intentionally absent. */
	readRunOverview(cwd: string, runId: string, branchId?: string): Promise<HyperchartRunOverview | undefined>;
}
