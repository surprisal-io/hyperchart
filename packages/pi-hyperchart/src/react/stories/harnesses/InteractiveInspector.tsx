import { useEffect, useState } from "react";
import {
	HyperchartInspectorDialog,
	type HyperchartInspectorDialogProps,
} from "../../HyperchartInspectorDialog.js";

/** Keeps Storybook's inspector example interactive while forwarding actions to the Actions panel. */
export function InteractiveInspector(props: HyperchartInspectorDialogProps) {
	const [selectedRunId, setSelectedRunId] = useState<string | null>(props.selectedRunId ?? null);

	useEffect(() => {
		setSelectedRunId(props.selectedRunId ?? null);
	}, [props.selectedRunId]);

	return (
		<HyperchartInspectorDialog
			{...props}
			selectedRunId={selectedRunId}
			onSelectRun={(runId) => {
				setSelectedRunId(runId);
				props.onSelectRun?.(runId);
			}}
		/>
	);
}
