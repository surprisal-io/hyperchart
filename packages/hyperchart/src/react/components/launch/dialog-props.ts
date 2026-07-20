import type { HyperchartPortalRenderer } from "../../types.js";

export interface HyperchartLaunchDialogProps {
	chartName: string;
	description?: string;
	args?: Record<string, unknown>;
	submitLabel?: string;
	placeholder?: string;
	onSubmit: (argsText: string) => void;
	onCancel: () => void;
	onOpenGraph?: () => void;
	portal?: HyperchartPortalRenderer;
}
