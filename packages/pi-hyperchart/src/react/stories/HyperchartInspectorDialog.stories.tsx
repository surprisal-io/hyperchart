import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { HyperchartInspectorDialog } from "../HyperchartInspectorDialog.js";
import { allRuns, failedRun, inspectRun, runningRun } from "../fixtures/hyperchart-fixtures.js";

const meta = {
	title: "Hyperchart/Inspector Dialog",
	component: HyperchartInspectorDialog,
	parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const Running: Story = {
	render: () => {
		const [selectedRunId, setSelectedRunId] = useState<string | null>(runningRun.runId);
		return (
			<HyperchartInspectorDialog
				runs={allRuns}
				selectedRunId={selectedRunId}
				onSelectRun={setSelectedRunId}
				onClose={() => undefined}
				onResume={() => undefined}
				onAbort={() => undefined}
			/>
		);
	},
};

export const StaticInspect: Story = {
	render: () => (
		<HyperchartInspectorDialog runs={[inspectRun]} selectedRunId={inspectRun.runId} onClose={() => undefined} />
	),
};

export const FailedValidation: Story = {
	render: () => (
		<HyperchartInspectorDialog
			runs={[failedRun]}
			selectedRunId={failedRun.runId}
			onClose={() => undefined}
			onResume={() => undefined}
		/>
	),
};
