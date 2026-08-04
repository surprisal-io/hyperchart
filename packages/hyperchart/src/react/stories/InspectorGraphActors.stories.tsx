import type { Meta, StoryObj } from "@storybook/react-vite";
import { actorBusyFifoRun, actorDrainingRun, actorReentryRun } from "../fixtures/actor-fixtures.js";
import { visibleStateIdsForScope } from "../components/inspector/helpers/scope.js";
import { BoardPage, GraphTile } from "./components/index.js";

const drainingRootStateIds = [...visibleStateIdsForScope(actorDrainingRun.states)];

const meta = {
	title: "Hyperchart/Inspector/Graph/Actors",
	id: "hyperchart-visual-tests-explicit-actor-graph",
	parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj;

export const ActorNodesAndEdges: Story = {
	render: () => (
		<BoardPage title="Explicit actor graph" description="Only visually distinct graph states: a busy FIFO/call, generation re-entry, and SEND-only structured drain.">
			<div className="grid gap-4 xl:grid-cols-2">
				<GraphTile title="busy FIFO · blocked caller" run={actorBusyFifoRun} height="h-[520px]" />
				<GraphTile title="actor re-entry · generation 3" run={actorReentryRun} height="h-[520px]" />
				<GraphTile title="nested structured drain · SEND-only" run={actorDrainingRun} visibleStateIds={drainingRootStateIds} height="h-[480px]" />
			</div>
		</BoardPage>
	),
};
