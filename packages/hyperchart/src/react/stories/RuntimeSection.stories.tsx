import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { RuntimeSection } from "../components/inspector/details/RuntimeSection.js";
import type { HyperchartStateInfo } from "../types.js";

const state: HyperchartStateInfo = {
	id: "research.deep-research#regional-risk.scout",
	type: "agent",
	status: "running",
	agent: "report-engine-research-scout",
	startedAt: 1_700_000_000_000,
	visits: 2,
	visitHistory: [
		{
			visit: 1,
			invokeSeqId: 7,
			startedAt: 1_699_999_900_000,
			endedAt: 1_699_999_960_000,
			status: "done",
			completedEvent: "RESEARCHED",
			invocation: { kind: "agent", task: "Research the initial regional escalation risk." },
			session: {
				actionKey: "odyssey:research.deep-research#regional-risk.scout:agent",
				status: "completed",
				startedAt: 1_699_999_900_000,
				model: "deepseek/deepseek-v4-pro",
				turnCount: 2,
				toolCount: 3,
				messages: [{ id: "old-a1", role: "assistant", text: "Initial visit completed." }],
			},
		},
		{
			visit: 2,
			invokeSeqId: 12,
			startedAt: 1_700_000_000_000,
			status: "running",
			invocation: { kind: "agent", task: "Research the regional escalation risk." },
			session: {
				actionKey: "odyssey:research.deep-research#regional-risk.scout:agent",
				status: "running",
				startedAt: 1_700_000_000_000,
				lastActivityAt: 1_700_000_040_000,
				model: "openai-codex/gpt-5.6-luna",
				thinking: "xhigh",
				turnCount: 3,
				toolCount: 5,
				tokenCount: 8_412,
				messages: [{ id: "a1", role: "assistant", text: "Current visit is still running." }],
			},
		},
	],
	session: {
		actionKey: "odyssey:research.deep-research#regional-risk.scout:agent",
		status: "running",
		startedAt: 1_700_000_000_000,
		lastActivityAt: 1_700_000_040_000,
		model: "openai-codex/gpt-5.6-luna",
		thinking: "xhigh",
		turnCount: 3,
		toolCount: 5,
		tokenCount: 8_412,
		currentTool: "web_search",
		currentToolArgs: '{ "query": "Iran US conflict current status" }',
		messages: [
			{ id: "u1", role: "user", text: "Research the regional escalation risk." },
			{ id: "a1", role: "assistant", text: "I’m checking current official statements and major wires." },
		],
	},
};

const { session: _session, ...stateWithoutSession } = state;
const secondSessionState: HyperchartStateInfo = {
	...state,
	id: "research.deep-research#military-posture.scout",
	session: {
		...state.session!,
		actionKey: "odyssey:research.deep-research#military-posture.scout:agent",
		startedAt: 1_700_000_100_000,
		messages: [{ id: "u2", role: "user", text: "Research current military posture." }],
	},
};

const narrowState: HyperchartStateInfo = {
	...state,
	session: {
		...state.session!,
		model: "provider-with-an-extremely-long-namespace/model-with-an-extremely-long-version-suffix",
		error:
			"SessionTransportFailureWithoutNaturalBreakpoints:upstream-provider-returned-an-unexpectedly-long-diagnostic-that-must-wrap-inside-the-runtime-panel",
	},
};

function SessionTransitionHarness({
	onSteerSession,
}: {
	onSteerSession?: (actionKey: string, message: string) => void | Promise<void>;
}) {
	const [phase, setPhase] = useState<"idle" | "first" | "second">("idle");
	const [lastSteer, setLastSteer] = useState("");
	const currentState = phase === "idle" ? stateWithoutSession : phase === "first" ? state : secondSessionState;
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap gap-2">
				<button type="button" onClick={() => setPhase("first")}>Attach live session</button>
				<button type="button" onClick={() => setPhase("second")}>Select second session</button>
			</div>
			<RuntimeSection
				state={currentState}
				onSteerSession={async (actionKey, message) => {
					setLastSteer(`${actionKey}: ${message}`);
					await onSteerSession?.(actionKey, message);
				}}
			/>
			<output aria-label="Last steering target">{lastSteer}</output>
		</div>
	);
}

const meta = {
	title: "Hyperchart/Components/Runtime Section",
	component: RuntimeSection,
	parameters: {
		layout: "centered",
		docs: {
			description: {
				component: "Run-specific state facts and agent-session controls. Live sessions expand Runtime by default.",
			},
		},
	},
	args: {
		state,
		onSteerSession: fn(),
	},
	decorators: [
		(Story) => (
			<div className="w-[420px] max-w-[calc(100vw-2rem)]">
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof RuntimeSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LiveAgentSession: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		await expect(canvas.getByText("Agent session")).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "View session" }));
		await expect(canvas.getByRole("dialog")).toBeVisible();
		await expect(canvas.getByText("@report-engine-research-scout session")).toBeVisible();
	},
};

export const SessionPerVisit: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		await userEvent.click(canvas.getByRole("button", { name: "View session for visit 1" }));
		await expect(canvas.getByRole("dialog")).toBeVisible();
		await expect(canvas.getByText("Initial visit completed.")).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "Close agent session" }));
		await userEvent.click(canvas.getByRole("button", { name: "View session for visit 2" }));
		await expect(canvas.getByText("Current visit is still running.")).toBeVisible();
	},
};

export const NarrowLongContent: Story = {
	args: { state: narrowState },
	render: (args) => (
		<div className="w-[260px]">
			<RuntimeSection {...args} />
		</div>
	),
};

export const PollingAndSessionIsolation: Story = {
	args: { state: stateWithoutSession },
	render: ({ onSteerSession }) => (
		<SessionTransitionHarness {...(onSteerSession === undefined ? {} : { onSteerSession })} />
	),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		await expect(canvas.getByRole("button", { name: "Runtime" })).toHaveAttribute("aria-expanded", "false");
		await userEvent.click(canvas.getByRole("button", { name: "Attach live session" }));
		await expect(canvas.getByRole("button", { name: "Runtime" })).toHaveAttribute("aria-expanded", "true");
		await userEvent.click(canvas.getByRole("button", { name: "View session" }));
		await userEvent.type(canvas.getByRole("textbox", { name: "Steering message" }), "must not leak");

		await userEvent.click(canvas.getByRole("button", { name: "Select second session" }));
		await expect(canvas.queryByRole("dialog")).not.toBeInTheDocument();
		await userEvent.click(canvas.getByRole("button", { name: "View session" }));
		const steering = canvas.getByRole("textbox", { name: "Steering message" });
		await expect(steering).toHaveValue("");
		await userEvent.type(steering, "focus on deployments");
		await userEvent.click(canvas.getByRole("button", { name: "Steer" }));
		await expect(canvas.getByLabelText("Last steering target")).toHaveTextContent(
			"odyssey:research.deep-research#military-posture.scout:agent: focus on deployments",
		);
	},
};
