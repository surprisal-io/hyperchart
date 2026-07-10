import type { HyperchartPortalRenderer, HyperchartRunInfo, HyperchartUiTheme } from "../../types.js";

export interface HyperchartInspectorDialogProps {
	runs: HyperchartRunInfo[];
	selectedRunId?: string | null;
	onSelectRun?: (runId: string | null) => void;
	onClose: () => void;
	onResume?: (runId: string) => void;
	onAbort?: () => void;
	portal?: HyperchartPortalRenderer;
	theme?: HyperchartUiTheme;
}
