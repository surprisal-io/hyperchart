import {
	actor,
	call,
	chart,
	failed,
	final,
	item,
	map,
	message,
	protocol,
	receive,
	reply,
	z,
} from "@surprisal/hyperchart";

const EditorProtocol = protocol({
	APPLY: message({
		input: z.object({ patch: z.string() }).strict(),
		replies: {
			APPLIED: z.object({ commit: z.string() }).strict(),
			REJECTED: z.object({ reason: z.string() }).strict(),
		},
	}),
});

const Editor = actor({
	input: z.object({ projectId: z.string(), file: z.string() }).strict(),
	protocol: EditorProtocol,
	initial: "idle",
	states: {
		idle: receive({ on: { APPLY: "settle" } }),
		settle: reply({ target: "idle", event: "APPLIED", output: { commit: "example" } }),
	},
});

const editor = Editor({ projectId: item("id"), file: item("sourceFile") });

export default chart({
	kind: "chart",
	id: "explicit-actors-example",
	initial: "projects",
	states: {
		projects: map({
			over: { kind: "arg", name: "projects" },
			actors: { editor },
			initial: "apply",
			onDone: "done",
			states: {
				apply: call({
					to: editor,
					event: "APPLY",
					input: { patch: "example patch" },
					transitions: { APPLIED: "finished", REJECTED: "rejected" },
				}),
				finished: final(),
				rejected: failed(),
			},
		}),
		done: final(),
	},
});
