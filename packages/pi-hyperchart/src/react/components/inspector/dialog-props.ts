import type { HyperchartPortalRenderer, HyperchartRunInfo, HyperchartUiTheme } from "../../types.js";

export interface HyperchartInspectorDialogProps {
	runs: HyperchartRunInfo[];
	selectedRunId?: string | null;
	onSelectRun?: (runId: string | null) => void;
	onClose: () => void;
	onResume?: (runId: string) => void;
	onAbort?: () => void;
	onSteerSession?: (runId: string, actionKey: string, message: string) => void | Promise<void>;
	portal?: HyperchartPortalRenderer;
	theme?: HyperchartUiTheme;
}
