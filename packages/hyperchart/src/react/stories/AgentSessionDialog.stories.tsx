import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { agent, chart, final } from "../../core/dsl.js";
import type { HyperchartRunFromRuntimeOptions, HyperchartRuntimeSessionProgressFile } from "../../host/adapters.js";
import { AgentSessionDialog } from "../components/inspector/details/AgentSessionDialog.js";
import type { HyperchartStateInfo } from "../types.js";
import { actionAt, storyArgs, storyComplete, storyInvoke, storyScenario } from "../fixtures/story-scenario.js";

const sessionScenario = storyScenario(chart({
	kind: "chart",
	id: "agent-session-dialog-story",
	initial: "draft",
	states: {
		draft: {
			kind: "state",
			action: agent("writer", {
				task: "Add a live session view to agent cards.",
				model: "anthropic/claude-sonnet-4-6",
				thinking: "medium",
				tools: ["read", "edit", "bash"],
			}),
			transitions: { DONE: "done" },
		},
		done: final(),
	},
}));
const draftAction = actionAt(sessionScenario.ast, "draft");
if (draftAction.kind !== "agent" || draftAction.model === undefined || draftAction.thinking === undefined) throw new Error("expected concrete draft agent metadata");
const draftUid = draftAction.uid;
const draftActionKey = `${draftUid.chart}:${draftUid.state}:${draftUid.action}`;
const draftInvokedAt = 1_700_000_001_000;
const activeRecords = [
	storyArgs({}, 1, 1_700_000_000_000),
	storyInvoke(sessionScenario.ast, "draft", 2, draftInvokedAt),
];
const completedRecords = [
	...activeRecords,
	storyComplete(sessionScenario.ast, "draft", "DONE", 3, 1_700_000_060_000),
];

function projectedSession(
	records: Parameters<typeof sessionScenario.runtimeRun>[0],
	progress: HyperchartRuntimeSessionProgressFile,
	status: NonNullable<HyperchartRunFromRuntimeOptions["status"]>,
): NonNullable<HyperchartStateInfo["session"]> {
	const run = sessionScenario.runtimeRun(records, {
		runId: `agent-session:${progress.updatedAt ?? "fixture"}`,
		status,
		sessionProgress: progress,
		cwd: "/workspace",
		createdAt: 1_700_000_000_000,
		updatedAt: progress.updatedAt ?? 1_700_000_060_000,
	});
	const session = run.states.find((state) => state.id === "draft")?.session;
	if (session === undefined) throw new Error("adapter-derived agent session is unavailable");
	return session;
}

const liveProgress: HyperchartRuntimeSessionProgressFile = {
	updatedAt: 1_700_000_060_000,
	sessions: {
		live: {
			actionUid: draftUid,
			visit: 1,
			actionKey: draftActionKey,
			status: "running",
			startedAt: draftInvokedAt,
			lastActivityAt: 1_700_000_060_000,
			model: draftAction.model,
			thinking: draftAction.thinking,
			turnCount: 3,
			toolCount: 4,
			tokenCount: 8_412,
			currentReasoning: "I need to preserve the user's scroll position while appending new deltas. I’ll only stick to the bottom when the viewport is already near it.",
			currentText: "I’m updating the transcript renderer and live progress transport now…",
			currentTool: "edit",
			currentToolArgs: '{\n  "path": "src/react/components/AgentSessionDialog.tsx"\n}',
			messages: [
				{ id: "u1", role: "user", text: "Add a live session view to agent cards.", timestamp: draftInvokedAt },
				{ id: "r1", role: "reasoning", text: "The card needs a stable action key and a compact session snapshot. The browser should never read the session file directly.", timestamp: 1_700_000_008_000 },
				{ id: "a1", role: "assistant", text: "I’ll inspect the existing card and modal patterns, then wire the runtime data through the host model.", timestamp: 1_700_000_010_000 },
				{
					id: "t1",
					role: "tool",
					toolName: "read",
					toolCallId: "call-read-1",
					toolInput: '{ "path": "AgentInfoCard.tsx" }',
					toolOutput: 'import { useState } from "react";\n\nexport function AgentInfoCard({ state, allStates }: AgentInfoCardProps) {\n  // …\n}',
					toolStatus: "completed",
					timestamp: 1_700_000_020_000,
				},
				{ id: "a2", role: "assistant", text: "The inspector already has portal, theme, and focus primitives. I’m reusing them for a compact transcript and steering composer.", timestamp: 1_700_000_040_000 },
			],
		},
	},
};
const liveSession = projectedSession(activeRecords, liveProgress, { state: "running", updatedAt: 1_700_000_060_000 });

const completedProgress: HyperchartRuntimeSessionProgressFile = {
	updatedAt: 1_700_000_060_000,
	sessions: {
		completed: {
			actionUid: draftUid,
			visit: 1,
			actionKey: draftActionKey,
			status: "completed",
			startedAt: draftInvokedAt,
			completedAt: 1_700_000_060_000,
			model: draftAction.model,
			thinking: draftAction.thinking,
			turnCount: 3,
			toolCount: 4,
			tokenCount: 8_412,
			messages: liveProgress.sessions.live?.messages ?? [],
		},
	},
};
const completedSession = projectedSession(completedRecords, completedProgress, { state: "complete", updatedAt: 1_700_000_060_000 });

const collapsedProgress: HyperchartRuntimeSessionProgressFile = {
	updatedAt: 1_700_000_060_000,
	sessions: {
		collapsed: {
			actionUid: draftUid,
			visit: 1,
			actionKey: draftActionKey,
			status: "completed",
			startedAt: draftInvokedAt,
			completedAt: 1_700_000_060_000,
			messages: [
				{ id: "reasoning-long", role: "reasoning", text: "First inspect the current component structure.\nThen trace the session progress adapter.\nCompare the layout at narrow widths.\nFinally update the implementation and verify the result." },
				{ id: "tool-short", role: "tool", toolName: "read", toolInput: '{ "path": "AgentInfoCard.tsx" }', toolOutput: "export function AgentInfoCard({ state }: AgentInfoCardProps) {\n  return <div>{state.agent}</div>;\n}", toolStatus: "completed" },
				{ id: "tool-long", role: "tool", toolName: "read", toolInput: '{ "path": "src/react/components" }', toolOutput: "AgentInfoCard.tsx\nAgentSessionDialog.tsx\nHyperchartInspectorSidePanel.tsx\nHyperchartInspectorDialogInner.tsx", toolStatus: "completed" },
				{ id: "tool-running", role: "tool", toolName: "bash", toolInput: '{ "command": "npm test" }', toolStatus: "running" },
			],
		},
	},
};
const collapsedSession = projectedSession(completedRecords, collapsedProgress, { state: "complete", updatedAt: 1_700_000_060_000 });

const meta = {
	title: "Hyperchart/Inspector/Agent Session",
	id: "hyperchart-components-agent-session-dialog",
	component: AgentSessionDialog,
	parameters: {
		layout: "fullscreen",
		docs: { description: { component: "Agent sessions projected from a normalized chart, durable visits, and sessions/progress.json input." } },
	},
	args: { agentName: "writer", session: liveSession, onClose: fn(), onSteer: fn() },
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

export const ReadOnlyCompleted: Story = {
	args: { session: completedSession },
	render: ({ onSteer: _onSteer, ...args }) => <AgentSessionDialog {...args} />,
};

export const CollapsedToolAndReasoning: Story = {
	args: { session: collapsedSession },
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
