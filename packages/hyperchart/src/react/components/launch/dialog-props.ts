import type { HyperchartLaunchArgumentInfo } from "../../../host/models.js";
import type { HyperchartPortalRenderer } from "../../types.js";

export interface HyperchartLaunchDialogProps {
	chartName: string;
	description?: string;
	args?: Readonly<Record<string, HyperchartLaunchArgumentInfo>>;
	submitLabel?: string;
	placeholder?: string;
	onSubmit: (argsText: string) => void;
	onCancel: () => void;
	onOpenGraph?: () => void;
	portal?: HyperchartPortalRenderer;
}
