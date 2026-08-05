import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentInfoCard } from "../components/inspector/details/AgentInfoCard.js";
import { inspectorPanelSpecs } from "./inspector-panel/specs.js";
import { inspectorPanelScenario } from "./inspector-panel/runtime.js";

const richAgentSpec = inspectorPanelSpecs.find((spec) => spec.group === "agent" && spec.title === "Rich agent");
const scenario = richAgentSpec === undefined ? undefined : inspectorPanelScenario(richAgentSpec);
const state = scenario?.run.states.find((candidate) => candidate.id === scenario.selectedStateId);
if (scenario === undefined || state === undefined) throw new Error("adapter-derived rich agent fixture is unavailable");

const meta = {
	title: "Hyperchart/Inspector/State Details/Agent Info",
	id: "hyperchart-components-agent-info-card",
	component: AgentInfoCard,
	parameters: { layout: "centered", docs: { description: { component: "Agent metadata projected from a normalized chart and durable session facts." } } },
	args: { state, allStates: scenario.run.states },
	decorators: [(Story) => <div className="w-[390px] max-w-[calc(100vw-2rem)]"><Story /></div>],
} satisfies Meta<typeof AgentInfoCard>;

export default meta;
type Story = StoryObj<typeof meta>;
export const ResolvedRoleAndToolset: Story = { name: "Authored model and toolset" };
