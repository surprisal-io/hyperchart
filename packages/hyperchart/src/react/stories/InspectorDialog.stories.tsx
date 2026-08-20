import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { HyperchartInspectorDialog } from "../HyperchartInspectorDialog.js";
import { allRuns, failedRun, inspectRun, runningRun } from "../fixtures/hyperchart-fixtures.js";
import { InteractiveInspector } from "./harnesses/InteractiveInspector.js";

const meta = {
	title: "Hyperchart/Inspector/Dialog",
	id: "hyperchart-features-inspector-dialog",
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
	name: "Active Run · Multi-run Selection",
	args: {
		onSelectRun: fn(),
		onResume: fn(),
		onAbort: fn(),
	},
	render: (args) => <InteractiveInspector {...args} />,
	parameters: {
		docs: { description: { story: "Live runtime inspector with controlled selection between durable runs and explicit repository versus branch-workspace metadata." } },
	},
	play: async ({ canvasElement, args }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		await userEvent.click(canvas.getByRole("button", { name: /deck-director · failed/i }));
		await expect(args.onSelectRun).toHaveBeenCalledWith(failedRun.runId);
		const resume = await canvas.findByRole("button", { name: "Resume" });
		await userEvent.click(resume);
		await expect(args.onResume).toHaveBeenCalledWith(failedRun.runId);
		await userEvent.click(canvas.getByRole("button", { name: /deck-director · running/i }));
		await expect(args.onSelectRun).toHaveBeenLastCalledWith(runningRun.runId);
	},
};

export const StaticInspect: Story = {
	name: "Static Chart · Read Only",
	args: {
		runs: [inspectRun],
		selectedRunId: inspectRun.runId,
	},
	parameters: {
		docs: { description: { story: "Read-only inspection with explicit return from state details to the chart overview." } },
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		await expect(canvas.getByText("Static graph")).toBeVisible();
		await userEvent.click(await canvas.findByText("research-plan"));
		const overviewButton = await canvas.findByRole("button", { name: "Chart overview" });
		await expect(overviewButton).toBeVisible();
		await userEvent.click(overviewButton);
		await expect(canvas.getByText("Static graph")).toBeVisible();
	},
};

export const FailedValidation: Story = {
	name: "Failed Run · Resumable",
	args: {
		runs: [failedRun],
		selectedRunId: failedRun.runId,
		onResume: fn(),
	},
	parameters: {
		docs: { description: { story: "A failed durable run opened directly in its resumable state." } },
	},
};
