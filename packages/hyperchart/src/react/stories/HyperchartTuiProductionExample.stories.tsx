import type { Meta, StoryObj } from "@storybook/react-vite";
import { BoardPage } from "./components/index.js";
import { TuiTerminalPreview } from "./tui/TuiTerminalPreview.js";

const meta = {
	title: "Hyperchart/TUI/Examples/Minimal Run Picker",
	component: TuiTerminalPreview,
	parameters: {
		layout: "fullscreen",
		docs: {
			description: {
				component:
					"Production-shaped minimal TUI picker. Detailed graph, state, session, and transcript exploration intentionally moves to the browser inspector.",
			},
		},
	},
	args: {
		kind: "history",
		width: 120,
		theme: "dark",
		preset: "initial",
		interactive: true,
	},
	argTypes: {
		kind: { control: false },
		width: { control: "inline-radio", options: [60, 80, 120] },
		theme: { control: "inline-radio", options: ["dark", "light"] },
		preset: { control: false },
		interactive: { control: false },
	},
} satisfies Meta<typeof TuiTerminalPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Picker: Story = {
	render: (args) => (
		<BoardPage
			title="Production-like run picker"
			description="TUI только выбирает run. Enter передаёт его единственному подробному интерфейсу — browser inspector. Storybook держит живой Node instance RunHistoryOverlay."
		>
			<div className="mb-4 grid gap-3 text-xs md:grid-cols-4">
				{[
					["Chart", "deck-director.chart.ts"],
					["Durable state", "research map · 2 done · 1 running"],
					["TUI detail", "run id · state · progress"],
					["Enter", "open browser inspector"],
				].map(([label, value]) => (
					<div key={label} className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3">
						<div className="text-[var(--text-muted)]">{label}</div>
						<div className="mt-1 font-mono text-[var(--text-primary)]">{value}</div>
					</div>
				))}
			</div>
			<TuiTerminalPreview {...args} />
		</BoardPage>
	),
};
