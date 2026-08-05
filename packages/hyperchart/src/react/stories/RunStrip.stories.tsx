import type { Meta, StoryObj } from "@storybook/react-vite";
import { RunStripBoardInner } from "./components/index.js";

const meta = {
	title: "Hyperchart/Inspector/Run Strip",
	id: "hyperchart-visual-tests-run-strip",
	parameters: {
		layout: "fullscreen",
		controls: { disable: true },
		docs: { description: { component: "Visual matrix for run-strip statuses and chart entries." } },
	},
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const RunStripStates: Story = {
	render: () => <RunStripBoardInner />,
	parameters: { docs: { description: { story: "All run-strip fixture states in one stable board." } } },
};
