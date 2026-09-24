import type { Meta, StoryObj } from "@storybook/react-vite";
import type { HyperchartStateType } from "../types.js";
import { TypeBoard } from "./card-atlas/TypeBoard.js";

const meta = {
	title: "Hyperchart/Inspector/Graph/Card Atlas/Flow",
	id: "hyperchart-inspector-graph-atlas-flow",
	parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj;
function card(kind: HyperchartStateType): Story {
	return { render: () => <TypeBoard kind={kind} /> };
}
const mapStory = card("map");
export { mapStory as Map };
export const Parallel = card("parallel");
export const Compound = card("compound");
export const Region = card("region");
export const Final = card("final");
