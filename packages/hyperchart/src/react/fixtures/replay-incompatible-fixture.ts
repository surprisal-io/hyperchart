import { capturedStoryRecords } from "./capture-story-schedule.js";
import { z } from "zod";
import { agent, arg, chart, final, input, parallel, script, t, tsAction, tsImport } from "../../core/dsl.js";
import { explainReplay } from "../../core/replay_check.js";
import { hyperchartRunFromReplayIncompatibility } from "../../host/adapters.js";
import { storyScenario } from "./story-scenario.js";

const definition = (validated: boolean) =>
	chart({
		kind: "chart",
		id: "removed-validator",
		initial: "experiment",
		states: {
			experiment: {
				kind: "state",
				action: validated
					? agent("experimenter", {
							task: t`Investigate ${arg("topic")}`,
							validation: { guard: tsImport("./checks.js", "ok") },
						})
					: script("true"),
				transitions: { DONE: { target: "after", input: { topic: arg("topic") } } },
			},
			after: {
				kind: "state",
				input: { topic: z.string() },
				action: agent("recorder", { task: t`Record ${input("topic")}` }),
				transitions: { AGAIN: { target: "after", input: { topic: arg("topic") } }, DONE: "persistScript" },
			},
			persistScript: { kind: "state", action: script("true"), transitions: { DONE: "persistImport" } },
			persistImport: { kind: "state", action: tsAction("./persist.js", "save"), transitions: { DONE: "suffix" } },
			suffix: parallel({
				states: {
					guarded: {
						kind: "compound",
						initial: "work",
						states: {
							work: {
								kind: "state",
								action: agent("candidate-writer", {
									artifacts: { candidate: "candidate.txt" },
									validation: { guard: tsImport("./checks.js", "candidate") },
								}),
								transitions: { DONE: "done" },
							},
							done: final(),
						},
					},
					clock: {
						kind: "compound",
						initial: "work",
						states: {
							work: { kind: "state", action: agent("clock"), transitions: { DONE: "done" } },
							done: final(),
						},
					},
				},
				onDone: "done",
			}),
			done: final(),
		},
	});
export const originalReplayScenario = storyScenario(definition(true));
export const changedReplayScenario = storyScenario(definition(false));

export function replayIncompatibleStoryRun() {
	const records = capturedStoryRecords("replay-incompatible-history");
	const broken = explainReplay(changedReplayScenario.ast, records).broken;
	if (broken === undefined || records[0] === undefined || records.at(-1) === undefined)
		throw new Error("Changed action identity must break replay");
	return hyperchartRunFromReplayIncompatibility(changedReplayScenario.inspect, broken, {
		runId: "removed-validator",
		cwd: "/workspace",
		createdAt: records[0].timestamp,
		updatedAt: records.at(-1)!.timestamp,
	});
}
