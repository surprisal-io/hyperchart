import type { Meta, StoryObj } from "@storybook/react-vite";
import { agent, chart, final, script } from "../../core/dsl.js";
import { storyScenario } from "../fixtures/story-scenario.js";
import { actorNamedReplyRun, actorPoolCrowdedRun, actorSendVoidRun } from "../fixtures/actor-fixtures.js";
import { actorStaticAdapterRun } from "../fixtures/actor-runtime-fixtures.js";
import { BoardPage, BoardSection, GraphTile } from "./components/index.js";
import { inspectorPanelSpecs } from "./inspector-panel/specs.js";
import { inspectorPanelScenario } from "./inspector-panel/runtime.js";

const edgeScenario = storyScenario(chart({
	kind: "chart",
	id: "storybook-edge-types",
	initial: "start",
	states: {
		start: { kind: "state", action: agent("router"), transitions: { A: "branch-a", B: "branch-b" } },
		"branch-a": { kind: "state", action: agent("left"), transitions: { JOIN: "join" } },
		"branch-b": { kind: "state", action: script("npm", ["test"]), transitions: { JOIN: "join" } },
		join: { kind: "state", action: agent("reviewer"), transitions: { RETRY_BACK: "branch-a", DONE: "done" } },
		done: final(),
	},
}));
const transitionEdgeRun = edgeScenario.staticRun({ runId: "inspect:storybook-edge-types", cwd: "/workspace", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 });

const meta = {
	title: "Hyperchart/Inspector/Graph",
	id: "hyperchart-visual-tests-graph",
	parameters: {
		layout: "fullscreen",
		controls: { disable: true },
		docs: { description: { component: "Adapter-derived coverage boards for graph cards and transition edges." } },
	},
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const CardAtlas: Story = {
	render: () => {
		const atlasGroups = new Map<string, Array<{ title: string; run: NonNullable<ReturnType<typeof inspectorPanelScenario>>["run"]; stateId: string }>>();
		for (const spec of inspectorPanelSpecs) {
			if (spec.graphAtlas === false) continue;
			const scenario = inspectorPanelScenario(spec);
			if (scenario === undefined || scenario.selectedStateId === null) continue;
			const group = atlasGroups.get(spec.group) ?? [];
			group.push({ title: spec.title, run: scenario.run, stateId: scenario.selectedStateId });
			atlasGroups.set(spec.group, group);
		}
		return (
			<BoardPage
				title="Card Atlas"
				description="Только визуально различимые graph nodes из нормализованного chart definition и replay-valid durable facts."
			>
				{Array.from(atlasGroups, ([group, cards]) => (
					<BoardSection key={group} title={`${group[0]?.toUpperCase() ?? ""}${group.slice(1)}`}>
						<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
							{cards.map(({ title, run, stateId }) => (
								<GraphTile key={`${run.runId}:${stateId}`} title={title} run={run} visibleStateIds={[stateId]} height="h-[300px]" />
							))}
						</div>
					</BoardSection>
				))}
			</BoardPage>
		);
	},
	parameters: { docs: { description: { story: "Focused adapter-derived nodes without cloned or mutated run models." } } },
};

export const EdgeTypes: Story = {
	render: () => (
		<BoardPage title="Edge types matrix" description="Каждый тип связи показан отдельно, без наложения независимых actor-сценариев.">
			<div className="grid gap-4">
				<GraphTile title="Branch, fan-in, retry/back transition" run={transitionEdgeRun} height="h-[760px]" />
				<GraphTile title="Actor send · fire-and-forget" run={actorSendVoidRun} height="h-[500px]" />
				<GraphTile title="Actor sendBatch · ordered fire-and-forget messages" run={actorStaticAdapterRun} visibleStateIds={["queue", "@editor"]} height="h-[500px]" />
				<GraphTile title="Actor call · request and reply" run={actorNamedReplyRun} height="h-[500px]" />
				<GraphTile title="Actor callBatch · pooled requests and replies" run={actorPoolCrowdedRun} visibleStateIds={["batch", "@workers"]} height="h-[500px]" />
			</div>
		</BoardPage>
	),
};
