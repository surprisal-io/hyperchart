import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { HyperchartInspectorDialog } from "../HyperchartInspectorDialog.js";
import { allRuns, failedRun, inspectRun, runningRun } from "../fixtures/hyperchart-fixtures.js";
import { InteractiveInspector } from "./harnesses/InteractiveInspector.js";

const meta = {
	title: "Hyperchart/Features/Inspector Dialog",
	component: HyperchartInspectorDialog,
	parameters: {
		layout: "fullscreen",
		controls: { disable: true },
		docs: {
			description: {
				component: "Supported inspector states and controlled interaction scenarios.",
			},
		},
	},
	args: {
		runs: allRuns,
		selectedRunId: runningRun.runId,
		onClose: fn(),
	},
} satisfies Meta<typeof HyperchartInspectorDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {
	args: {
		onSelectRun: fn(),
		onResume: fn(),
		onAbort: fn(),
	},
	render: (args) => <InteractiveInspector {...args} />,
	parameters: {
		docs: { description: { story: "Running multi-run inspector with controlled run selection." } },
	},
	play: async ({ canvasElement, args }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		await userEvent.click(canvas.getByRole("button", { name: /deck-director · failed/i }));
		await expect(args.onSelectRun).toHaveBeenCalledWith(failedRun.runId);
		const resume = await canvas.findByRole("button", { name: "Resume" });
		await userEvent.click(resume);
		await expect(args.onResume).toHaveBeenCalledWith(failedRun.runId);
	},
};

export const StaticInspect: Story = {
	args: {
		runs: [inspectRun],
		selectedRunId: inspectRun.runId,
	},
	parameters: {
		docs: { description: { story: "Read-only inspection of a statically analyzed chart." } },
	},
};

export const FailedValidation: Story = {
	args: {
		runs: [failedRun],
		selectedRunId: failedRun.runId,
		onResume: fn(),
	},
	parameters: {
		docs: { description: { story: "Failed validation state with a resume action available." } },
	},
};
