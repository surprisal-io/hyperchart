import type { Meta, StoryObj } from "@storybook/react-vite";
import { InspectorPanelGroupBoard } from "./components/index.js";
import { ActorCompletionCases, ActorRuntimeCases } from "./components/ActorCompletionBoards.js";
import { inspectorPanelGroups, inspectorPanelSpecs, type InspectorPanelGroupId } from "./inspector-panel/specs.js";
import { inspectorPanelTileProps } from "./inspector-panel/runtime.js";

const meta = {
	title: "Hyperchart/Inspector/State Details/Actors",
	id: "hyperchart-visual-tests-inspector-panel-actors",
	parameters: {
		layout: "fullscreen",
		controls: { disable: true },
		docs: {
			description: {
				component: "Focused actor State Details boards, split to keep each visual regression page fast.",
			},
		},
	},
} satisfies Meta;

export default meta;
type Story = StoryObj;

function actorGroupStory(groupId: InspectorPanelGroupId, description: string): Story {
	return {
		render: () => (
			<InspectorPanelGroupBoard
				groupId={groupId}
				groups={inspectorPanelGroups}
				specs={inspectorPanelSpecs}
				buildTileProps={inspectorPanelTileProps}
			/>
		),
		parameters: { docs: { description: { story: description } } },
	};
}

export const DeclarationsAndPools = actorGroupStory(
	"actorDefinitions",
	"Actor and pool declarations, protocols, workers, and backlog.",
);

export const MessagingStates = actorGroupStory(
	"actorMessaging",
	"Actor-local prompts and send, call, receive, reply, batch, and self-send states.",
);

export const NotifyAndWaitFor: Story = {
	render: () => (
		<InspectorPanelGroupBoard
			groupId="actorCompletion"
			groups={inspectorPanelGroups}
			specs={inspectorPanelSpecs}
			buildTileProps={inspectorPanelTileProps}
		>
			<ActorCompletionCases />
		</InspectorPanelGroupBoard>
	),
};

export const RuntimeAndHistory: Story = {
	render: () => (
		<InspectorPanelGroupBoard
			groupId="actorRuntime"
			groups={inspectorPanelGroups}
			specs={inspectorPanelSpecs}
			buildTileProps={inspectorPanelTileProps}
		>
			<ActorRuntimeCases />
		</InspectorPanelGroupBoard>
	),
};
