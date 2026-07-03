import { agent, chart, final, user, z } from "../../src/index.js";

export default chart({
	kind: "chart",
	id: "review-and-fix",
	initial: "research",
	states: {
		research: {
			kind: "state",
			action: agent("researcher", {
				reply: z.object({ summary: z.string() }),
			}),
			transitions: {
				RESEARCH_READY: "plan",
				FAILED: "failed",
			},
		},

		plan: {
			kind: "state",
			action: agent("planner", {
				reply: z.object({ steps: z.array(z.string()) }),
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
