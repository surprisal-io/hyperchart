import { agent, chart, final } from "../../core/dsl.js";
import { storyArgs, storyComplete, storyInvoke, storyScenario } from "./story-scenario.js";
import { capturedStorySchedule } from "./capture-story-schedule.js";

export const scenario = storyScenario(chart({
	kind: "chart", id: "runtime-section-story", initial: "research",
	states: {
		research: { kind: "state", action: agent("report-engine-research-scout", { task: "Research the regional escalation risk.", model: "openai-codex/gpt-5.6-luna", thinking: "xhigh", tools: ["read", "web_search"] }), transitions: { REENTER: "research", DONE: "second" } },
		second: { kind: "state", action: agent("report-engine-research-scout", { task: "Research current military posture." }), transitions: { DONE: "done" } },
		done: final(),
	},
}));
const schedule = [storyArgs({}, 1, 1_700_000_000_000), storyInvoke(scenario.ast, "research", 2, 1_700_000_010_000), storyComplete(scenario.ast, "research", "REENTER", 3, 1_700_000_020_000), storyInvoke(scenario.ast, "research", 4, 1_700_000_030_000)];
const secondSchedule = [...schedule, storyComplete(scenario.ast, "research", "DONE", 5, 1_700_000_050_000), storyInvoke(scenario.ast, "second", 6, 1_700_000_060_000)];
export const records = capturedStorySchedule(scenario.ast, schedule);
export const secondRecords = capturedStorySchedule(scenario.ast, secondSchedule);
