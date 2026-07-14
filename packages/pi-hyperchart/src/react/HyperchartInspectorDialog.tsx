import { memo } from "react";
import { HyperchartInspectorDialogInner } from "./components/inspector/HyperchartInspectorDialogInner.js";
import type { HyperchartInspectorDialogProps } from "./components/inspector/dialog-props.js";
import { HyperchartPortalProvider } from "./support/HyperchartPortalProvider.js";
import { HyperchartUiThemeProvider } from "./support/HyperchartUiThemeProvider.js";

export type { HyperchartInspectorDialogProps } from "./components/inspector/dialog-props.js";

export { HyperchartInspectorSidePanel } from "./components/inspector/HyperchartInspectorSidePanel.js";
export type { HyperchartInspectorSidePanelProps } from "./components/inspector/HyperchartInspectorSidePanel.js";
export { HyperchartGraphPreview } from "./components/inspector/graph/HyperchartGraphPreview.js";
export { buildGraph } from "./components/inspector/graph/graphModel.js";
export { immediateMapScopeId, visibleStateIdsForScope } from "./components/inspector/helpers/scope.js";

const MemoizedHyperchartInspectorDialog = memo(function MemoizedHyperchartInspectorDialog(
	props: HyperchartInspectorDialogProps,
) {
	const { portal, theme, ...inner } = props;
	return (
		<HyperchartPortalProvider portal={portal}>
			<HyperchartUiThemeProvider theme={theme}>
				<HyperchartInspectorDialogInner {...inner} />
			</HyperchartUiThemeProvider>
		</HyperchartPortalProvider>
	);
});

export function HyperchartInspectorDialog(props: HyperchartInspectorDialogProps) {
	return <MemoizedHyperchartInspectorDialog {...props} />;
}
