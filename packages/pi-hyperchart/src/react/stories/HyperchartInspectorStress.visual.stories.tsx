import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { HyperchartInspectorDialog } from "../HyperchartInspectorDialog.js";
import { allBoardRuns, stressRun } from "../fixtures/hyperchart-board-fixtures.js";
import { BoardPage, BoardSection } from "./components/index.js";
import { InteractiveInspector } from "./harnesses/InteractiveInspector.js";

const meta = {
	title: "Hyperchart/Visual Tests/Inspector Stress",
	component: HyperchartInspectorDialog,
	parameters: {
		layout: "fullscreen",
		controls: { disable: true },
		docs: { description: { component: "Large inspector regression board using every graph fixture run." } },
	},
} satisfies Meta<typeof HyperchartInspectorDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FullStressBoard: Story = {
	args: {
		runs: allBoardRuns,
		selectedRunId: stressRun.runId,
		onSelectRun: fn(),
		onClose: fn(),
		onResume: fn(),
		onAbort: fn(),
	},
	render: (args) => (
		<BoardPage
			title="Full stress inspector"
			description="Один большой стенд inspector со всеми fixture runs в селекторе. Run strip и launch dialog проверяются отдельными stories."
		>
			<BoardSection title="Full inspector stress graph">
				<div className="h-[900px] overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)]">
					<InteractiveInspector {...args} />
				</div>
			</BoardSection>
		</BoardPage>
	),
	parameters: { docs: { description: { story: "All board runs in one controlled inspector selector." } } },
};
