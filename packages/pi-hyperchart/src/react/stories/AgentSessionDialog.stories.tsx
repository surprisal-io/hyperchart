import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { AgentSessionDialog } from "../components/inspector/details/AgentSessionDialog.js";

const liveSession = {
	actionKey: '{"chart":"deck","state":"draft","action":"writer"}',
	status: "running",
	startedAt: 1_700_000_000_000,
	lastActivityAt: 1_700_000_060_000,
	model: "anthropic/claude-sonnet-4-6",
	thinking: "medium",
	turnCount: 3,
	toolCount: 4,
	tokenCount: 8_412,
	currentReasoning: "I need to preserve the user's scroll position while appending new deltas. I’ll only stick to the bottom when the viewport is already near it.",
	currentText: "I’m updating the transcript renderer and live progress transport now…",
	currentTool: "edit",
	currentToolArgs: '{\n  "path": "src/react/components/AgentSessionDialog.tsx"\n}',
	messages: [
		{ id: "u1", role: "user" as const, text: "Add a live session view to agent cards.", timestamp: 1_700_000_000_000 },
		{ id: "r1", role: "reasoning" as const, text: "The card needs a stable action key and a compact session snapshot. The browser should never read the session file directly.", timestamp: 1_700_000_008_000 },
		{ id: "a1", role: "assistant" as const, text: "I’ll inspect the existing card and modal patterns, then wire the runtime data through the host model.", timestamp: 1_700_000_010_000 },
		{
			id: "t1",
			role: "tool" as const,
			toolName: "read",
			toolCallId: "call-read-1",
			toolInput: '{ "path": "AgentInfoCard.tsx" }',
			toolOutput: 'import { useState } from "react";\n\nexport function AgentInfoCard({ state, allStates }: AgentInfoCardProps) {\n  // …\n}',
			toolStatus: "completed" as const,
			timestamp: 1_700_000_020_000,
		},
		{ id: "a2", role: "assistant" as const, text: "The inspector already has portal, theme, and focus primitives. I’m reusing them for a compact transcript and steering composer.", timestamp: 1_700_000_040_000 },
	],
};

const meta = {
	title: "Hyperchart/Components/Agent Session Dialog",
	component: AgentSessionDialog,
	parameters: {
		layout: "fullscreen",
		docs: {
			description: {
				component: "Live, polling-friendly agent transcript with current tool activity and a steering composer.",
			},
		},
	},
	args: {
		agentName: "writer",
		session: liveSession,
		onClose: fn(),
		onSteer: fn(),
	},
} satisfies Meta<typeof AgentSessionDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LiveAndSteerable: Story = {
	play: async ({ canvasElement, args }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		const input = canvas.getByRole("textbox", { name: "Steering message" });
		await userEvent.type(input, "Prioritize the narrow layout.");
		await userEvent.click(canvas.getByRole("button", { name: "Steer" }));
		await expect(args.onSteer).toHaveBeenCalledWith("Prioritize the narrow layout.");
	},
};

const {
	currentTool: _currentTool,
	currentToolArgs: _currentToolArgs,
	currentText: _currentText,
	currentReasoning: _currentReasoning,
	...completedSession
} = liveSession;

export const ReadOnlyCompleted: Story = {
	args: {
		session: { ...completedSession, status: "completed" },
	},
	render: ({ onSteer: _onSteer, ...args }) => <AgentSessionDialog {...args} />,
};

export const CollapsedToolAndReasoning: Story = {
	args: {
		session: {
			actionKey: liveSession.actionKey,
			status: "completed",
			messages: [
				{
					id: "reasoning-long",
					role: "reasoning",
					text: "First inspect the current component structure.\nThen trace the session progress adapter.\nCompare the layout at narrow widths.\nFinally update the implementation and verify the result.",
				},
				{
					id: "tool-short",
					role: "tool",
					toolName: "read",
					toolInput: '{ "path": "AgentInfoCard.tsx" }',
					toolOutput: 'export function AgentInfoCard({ state }: AgentInfoCardProps) {\n  return <div>{state.agent}</div>;\n}',
					toolStatus: "completed",
				},
				{
					id: "tool-long",
					role: "tool",
					toolName: "read",
					toolInput: '{ "path": "src/react/components" }',
					toolOutput: "AgentInfoCard.tsx\nAgentSessionDialog.tsx\nHyperchartInspectorSidePanel.tsx\nHyperchartInspectorDialogInner.tsx",
					toolStatus: "completed",
				},
				{
					id: "tool-running",
					role: "tool",
					toolName: "bash",
					toolInput: '{ "command": "npm test" }',
					toolStatus: "running",
				},
			],
		},
	},
	render: ({ onSteer: _onSteer, ...args }) => <AgentSessionDialog {...args} />,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		const expand = canvas.getAllByRole("button", { name: "Expand" })[0];
		if (expand === undefined) throw new Error("Expected an expandable reasoning block");
		await userEvent.click(expand);
		const collapse = canvas.getByRole("button", { name: "Collapse" });
		await expect(collapse).toBeVisible();
		await expect(canvas.getByText(/Finally update the implementation/)).toBeVisible();
		await userEvent.click(collapse);
	},
};
