import { artifact, chart, final, script } from "@surprisal/hyperchart";

export default chart({
	kind: "chart",
	id: "hello",
	initial: "write",
	states: {
		write: {
			kind: "state",
			action: script(
				"node",
				["-e", `require("node:fs").writeFileSync("hello.txt", "Hello from Hyperchart\\n")`],
				{
					artifacts: { greeting: artifact("hello.txt") },
				},
			),
			transitions: { DONE: "done" },
		},
		done: final(),
	},
});
