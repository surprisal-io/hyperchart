import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { agent, chart, final } from "../../core/dsl.js";
import type { HyperchartRuntimeSessionProgressFile } from "../../host/adapters.js";
import { RuntimeSection } from "../components/inspector/details/RuntimeSection.js";
import type { HyperchartRunInfo, HyperchartStateInfo } from "../types.js";
import { actionAt, storyArgs, storyComplete, storyInvoke, storyScenario } from "../fixtures/story-scenario.js";

const scenario = storyScenario(chart({
	kind: "chart", id: "runtime-section-story", initial: "research",
	states: {
		research: { kind: "state", action: agent("report-engine-research-scout", { task: "Research the regional escalation risk.", model: "openai-codex/gpt-5.6-luna", thinking: "xhigh", tools: ["read", "web_search"] }), transitions: { REENTER: "research", DONE: "second" } },
		second: { kind: "state", action: agent("report-engine-research-scout", { task: "Research current military posture." }), transitions: { DONE: "done" } },
		done: final(),
	},
}));
const records = [storyArgs({}, 1, 1_700_000_000_000), storyInvoke(scenario.ast, "research", 2, 1_700_000_010_000), storyComplete(scenario.ast, "research", "REENTER", 3, 1_700_000_020_000), storyInvoke(scenario.ast, "research", 4, 1_700_000_030_000)];
const researchAction = actionAt(scenario.ast, "research");
if (researchAction.kind !== "agent" || researchAction.model === undefined || researchAction.thinking === undefined) throw new Error("expected concrete research agent metadata");
const researchUid = researchAction.uid;
const progress: HyperchartRuntimeSessionProgressFile = {
	updatedAt: 1_700_000_040_000,
	sessions: {
		visit1: { actionUid: researchUid, visit: 1, actionKey: `${researchUid.chart}:${researchUid.state}:${researchUid.action}`, status: "completed", startedAt: 1_700_000_010_000, completedAt: 1_700_000_020_000, model: researchAction.model, thinking: researchAction.thinking, turnCount: 2, toolCount: 3, messages: [{ id: "old-a1", role: "assistant", text: "Initial visit completed." }] },
		visit2: { actionUid: researchUid, visit: 2, actionKey: `${researchUid.chart}:${researchUid.state}:${researchUid.action}`, status: "running", startedAt: 1_700_000_030_000, lastActivityAt: 1_700_000_040_000, model: researchAction.model, thinking: researchAction.thinking, turnCount: 3, toolCount: 5, tokenCount: 8_412, currentTool: "web_search", currentToolArgs: '{ "query": "Iran US conflict current status" }', messages: [{ id: "u1", role: "user", text: "Research the regional escalation risk." }, { id: "a1", role: "assistant", text: "Current visit is still running." }] },
	},
};
function requiredState(run: HyperchartRunInfo, stateId: string): HyperchartStateInfo {
	const state = run.states.find((candidate) => candidate.id === stateId);
	if (state === undefined) throw new Error(`adapter-derived runtime section state is unavailable: ${stateId}`);
	return state;
}
const run = scenario.runtimeRun(records, { runId: "runtime-section:research", status: { state: "running", updatedAt: 1_700_000_040_000 }, sessionProgress: progress, cwd: "/workspace", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_040_000 });
const state = requiredState(run, "research");
const runWithoutSession = scenario.runtimeRun(records, { runId: "runtime-section:no-session", status: { state: "running", updatedAt: 1_700_000_040_000 }, cwd: "/workspace", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_040_000 });
const stateWithoutSession = requiredState(runWithoutSession, "research");

const secondRecords = [...records, storyComplete(scenario.ast, "research", "DONE", 5, 1_700_000_050_000), storyInvoke(scenario.ast, "second", 6, 1_700_000_060_000)];
const secondUid = actionAt(scenario.ast, "second").uid;
const secondProgress: HyperchartRuntimeSessionProgressFile = { updatedAt: 1_700_000_070_000, sessions: { second: { actionUid: secondUid, visit: 1, actionKey: `${secondUid.chart}:${secondUid.state}:${secondUid.action}`, status: "running", startedAt: 1_700_000_060_000, messages: [{ id: "u2", role: "user", text: "Research current military posture." }] } } };
const secondRun = scenario.runtimeRun(secondRecords, { runId: "runtime-section:second", status: { state: "running", updatedAt: 1_700_000_070_000 }, sessionProgress: secondProgress, cwd: "/workspace" });
const secondSessionState = requiredState(secondRun, "second");

