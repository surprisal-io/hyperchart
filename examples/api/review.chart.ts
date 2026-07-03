import { agent, chart, final, jsonSchema, user } from "../../src/index.js";

export default chart({
	kind: "chart",
	id: "review-and-fix",
	initial: "research",
	states: {
		research: {
			kind: "state",
			action: agent("researcher", {
				outputSchema: jsonSchema({
					type: "object",
					required: ["summary"],
					properties: { summary: { type: "string" } },
				}),
			}),
			transitions: {
				RESEARCH_READY: "plan",
				FAILED: "failed",
			},
		},

		plan: {
			kind: "state",
			action: agent("planner", {
				outputSchema: jsonSchema({
					type: "object",
					required: ["steps"],
					properties: { steps: { type: "array", items: { type: "string" } } },
				}),
			}),
			transitions: {
				PLAN_READY: "implement",
				FAILED: "failed",
			},
		},

		implement: {
			kind: "state",
			action: agent("coder"),
			transitions: {
				IMPLEMENTED: "approval",
				FAILED: "failed",
			},
		},

		approval: {
			kind: "state",
			action: user({ prompt: "Apply changes?", options: ["APPROVED", "REJECTED"] }),
			transitions: {
				APPROVED: "done",
				REJECTED: "implement",
			},
		},

		done: final(),
		failed: final(),
	},
});
