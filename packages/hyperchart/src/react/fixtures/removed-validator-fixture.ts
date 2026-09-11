import { capturedStoryRecords } from "./capture-story-schedule.js";
import { agent, chart, final, tsImport } from "../../core/dsl.js";
import { explainReplay } from "../../core/replay_check.js";
import { hyperchartRunFromRuntime } from "../../host/adapters.js";
import { storyScenario } from "./story-scenario.js";

export const removedValidatorDefinition = (guarded: boolean) => chart({
	kind: "chart", id: "recorded-validation", initial: "work",
	states: {
		work: {
			kind: "state", action: agent("worker", { artifacts: { result: "result.txt" },
					...(guarded ? { validation: { guard: tsImport("./checks.js", "ok") } } : {}),
				}),
				transitions: { AGAIN: "work", DONE: "done" },
		},
		done: final(),
	},
});
export const guardedValidationScenario = storyScenario(removedValidatorDefinition(true));
export const removedValidationScenario = storyScenario(removedValidatorDefinition(false));

export function removedValidatorStoryRun(pending = false) {
	const records = capturedStoryRecords("removed-validator-history");
	const snapshot = pending ? records.slice(0, records.findIndex((record) => record.type === "state_action" && record.kind === "validated")) : records;
	const replay = explainReplay(removedValidationScenario.ast, snapshot);
	if (replay.broken !== undefined) throw new Error(replay.broken.error);
	return hyperchartRunFromRuntime(removedValidationScenario.inspect, removedValidationScenario.ast, snapshot, { runId: "recorded-validation", cwd: "/workspace" });
}
