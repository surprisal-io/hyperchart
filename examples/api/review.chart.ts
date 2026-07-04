import { agent, final, refs, user, z } from "../../src/index.js";

const Research = z.object({ summary: z.string() });
const Plan = z.object({ steps: z.array(z.string()) });
type Research = z.infer<typeof Research>;
type Plan = z.infer<typeof Plan>;

const { chart } = refs<Record<string, never>, { research: Research; plan: Plan }>();

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
