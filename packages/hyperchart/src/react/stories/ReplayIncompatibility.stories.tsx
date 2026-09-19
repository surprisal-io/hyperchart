import { removedValidatorStoryRun } from "../fixtures/removed-validator-fixture.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { RunOverview } from "../components/inspector/details/RunOverview.js";
import { replayIncompatibleStoryRun } from "../fixtures/replay-incompatible-fixture.js";
import { gateContractChangedStoryRun } from "../fixtures/gate-emit-fixtures.js";

const meta = {
	title: "Hyperchart/Inspector/Run Overview/Replay incompatibility",

	loaders: [async () => ({ run: await replayIncompatibleStoryRun() })],
	render: (_args, { loaded }) => <RunOverview run={loaded.run} />,
	parameters: { controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Original guarded chart is executed and replay-checked; only then is the action kind changed. */
export const ChangedActionIdentity: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText("Current definition only")).toBeVisible();
		await expect(canvas.getByText(/Invalid action invoke/)).toBeVisible();
	},
};

/** Both histories are captured through the real execution loop, then replayed without the guard. */
export const RemovedValidatorRecordedPass: Story = {
	loaders: [async () => ({ run: await removedValidatorStoryRun() })],
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.queryByText("Current definition only")).toBeNull();
		await expect(canvas.getAllByText(/Validator removed/).length).toBeGreaterThan(0);
	},
};

export const RemovedValidatorPendingClaim: Story = {
	loaders: [async () => ({ run: await removedValidatorStoryRun(true) })],
	play: async ({ canvasElement }) => {
		await expect(within(canvasElement).getByText(/no recorded positive validation/)).toBeVisible();
	},
};

/** The durable opened gate is replayed against a definition whose rendered request payload changed. */
export const GateContractChanged: Story = {
	loaders: [async () => ({ run: gateContractChangedStoryRun() })],
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.queryByText("Current definition only")).toBeNull();
		await expect(canvas.getAllByText(/Rendered gate contract .* changed/).length).toBeGreaterThan(0);
	},
};
