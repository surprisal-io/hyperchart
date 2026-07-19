import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { HyperchartInspectorDialog } from "../HyperchartInspectorDialog.js";
import { allRuns, runningRun } from "../fixtures/hyperchart-fixtures.js";
import { InteractiveInspector } from "./harnesses/InteractiveInspector.js";

const meta = {
	title: "Hyperchart/Components/Inspector Dialog",
	component: HyperchartInspectorDialog,
	parameters: {
		layout: "fullscreen",
		docs: {
			description: {
				component: "Editable inspector playground. Product states live under Features/Inspector Dialog.",
			},
		},
	},
	args: {
		runs: allRuns,
		selectedRunId: runningRun.runId,
		onSelectRun: fn(),
		onClose: fn(),
		onResume: fn(),
		onAbort: fn(),
	},
	argTypes: {
		runs: { control: "object", description: "Runs available in the top selector." },
		selectedRunId: { control: "text" },
		onSelectRun: { control: false },
		onClose: { control: false },
		onResume: { control: false },
		onAbort: { control: false },
		portal: { control: false },
		theme: { control: false },
	},
} satisfies Meta<typeof HyperchartInspectorDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
	render: (args) => <InteractiveInspector {...args} />,
	parameters: {
		docs: { description: { story: "Change the run collection and selected run through Controls." } },
	},
};
