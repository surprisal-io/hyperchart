import {
	actor,
	actorPool,
	callBatch,
	chart,
	final,
	item,
	map,
	message,
	messageInput,
	protocol,
	receive,
	reply,
	self,
	send,
	z,
} from "@surprisal/hyperchart";

const EditorProtocol = protocol({
	APPLY: message({
		input: z.object({ patch: z.string() }).strict(),
		reply: z.object({ patch: z.string() }).strict(),
	}),
	FOLLOW_UP: message({
		input: z.object({ patch: z.string() }).strict(),
		reply: z.object({ patch: z.string() }).strict(),
	}),
});

const Editor = actor({
	input: z.object({ projectId: z.string(), file: z.string() }).strict(),
	protocol: EditorProtocol,
	initial: "idle",
	states: {
		idle: receive({ on: { APPLY: "queueFollowUp", FOLLOW_UP: "settleFollowUp" } }),
		queueFollowUp: send({
			to: self(),
			event: "FOLLOW_UP",
			input: messageInput("APPLY"),
			target: "settleApply",
		}),
		settleApply: reply({ target: "idle", output: messageInput("APPLY") }),
		settleFollowUp: reply({ target: "idle", output: messageInput("FOLLOW_UP") }),
	},
});

const Editors = actorPool({ concurrency: 2, worker: Editor });
const editors = Editors({ projectId: item("id"), file: item("sourceFile") });

export default chart({
	kind: "chart",
	id: "explicit-actors-example",
	initial: "projects",
	states: {
		projects: map({
			over: { kind: "arg", name: "projects" },
			actors: { editors },
			initial: "apply",
			onDone: "done",
			states: {
				apply: callBatch({
					to: editors,
					event: "APPLY",
					inputs: [
						{ patch: "first patch" },
						{ patch: "second patch" },
						{ patch: "third patch" },
					],
					target: "finished",
				}),
				finished: final(),
			},
		}),
		done: final(),
	},
});
