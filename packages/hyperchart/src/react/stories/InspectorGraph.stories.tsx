import type { Meta, StoryObj } from "@storybook/react-vite";
import { agent, chart, final, script } from "../../core/dsl.js";
import { storyScenario } from "../fixtures/story-scenario.js";
import { actorNamedReplyRun, actorPoolCrowdedRun, actorSendVoidRun } from "../fixtures/actor-fixtures.js";
import { actorStaticAdapterRun } from "../fixtures/actor-runtime-fixtures.js";
import { completionScenario } from "../fixtures/completion-fixture.js";
import { BoardPage, GraphTile } from "./components/index.js";

const edgeScenario = storyScenario(
	chart({
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
	}),
);
const transitionEdgeRun = edgeScenario.staticRun({
	runId: "inspect:storybook-edge-types",
	cwd: "/workspace",
	createdAt: 1_700_000_000_000,
	updatedAt: 1_700_000_000_000,
});

const meta = {
	title: "Hyperchart/Inspector/Graph",
	id: "hyperchart-visual-tests-graph",
	parameters: {
		layout: "fullscreen",
		controls: { disable: true },
		docs: { description: { component: "Adapter-derived transition-edge coverage board." } },
	},
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const EdgeTypes: Story = {
	render: () => (
		<BoardPage
			title="Edge types matrix"
			description="Каждый тип связи показан отдельно, без наложения независимых actor-сценариев."
		>
			<div className="grid gap-4">
				<GraphTile title="Branch, fan-in, retry/back transition" run={transitionEdgeRun} height="h-[760px]" />
				<GraphTile title="Actor send · fire-and-forget" run={actorSendVoidRun} height="h-[500px]" />
				<GraphTile
					title="Actor sendBatch · ordered fire-and-forget messages"
					run={actorStaticAdapterRun}
					visibleStateIds={["queue", "@editor"]}
					height="h-[500px]"
				/>
				<GraphTile
					title="Completion notify → waitFor · chart-owned endpoint"
					run={completionScenario.staticRun()}
					visibleStateIds={["@worker.publish", "wait"]}
					height="h-[500px]"
				/>
				<GraphTile title="Actor call · request and reply" run={actorNamedReplyRun} height="h-[500px]" />
				<GraphTile
					title="Actor callBatch · pooled requests and replies"
					run={actorPoolCrowdedRun}
					visibleStateIds={["batch", "@workers"]}
					height="h-[500px]"
				/>
			</div>
		</BoardPage>
	),
};
