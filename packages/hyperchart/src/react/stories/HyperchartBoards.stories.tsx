import type { Meta, StoryObj } from "@storybook/react-vite";
import { BoardPage, InspectorPanelGroupBoard } from "./components/index.js";
import { inspectorPanelGroups, inspectorPanelSpecs, type InspectorPanelGroupId } from "./inspector-panel/specs.js";
import { inspectorPanelTileProps } from "./inspector-panel/runtime.js";

const meta = {
	title: "Hyperchart/Visual Tests/Inspector Panel",
	parameters: {
		layout: "fullscreen",
		controls: { disable: true },
		docs: {
			description: {
				component: "Visual regression boards for every inspector side-panel state and runtime source block.",
			},
		},
	},
} satisfies Meta;

export default meta;
type Story = StoryObj;

function renderGroup(groupId: InspectorPanelGroupId) {
	return (
		<InspectorPanelGroupBoard
			groupId={groupId}
			groups={inspectorPanelGroups}
			specs={inspectorPanelSpecs}
			buildTileProps={inspectorPanelTileProps}
		/>
	);
}

export const Index: Story = {
	name: "index",
	render: () => (
		<BoardPage
			title="Inspector panel boards"
			description="Index only: правая панель инспектора разбита на отдельные boards по типам state/node, чтобы ревьюить не одну длинную страницу."
		>
			<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
				{inspectorPanelGroups.map((group) => {
					const count = inspectorPanelSpecs.filter((spec) => spec.group === group.id).length;
					return (
						<a
							key={group.id}
							href={`/?path=/story/${group.storyId}`}
							target="_top"
							onClick={(event) => {
								event.preventDefault();
								window.top?.location.assign(`/?path=/story/${group.storyId}`);
							}}
							className="block rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4 transition hover:border-[var(--accent)] hover:bg-[var(--bg-tertiary)]"
						>
							<div className="text-sm font-semibold text-[var(--text-primary)]">{group.title}</div>
							<div className="mt-1 text-xs text-[var(--text-tertiary)]">{group.description}</div>
							<div className="mt-3 text-[11px] font-medium text-[var(--hc-blue-text)]">
								Open board · {count} {count === 1 ? "case" : "cases"}
							</div>
						</a>
					);
				})}
			</div>
		</BoardPage>
	),
	parameters: { docs: { description: { story: "Navigation index for the eight focused panel boards." } } },
};

function groupStory(groupId: InspectorPanelGroupId, name: string, description: string): Story {
	return {
		name,
		render: () => renderGroup(groupId),
		parameters: { docs: { description: { story: description } } },
	};
}

export const Overview = groupStory("overview", "overview", "Run-level arguments, activity, metadata, and chart definition.");
export const AgentStates = groupStory("agent", "agent states", "Agent prompts, references, re-entry, and validation guards.");
export const UserStates = groupStory("user", "user states", "User-input prompts and transition details.");
export const ScriptStates = groupStory("script", "script states", "Script arguments, environment, contracts, and skipped states.");
export const MapStates = groupStory("map", "map states", "Map parent status and mapped worker details.");
export const ParallelStates = groupStory("parallel", "parallel states", "Parallel fan-out branches and progress states.");
export const CompoundStates = groupStory("compound", "compound states", "Nested compound scopes, agents, and contracts.");
export const FinalStates = groupStory("final", "final states", "Terminal state details.");
