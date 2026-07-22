import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentInfoCard } from "../components/inspector/details/AgentInfoCard.js";
import type { HyperchartStateInfo } from "../types.js";

const state: HyperchartStateInfo = {
	id: "research-planner",
	type: "agent",
	status: "running",
	agent: "report-engine-research-scout",
	agentDescription: "Fast structured web research worker for Report Engine Hypercharts. Handles initial-angle scans, evidence collection, and source synthesis.",
	role: "worker",
	model: "openai-codex/gpt-5.6-sol",
	resolvedModel: "deepseek/deepseek-v4-pro",
	thinking: "xhigh",
	toolset: "researching",
	tools: ["read"],
	resolvedTools: ["read", "write", "web_search", "web_search_brave", "browser", "finish"],
	reads: ["research.assemble-evidence", "plan.narrative-strategy"],
	artifacts: [{ name: "research-brief" }],
	replySchema: { schema: { type: "object" } },
};

const meta = {
	title: "Hyperchart/Components/Agent Info Card",
	component: AgentInfoCard,
	parameters: {
		layout: "centered",
		docs: {
			description: {
				component: "Static agent metadata card. Run-specific session controls live in the inspector Runtime section.",
			},
		},
	},
	args: {
		state,
		allStates: [state],
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

export const ResolvedRoleAndToolset: Story = {};
