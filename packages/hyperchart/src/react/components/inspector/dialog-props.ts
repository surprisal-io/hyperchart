import type { HyperchartInspectorDataSource, HyperchartPortalRenderer, HyperchartRunInfo, HyperchartUiTheme } from "../../types.js";

export interface HyperchartInspectorDialogProps {
	runs: HyperchartRunInfo[];
	selectedRunId?: string | null;
	onSelectRun?: (runId: string | null) => void;
	/** Non-durable checkout; hosts reload the selected branch snapshot without writing log.jsonl. */
	onSelectBranch?: (runId: string, branchId: string) => void;
	/** Durable actions are separate and must be explicitly confirmed by the UI. */
	onForkBranch?: (runId: string, fromSeqId: number, branchId: string) => void | Promise<void>;
	onRewindBranch?: (runId: string, branchId: string, seqId: number) => void | Promise<void>;
	onClose: () => void;
	onResume?: (runId: string) => void;
	onAbort?: () => void;
	onSteerSession?: (runId: string, actionKey: string, message: string) => void | Promise<void>;
	/** Stateless lazy history source; omitted for definition-only/static inspectors. */
	historyDataSource?: HyperchartInspectorDataSource;
	onRefreshHistory?: (runId: string) => void | Promise<void>;
	/** Optional durable coordinate for a deep-linked Runtime subject. */
	historyTargetSeqId?: number;
	portal?: HyperchartPortalRenderer;
	theme?: HyperchartUiTheme;
}
