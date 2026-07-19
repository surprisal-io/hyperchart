import type { Meta, StoryObj } from "@storybook/react-vite";
import type { HyperchartRunInfo } from "../types.js";
import {
	fanoutVariantsRun,
	mapVariantsRun,
	richCardsRun,
	stateKindsRun,
	statusMatrixRun,
	transitionEdgeRun,
} from "../fixtures/hyperchart-board-fixtures.js";
import { BoardPage, GraphTile } from "./components/index.js";
import { singleStateRun } from "./components/singleStateRun.js";

const meta = {
	title: "Hyperchart/Visual Tests/Graph",
	parameters: {
		layout: "fullscreen",
		controls: { disable: true },
		docs: { description: { component: "Visual regression boards for graph cards and transition edges." } },
	},
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const CardAtlas: Story = {
	render: () => {
		const atlasSpecs = [
			...statusMatrixRun.states.map((state) => ({
				title: `status · ${state.status}`,
				run: singleStateRun(statusMatrixRun, state.id),
			})),
			...stateKindsRun.states.map((state) => ({
				title: `kind · ${state.type ?? "agent"}`,
				run: singleStateRun(stateKindsRun, state.id),
			})),
			...richCardsRun.states.map((state) => ({
				title: `rich · ${state.id}`,
				run: singleStateRun(richCardsRun, state.id),
			})),
			...mapVariantsRun.states.map((state) => ({
				title: `map · ${state.status}`,
				run: singleStateRun(mapVariantsRun, state.id),
			})),
			...fanoutVariantsRun.states.map((state) => ({
				title: `fanout · ${state.id}`,
				run: singleStateRun(fanoutVariantsRun, state.id),
			})),
		].filter((item): item is { title: string; run: HyperchartRunInfo } => item.run !== undefined);
		return (
			<BoardPage
				title="Card Atlas"
				description="Каждая существующая вариация карточки/ноды отдельно и крупно: статусы, реальные AST-типы, rich props, map, parallel."
			>
				<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
					{atlasSpecs.map(({ title, run }) => (
						<GraphTile key={run.runId} title={title} run={run} height="h-[300px]" />
					))}
				</div>
			</BoardPage>
		);
	},
	parameters: { docs: { description: { story: "Status, state-kind, rich-card, map, and fanout card coverage." } } },
};

export const EdgeTypes: Story = {
	render: () => (
		<BoardPage
			title="Edge types matrix"
			description="Все реальные типы связей: forward transitions, branch/fan-in, retry/back transition."
		>
			<div className="grid gap-4">
				<GraphTile
					title="Explicit transitions: branch, join, retry/back transition"
					run={transitionEdgeRun}
					height="h-[760px]"
				/>
			</div>
		</BoardPage>
	),
	parameters: { docs: { description: { story: "Forward, branch, fan-in, retry, and back-transition edges." } } },
};
