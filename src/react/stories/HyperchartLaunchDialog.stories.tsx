import type { Meta, StoryObj } from "@storybook/react-vite";
import { HyperchartLaunchDialog } from "../HyperchartLaunchDialog.js";

const meta = {
	title: "Hyperchart/Launch Dialog",
	component: HyperchartLaunchDialog,
	parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const Basic: Story = {
	render: () => (
		<HyperchartLaunchDialog
			chartName="deck-director"
			description="Build an interactive narrative report from sourced evidence."
			args={{ topic: { default: "Google I/O 2026 announcements" }, audience: { default: "executives" } }}
			onSubmit={() => undefined}
			onCancel={() => undefined}
			onOpenGraph={() => undefined}
		/>
	),
};

export const FreeformInstruction: Story = {
	render: () => (
		<HyperchartLaunchDialog
			chartName="code-review-fix-cycle"
			description="Review, patch, and verify a code change."
			placeholder="Fix the flaky retry test and explain the root cause…"
			submitLabel="Start"
			onSubmit={() => undefined}
			onCancel={() => undefined}
		/>
	),
};