const narrowProgress: HyperchartRuntimeSessionProgressFile = {
	updatedAt: 1_700_000_040_000,
	sessions: {
		visit1: progress.sessions.visit1!,
		visit2: {
			...progress.sessions.visit2!,
			model: "provider-with-an-extremely-long-namespace/model-with-an-extremely-long-version-suffix",
			error: "SessionTransportFailureWithoutNaturalBreakpoints:upstream-provider-returned-an-unexpectedly-long-diagnostic-that-must-wrap-inside-the-runtime-panel",
		},
	},
};
const narrowRun = scenario.runtimeRun(records, {
	runId: "runtime-section:narrow-session",
	status: { state: "running", updatedAt: 1_700_000_040_000 },
	sessionProgress: narrowProgress,
	cwd: "/workspace",
	createdAt: 1_700_000_000_000,
	updatedAt: 1_700_000_040_000,
});
const narrowState = requiredState(narrowRun, "research");

function SessionTransitionHarness({ onSteerSession }: { onSteerSession?: (actionKey: string, message: string) => void | Promise<void> }) {
	const [phase, setPhase] = useState<"idle" | "first" | "second">("idle");
	const [lastSteer, setLastSteer] = useState("");
	const currentState = phase === "idle" ? stateWithoutSession : phase === "first" ? state : secondSessionState;
	return <div className="space-y-2"><div className="flex flex-wrap gap-2"><button type="button" onClick={() => setPhase("first")}>Attach live session</button><button type="button" onClick={() => setPhase("second")}>Select second session</button></div><RuntimeSection state={currentState} onSteerSession={async (actionKey, message) => { setLastSteer(`${actionKey}: ${message}`); await onSteerSession?.(actionKey, message); }} /><output aria-label="Last steering target">{lastSteer}</output></div>;
}

const meta = { title: "Hyperchart/Inspector/Runtime Section", id: "hyperchart-components-runtime-section", component: RuntimeSection, parameters: { layout: "centered", docs: { description: { component: "Runtime facts and sessions projected from durable visits plus sessions/progress.json input." } } }, args: { state, onSteerSession: fn() }, decorators: [(Story) => <div className="w-[420px] max-w-[calc(100vw-2rem)]"><Story /></div>] } satisfies Meta<typeof RuntimeSection>;
export default meta;
type Story = StoryObj<typeof meta>;
export const LiveAgentSession: Story = { play: async ({ canvasElement }) => { const canvas = within(canvasElement.ownerDocument.body); await expect(canvas.getByText("Agent session")).toBeVisible(); await userEvent.click(canvas.getByRole("button", { name: "View session" })); await expect(canvas.getByRole("dialog")).toBeVisible(); } };
export const SessionPerVisit: Story = { play: async ({ canvasElement }) => { const canvas = within(canvasElement.ownerDocument.body); await userEvent.click(canvas.getByRole("button", { name: "View session for visit 1" })); await expect(canvas.getByText("Initial visit completed.")).toBeVisible(); await userEvent.click(canvas.getByRole("button", { name: "Close agent session" })); await userEvent.click(canvas.getByRole("button", { name: "View session for visit 2" })); await expect(canvas.getByText("Current visit is still running.")).toBeVisible(); } };
export const NarrowLongContent: Story = { args: { state: narrowState }, render: (args) => <div className="w-[260px]"><RuntimeSection {...args} /></div> };
export const PollingAndSessionIsolation: Story = { args: { state: stateWithoutSession }, render: ({ onSteerSession }) => <SessionTransitionHarness {...(onSteerSession === undefined ? {} : { onSteerSession })} />, play: async ({ canvasElement }) => { const canvas = within(canvasElement.ownerDocument.body); await userEvent.click(canvas.getByRole("button", { name: "Attach live session" })); await userEvent.click(canvas.getByRole("button", { name: "View session" })); await userEvent.type(canvas.getByRole("textbox", { name: "Steering message" }), "must not leak"); await userEvent.click(canvas.getByRole("button", { name: "Select second session" })); await expect(canvas.queryByRole("dialog")).not.toBeInTheDocument(); } };
