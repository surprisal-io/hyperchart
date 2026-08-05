import type { Meta, StoryObj } from "@storybook/react-vite";
import { ContentPreviewBoard } from "./components/index.js";

const meta = {
	title: "Hyperchart/Inspector/State Details/Content Preview",
	id: "hyperchart-visual-tests-content-preview",
	parameters: {
		layout: "fullscreen",
		controls: { disable: true },
		docs: { description: { component: "Visual matrix for inspector content-preview variants." } },
	},
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const ContentPreviewStates: Story = {
	render: () => <ContentPreviewBoard />,
	parameters: { docs: { description: { story: "All bounded and expanded content-preview states." } } },
};
