import { agent, chart, final, jsonSchema, user } from "../../src/index.js";

export default chart<{ task: string }>({
	id: "review-and-fix",
	initial: "research",
	states: {
		research: {
			action: agent("researcher", {
				input: ({ input }) => ({ task: input.task }),
				output: jsonSchema({
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
			action: agent("planner", {
				input: ({ input, results }) => ({
					task: input.task,
					research: results.research?.output,
				}),
				output: jsonSchema({
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
			action: agent("coder"),
			transitions: {
				IMPLEMENTED: "approval",
				FAILED: "failed",
			},
		},

		approval: {
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
