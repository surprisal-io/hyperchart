import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo } from "react";
import type { HyperchartInspectResult } from "../../core/inspect.js";
import { hyperchartRunFromInspectResult } from "../adapters.js";
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

const meta = {
	title: "Hyperchart/Adapters",
	parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const InspectResultToGraph: Story = {
	render: () => {
		const run = useMemo(() => hyperchartRunFromInspectResult(inspectResult, { runId: "inspect:static-review" }), []);
		return (
			<div className="p-6">
				<HyperchartGraphPreview run={run} className="h-[520px]" />
			</div>
		);
	},
};
