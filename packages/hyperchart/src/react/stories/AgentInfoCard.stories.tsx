import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { AgentInfoCard } from "../components/inspector/details/AgentInfoCard.js";
import type { HyperchartStateInfo } from "../types.js";

const state: HyperchartStateInfo = {
	id: "research-planner",
	type: "agent",
	status: "running",
	agent: "report-engine-research-scout",
	agentDescription: "Fast structured web research worker for Report Engine Hypercharts. Handles initial-angle scans, evidence collection, and source synthesis.",
	model: "openai-codex/gpt-5.6-luna",
	thinking: "xhigh",
	tools: ["read", "write"],
	reads: ["research.assemble-evidence", "plan.narrative-strategy"],
	artifacts: [{ name: "research-brief" }],
	replySchema: { schema: { type: "object" } },
	session: {
		actionKey: "report-engine:research-planner:agent",
		status: "running",
		turnCount: 3,
		toolCount: 5,
	},
};

const meta = {
	title: "Hyperchart/Components/Agent Info Card",
	component: AgentInfoCard,
	parameters: {
		layout: "centered",
		docs: {
			description: {
				component: "Agent metadata card with a stable, non-overlapping live-session action.",
			},
		},
	},
	args: {
		state,
		allStates: [state],
		onSteerSession: fn(),
	},
	decorators: [
		(Story) => (
			<div className="w-[390px] max-w-[calc(100vw-2rem)]">
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof AgentInfoCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LongMetadata: Story = {};
