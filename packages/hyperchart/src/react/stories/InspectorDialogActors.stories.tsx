import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { HyperchartInspectorDialog } from "../HyperchartInspectorDialog.js";
import {
	actorBrokenReplayRun,
	actorBusyFifoRun,
	actorDrainingRun,
	actorFailureRun,
	actorIdleRun,
	actorReentryRun,
	actorSelfSendRun,
	actorPoolIdleRun,
	actorPoolCrowdedRun,
	actorPoolPartialBatchRun,
	actorPoolDrainingRun,
	actorPoolMapReentryRun,
	allActorRuns,
	allActorPoolRuns,
} from "../fixtures/actor-fixtures.js";
import { InteractiveInspector } from "./harnesses/InteractiveInspector.js";

const meta = {
	title: "Hyperchart/Inspector/Dialog/Actors",
	id: "hyperchart-features-explicit-actors",
	component: HyperchartInspectorDialog,
	parameters: { layout: "fullscreen", controls: { disable: true } },
	args: { runs: [...allActorRuns, ...allActorPoolRuns], selectedRunId: actorIdleRun.runId, onClose: fn() },
	render: (args) => <InteractiveInspector {...args} />,
} satisfies Meta<typeof HyperchartInspectorDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RootActorIdle: Story = {
	name: "Root Actor Idle",
	args: { runs: [actorIdleRun], selectedRunId: actorIdleRun.runId },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		const graph = within(canvas.getByRole("main"));

		await userEvent.click(await graph.findByTitle("@editor"));
		await expect(canvas.getByRole("button", { name: "Actor" })).toBeVisible();
		await expect(canvas.getByText("declaration")).toBeVisible();

		await userEvent.click(canvas.getByRole("button", { name: "Open scope" }));
		await expect(await graph.findByTitle("@editor.idle")).toBeVisible();
		await expect(await graph.findByTitle("@editor.apply")).toBeVisible();
		await expect(await graph.findByTitle("@editor.settle")).toBeVisible();

		await userEvent.click(await graph.findByTitle("@editor"));
		await expect(canvas.getByText("generation")).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "Open scope" }));
		await expect(await graph.findByTitle("@editor.idle")).toBeVisible();
		await expect(await graph.findByTitle("@editor.apply")).toBeVisible();
		await expect(await graph.findByTitle("@editor.settle")).toBeVisible();

		await userEvent.click(await graph.findByTitle("@editor.idle"));
		await expect(canvas.getByText("internal state")).toBeVisible();
		await expect(canvas.getByRole("button", { name: "Actor" })).toBeVisible();
	},
};
export const BusyFifoMailbox: Story = {
	name: "Busy FIFO Mailbox",
	args: { runs: [actorBusyFifoRun], selectedRunId: actorBusyFifoRun.runId },
};
export const ActorReentry: Story = {
	name: "Actor Reentry",
	args: { runs: [actorReentryRun], selectedRunId: actorReentryRun.runId },
};
export const PoolIdle: Story = {
	name: "Pool Idle",
	args: { runs: [actorPoolIdleRun], selectedRunId: actorPoolIdleRun.runId },
};
export const PoolBusyBacklog: Story = {
	name: "Pool Busy Slots and Backlog",
	args: { runs: [actorPoolCrowdedRun], selectedRunId: actorPoolCrowdedRun.runId },
};
export const PoolSelfSend: Story = {
	name: "Pool Self-send",
	args: { runs: [actorSelfSendRun], selectedRunId: actorSelfSendRun.runId },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		const graph = within(canvas.getByRole("main"));

		await userEvent.click(await graph.findByTitle("@workers"));
		await userEvent.click(canvas.getByRole("button", { name: "Open scope" }));
		await userEvent.click(await graph.findByTitle("@workers.$worker.fanout"));
		const selfTarget = canvas.getByRole("button", { name: "Navigate to actor state @workers" });
		await expect(selfTarget).toHaveTextContent("Self()");
		await userEvent.hover(selfTarget);
		await expect(canvas.getByRole("tooltip")).toHaveTextContent("state @workers");
		await userEvent.unhover(selfTarget);
	},
};
export const PoolPartialBatch: Story = {
	name: "Pool Partial callBatch",
	args: { runs: [actorPoolPartialBatchRun], selectedRunId: actorPoolPartialBatchRun.runId },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		const graph = within(canvas.getByRole("main"));
		await userEvent.click(await graph.findByTitle("@workers"));
		await expect(canvas.getByText("Workers · 1/2 active")).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: /\$worker-0/ }));
		await expect(canvas.getByRole("button", { name: /current WORK CALL ACCEPTED/ })).toBeVisible();
	},
};
export const PoolMapGenerationReentry: Story = {
	name: "Map-owned Pool Generation Re-entry",
	args: { runs: [actorPoolMapReentryRun], selectedRunId: actorPoolMapReentryRun.runId },
};
export const ClosingAndDraining: Story = {
	name: "Nested Actor Drain Navigation",
	args: { runs: [actorDrainingRun], selectedRunId: actorDrainingRun.runId },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		const graph = within(canvas.getByRole("main"));
		await expect(graph.queryByTitle("phase.@worker")).not.toBeInTheDocument();
		await userEvent.click(await graph.findByTitle("done"));
		await expect(canvas.getByText("Waiting for actors · 1")).toBeVisible();
		await expect(canvas.getByRole("button", { name: /phase\.@worker/ })).toBeVisible();
		await expect(graph.queryByTitle("phase.@worker")).not.toBeInTheDocument();
	},
};
export const PoolDraining: Story = {
	name: "Pool Draining",
	args: { runs: [actorPoolDrainingRun], selectedRunId: actorPoolDrainingRun.runId },
};
export const Failure: Story = {
	name: "Failure",
	args: { runs: [actorFailureRun], selectedRunId: actorFailureRun.runId },
};
export const BrokenReplayWarning: Story = {
	name: "Broken Replay Warning",
	args: { runs: [actorBrokenReplayRun], selectedRunId: actorBrokenReplayRun.runId },
};
