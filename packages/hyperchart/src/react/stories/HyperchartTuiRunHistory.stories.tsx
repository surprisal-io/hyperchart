import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { BoardPage, BoardSection } from "./components/index.js";
import { TuiTerminalPreview } from "./tui/TuiTerminalPreview.js";

const meta = {
	title: "Hyperchart/TUI/Run History",
	id: "hyperchart-tui-components-run-history",
	component: TuiTerminalPreview,
	parameters: {
		layout: "fullscreen",
		docs: {
			description: {
				component:
					"The actual minimal RunHistoryOverlay. It only selects a run; Enter hands the run to the browser inspector.",
			},
		},
	},
	args: {
		kind: "history",
		width: 80,
		theme: "dark",
		preset: "initial",
		interactive: true,
	},
	argTypes: {
		kind: { control: false },
		width: { control: "inline-radio", options: [60, 80, 120], description: "Terminal width in columns." },
		theme: { control: "inline-radio", options: ["dark", "light"] },
		preset: { control: "select", options: ["initial", "stopped", "stoppedWithWarning", "gateAndEmit"] },
		interactive: { control: "boolean" },
	},
} satisfies Meta<typeof TuiTerminalPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InteractiveSelection: Story = {
	name: "interactive selection",
	render: (args) => (
		<BoardPage
			title="TUI · Run history"
			description="Минимальный список запусков. ↑↓ выбирают run, Enter открывает полноценный browser inspector, Esc закрывает список."
		>
			<TuiTerminalPreview {...args} />
		</BoardPage>
	),
	play: async ({ canvasElement, args }) => {
		if (args.preset !== "initial" || args.interactive !== true) {
			return;
		}
		const canvas = within(canvasElement);
		await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent("TUI live: history"));
		await userEvent.click(canvas.getByRole("button", { name: "Enter · open inspector" }));
		await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent("TUI action: view"));
		await userEvent.click(canvas.getByRole("button", { name: "Reset" }));
	},
};

export const StoppedRunSelected: Story = {
	args: { preset: "stopped" },
	parameters: { docs: { description: { story: "Stopped but resumable production-shaped run selected." } } },
};

export const GateAndEmitSummary: Story = {
	args: { preset: "gateAndEmit", width: 120, interactive: false },
	parameters: {
		docs: {
			description: {
				story: "Production run-history row with the latest host-gate resolution and accepted domain emit summary.",
			},
		},
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent("TUI live: history"));
		await expect(canvas.getByLabelText("TUI plain text")).toHaveTextContent("gate 3 resolved → APPROVED");
		await expect(canvas.getByLabelText("TUI plain text")).toHaveTextContent("emit release.approved");
	},
};

export const WidthMatrix: Story = {
	render: (args) => (
		<BoardPage title="TUI width matrix" description="Один реальный RunHistoryOverlay на 60, 80 и 120 колонках.">
			<div className="grid gap-6">
				{([60, 80, 120] as const).map((width) => (
					<BoardSection key={width} title={`${width} columns`}>
						<TuiTerminalPreview {...args} width={width} interactive={false} />
					</BoardSection>
				))}
			</div>
		</BoardPage>
	),
	parameters: { controls: { disable: true } },
};
