import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { HyperchartLaunchDialog } from "../HyperchartLaunchDialog.js";

const meta = {
	title: "Hyperchart/Components/Launch Dialog",
	component: HyperchartLaunchDialog,
	parameters: {
		layout: "fullscreen",
		docs: {
			description: {
				component: "Launch form for structured chart arguments or a freeform instruction.",
			},
		},
	},
	args: {
		chartName: "deck-director",
		onSubmit: fn(),
		onCancel: fn(),
	},
	argTypes: {
		chartName: { control: "text", description: "Chart identifier shown in the dialog heading." },
		description: { control: "text" },
		args: { control: "object", description: "Structured argument definitions and their defaults." },
		submitLabel: { control: "text" },
		placeholder: { control: "text" },
		onSubmit: { control: false },
		onCancel: { control: false },
		onOpenGraph: { control: false },
		portal: { control: false },
	},
} satisfies Meta<typeof HyperchartLaunchDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Basic: Story = {
	args: {
		description: "Build an interactive narrative report from sourced evidence.",
		args: {
			topic: { description: "Subject or question for the report", default: "Google I/O 2026 announcements" },
			audience: { description: "Primary readers", default: "executives" },
		},
		onOpenGraph: fn(),
	},
	parameters: {
		docs: { description: { story: "Structured chart arguments with editable defaults." } },
	},
	play: async ({ canvasElement, args }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		await userEvent.click(canvas.getByRole("button", { name: "Run" }));
		await expect(args.onSubmit).toHaveBeenCalledWith("");
	},
};

export const FreeformInstruction: Story = {
	args: {
		chartName: "code-review-fix-cycle",
		description: "Review, patch, and verify a code change.",
		placeholder: "Fix the flaky retry test and explain the root cause…",
		submitLabel: "Start",
	},
	parameters: {
		docs: { description: { story: "Freeform launch mode without a structured argument schema." } },
	},
	play: async ({ canvasElement, args }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
		await expect(args.onCancel).toHaveBeenCalledOnce();
	},
};
