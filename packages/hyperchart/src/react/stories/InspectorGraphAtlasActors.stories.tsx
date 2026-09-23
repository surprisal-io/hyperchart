import type { Meta, StoryObj } from "@storybook/react-vite";
import type { HyperchartStateType } from "../types.js";
import { TypeBoard } from "./card-atlas/TypeBoard.js";

const meta = {
	title: "Hyperchart/Inspector/Graph/Card Atlas/Actors",
	id: "hyperchart-inspector-graph-atlas-actors",
	parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj;
function card(kind: HyperchartStateType): Story {
	return { render: () => <TypeBoard kind={kind} /> };
}
export const ActorDeclaration = card("actor-declaration");
export const ActorOccurrence = card("actor-occurrence");
export const Send = card("send");
export const SendBatch = card("sendBatch");
export const Call = card("call");
export const CallBatch = card("callBatch");
export const Receive = card("receive");
export const Reply = card("reply");
export const Notify = card("notify");
export const WaitFor = card("waitFor");
