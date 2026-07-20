import type { Meta, StoryObj } from "@storybook/react-vite";
import type { HyperchartInspectResult } from "../../core/inspect.js";
import { hyperchartRunFromInspectResult } from "../../host/index.js";
import { HyperchartGraphPreview } from "../HyperchartInspectorDialog.js";

const inspectResult: HyperchartInspectResult = {
	chartId: "static-review",
	mode: "static",
	states: [
		{
			id: "plan",
			kind: "agent",
			agent: "planner",
			task: "Plan the work from {arg.task}.",
			refs: [{ kind: "arg", name: "task", preview: "arg.task" }],
			transitions: [
				{ event: "PLAN_READY", target: "implement" },
				{ event: "FAILED", target: "failed" },
			],
		},
		{
			id: "implement",
			kind: "script",
			command: "npm test",
			env: [{ name: "CI", type: "string", value: "true" }],
			transitions: [
				{ event: "DONE", target: "review" },
				{ event: "FAILED", target: "failed" },
			],
		},
		{
			id: "review",
			kind: "agent",
			agent: "reviewer",
			reads: ["implement"],
			transitions: [
				{ event: "APPROVED", target: "done" },
				{ event: "CHANGES_REQUESTED", target: "implement" },
			],
		},
		{ id: "done", kind: "final" },
		{ id: "failed", kind: "final" },
	],
};

const inspectRun = hyperchartRunFromInspectResult(inspectResult, { runId: "inspect:static-review" });

const meta = {
	title: "Hyperchart/Examples/Adapters",
	component: HyperchartGraphPreview,
	parameters: {
		layout: "fullscreen",
		docs: {
			description: {
				component: "Visual checks for adapting core inspection data into React UI models.",
			},
		},
	},
	args: {
		run: inspectRun,
		className: "h-[520px]",
	},
	argTypes: {
		run: { control: false },
	},
} satisfies Meta<typeof HyperchartGraphPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InspectResultToGraph: Story = {
	render: (args) => (
		<div className="p-6">
			<HyperchartGraphPreview {...args} />
		</div>
	),
	parameters: {
		docs: { description: { story: "Static inspect output adapted into the graph preview model." } },
	},
};
