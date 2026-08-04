import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";
import { BoardPage, BoardSection } from "./components/index.js";
import { TuiTerminalPreview } from "./tui/TuiTerminalPreview.js";

const meta = {
	title: "Hyperchart/TUI/Run Widget",
	id: "hyperchart-tui-components-run-widget",
	component: TuiTerminalPreview,
	parameters: {
		layout: "fullscreen",
		docs: { description: { component: "The actual compact RunWidget backed by the same production-shaped run fixture." } },
	},
	args: {
		kind: "widget",
		width: 80,
		theme: "dark",
		preset: "initial",
		interactive: false,
	},
	argTypes: {
		kind: { control: false },
		width: { control: "inline-radio", options: [60, 80, 120] },
		theme: { control: "inline-radio", options: ["dark", "light"] },
		preset: { control: "inline-radio", options: ["initial", "manyRunning"] },
		interactive: { control: false },
	},
} satisfies Meta<typeof TuiTerminalPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LiveRun: Story = {
	render: (args) => (
		<BoardPage title="TUI · Run widget" description="Компактный production widget с активной scout session и path-aware прогрессом в процентах.">
			<TuiTerminalPreview {...args} />
		</BoardPage>
	),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent("TUI live: widget"));
		await expect(canvas.getByLabelText("TUI plain text")).toHaveTextContent("research#market.scout");
		await expect(canvas.getByLabelText("TUI plain text")).toHaveTextContent(/\d+%/);
	},
};

export const ManyActiveStates: Story = {
	args: { preset: "manyRunning", width: 120 },
	parameters: {
		docs: { description: { story: "Eight concurrently running map instances with the shared path-aware percentage estimate." } },
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent("TUI live: widget"));
		await expect(canvas.getByLabelText("TUI plain text")).toHaveTextContent("8 active");
		await expect(canvas.getByLabelText("TUI plain text")).toHaveTextContent("+5 more");
	},
};

export const WidthMatrix: Story = {
	args: { preset: "manyRunning" },
	render: (args) => (
		<BoardPage title="Run widget · many active states" description="Восемь одновременных states на 60, 80 и 120 колонках.">
			<div className="grid gap-6">
				{([60, 80, 120] as const).map((width) => (
					<BoardSection key={width} title={`${width} columns`}>
						<TuiTerminalPreview {...args} width={width} />
					</BoardSection>
				))}
			</div>
		</BoardPage>
	),
	parameters: { controls: { disable: true } },
};
