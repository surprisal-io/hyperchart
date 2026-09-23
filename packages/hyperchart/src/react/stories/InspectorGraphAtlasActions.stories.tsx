import type { Meta, StoryObj } from "@storybook/react-vite";
import type { HyperchartStateType } from "../types.js";
import { TypeBoard } from "./card-atlas/TypeBoard.js";

const meta = {
	title: "Hyperchart/Inspector/Graph/Card Atlas/Actions",
	id: "hyperchart-inspector-graph-atlas-actions",
	parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj;
function card(kind: HyperchartStateType): Story {
	return { render: () => <TypeBoard kind={kind} /> };
}
export const Agent = card("agent");
export const User = card("user");
export const Gate = card("gate");
export const Script = card("script");
export const FunctionAction = card("tsImport");
