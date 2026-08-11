import { describe, expect, it } from "vitest";
import {
	actor,
	actorPool,
	actorInput,
	messageInput,
	agent,
	call,
	callBatch,
	final,
	json,
	map,
	message,
	protocol,
	receive,
	refs,
	reply,
	script,
	send,
	sendBatch,
	t,
	z,
} from "../packages/hyperchart/src/index.js";
import { arg as untypedArg, artifactOf as untypedArtifactOf, event as untypedEvent, result as untypedResult } from "../packages/hyperchart/src/core/dsl.js";

type Args = { topic: string; goal: string };
type EmptyFiles = Record<never, Record<string, unknown>>;
type EmptyMaps = Record<never, unknown>;

type Plan = {
	steps: string[];
	meta: { dir: string; note?: string };
	buckets: Record<string, unknown>;
};

const { arg, result, artifactOf } = refs<Args, { plan: Plan }, { plan: { doc: Plan } }>();

describe("typed refs (TS-first)", () => {
	it("checks result states and path selectors at compile time", () => {
		expect(result("plan")).toEqual({ kind: "result", state: "plan" });
		expect(result("plan", "meta.dir")).toEqual({ kind: "result", state: "plan", path: "meta.dir" });

		// @ts-expect-error unknown state
		result("nope");
		// @ts-expect-error typo in the path selector
		result("plan", "meta.dirz");
		// @ts-expect-error paths do not descend into arrays
		result("plan", "steps.0");
	});

	it("admits any tail under free-form objects", () => {
		const name: string = "official";

		expect(result("plan", `buckets.${name}`)).toEqual({ kind: "result", state: "plan", path: "buckets.official" });
	});

	it("checks artifactOf states, artifact names and selectors against the Files map", () => {
		expect(artifactOf("plan")).toEqual({ kind: "artifactOf", state: "plan" });
		expect(artifactOf("plan", { artifact: "doc", select: "meta.dir" })).toEqual({
			kind: "artifactOf",
			state: "plan",
			artifact: "doc",
			select: "meta.dir",
		});
		expect(artifactOf("plan", { select: "meta.dir" })).toEqual({
			kind: "artifactOf",
			state: "plan",
			select: "meta.dir",
		});
		// @ts-expect-error unknown file-producing state
		artifactOf("nope");
		// @ts-expect-error unknown artifact name
		artifactOf("plan", { artifact: "nope" });
		// @ts-expect-error typo in the content selector
		artifactOf("plan", { artifact: "doc", select: "meta.dirz" });
	});

	it("checks arg names against the Args type", () => {
		expect(arg("topic")).toEqual({ kind: "arg", name: "topic" });
		// @ts-expect-error unknown argument
		arg("topicc");
	});

	it("checks declared launch argument metadata against the Args registry", () => {
		const typed = refs<{ topic: string; limit: number }, Record<string, never>>();
		const body = {
			kind: "chart",
			id: "typed-launch-args",
			args: {
				topic: { description: "Research subject", default: "Hyperchart" },
				limit: { default: 3 },
			},
			initial: "done",
			states: { done: final() },
		} as const;
		expect(typed.chart(body).args).toEqual(body.args);
		expect(typed.chart({ ...body, args: { topic: {} } }).args).toEqual({ topic: {} });
		expect(typed.chart({ ...body, args: {} }).args).toEqual({});

		// @ts-expect-error metadata default does not match the typed argument value
		typed.chart({ ...body, args: { topic: { default: 42 } } });
		// @ts-expect-error metadata names an argument absent from the Args registry
		typed.chart({ ...body, args: { typo: { default: "x" } } });
		// @ts-expect-error metadata mixes a registered argument with an unknown key
		typed.chart({ ...body, args: { topic: { default: "valid" }, toppic: { default: "typo" } } });
	});

	it("the refs-provided chart() pins the registry to the definition", () => {
		const Reply = z.object({ dir: z.string() });
		const body = {
			kind: "chart",
			id: "drift",
			initial: "work",
			states: {
				work: {
					kind: "state",
					action: agent("w", { reply: Reply, artifacts: { out: "out.json" } }),
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		} as const;

		const ok = refs<Record<string, never>, { work: z.infer<typeof Reply> }, { work: { out: unknown } }>();
		expect(ok.chart(body).id).toBe("drift");

		const renamed = refs<Record<string, never>, { renamed: z.infer<typeof Reply> }, { work: { out: unknown } }>();
		// @ts-expect-error the registry names a state the chart does not declare
		renamed.chart(body);

		const missing = refs<Record<string, never>, Record<string, never>, { work: { out: unknown } }>();
		// @ts-expect-error the chart declares a reply the registry does not mention
		missing.chart(body);

		const wrongArtifact = refs<
			Record<string, never>,
			{ work: z.infer<typeof Reply> },
			{ work: { renamed: unknown } }
		>();
		// @ts-expect-error artifact name drifted
		wrongArtifact.chart(body);
	});

	it("includes guard-produced artifacts in the typed Files registry", () => {
		const body = {
			kind: "chart",
			id: "typed-guard-files",
			initial: "work",
			states: {
				work: {
					kind: "state",
					action: script("node"),
					validate: script("node", [], { artifacts: { review: "review.json" } }),
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		} as const;
		const typed = refs<Record<string, never>, Record<string, never>, { work: { review: unknown } }>();
		expect(typed.artifactOf("work", { artifact: "review" })).toEqual({ kind: "artifactOf", state: "work", artifact: "review" });
		expect(typed.chart(body).id).toBe("typed-guard-files");
	});

	it("types key()/item() from the map registry and verifies it against over", () => {
		const Items = z.object({ buckets: z.record(z.string(), z.object({ purpose: z.string(), n: z.number() })) });
		type Item = z.infer<typeof Items>["buckets"][string];
		const body = {
			kind: "chart",
			id: "typed-map",
			initial: "plan",
			states: {
				plan: {
					kind: "state",
					action: agent("planner", { reply: Items }),
					transitions: { OK: "research" },
				},
				research: map({
					over: untypedResult("plan", "buckets"),
					initial: "scout",
					onDone: "done",
					states: {
						scout: { kind: "state", action: agent("scout"), transitions: { OK: "found" } },
						found: final(),
					},
				}),
				done: final(),
			},
		} as const;

		const typed = refs<
			Record<string, never>,
			{ plan: z.infer<typeof Items> },
			Record<never, Record<string, unknown>>,
			{ research: Item }
		>();
		expect(typed.key("research")).toEqual({ kind: "key", map: "research" });
		expect(typed.item("research", "purpose")).toEqual({ kind: "item", map: "research", path: "purpose" });
		// @ts-expect-error unknown map
		typed.key("nope");
		// @ts-expect-error typo in the item selector
		typed.item("research", "purposee");
		// a string field interpolates freely; the whole item needs json()
		t`${typed.key("research")} ${typed.item("research", "purpose")} ${json(typed.item("research"))}`;
		// @ts-expect-error a whole item cannot be embedded silently
		t`${typed.item("research")}`;
		// @ts-expect-error selectors do not descend into a primitive field
		typed.item("research", "purpose.deeper");

		// over: untypedResult carries no phantom, so the chart-computed item type is unknown — the
		// registry must say so; a concrete claim is drift.
		// @ts-expect-error maps registry is out of sync with the chart (unknown vs Item)
		typed.chart(body);
		const honest = refs<
			Record<string, never>,
			{ plan: z.infer<typeof Items> },
			Record<never, Record<string, unknown>>,
			{ research: unknown }
		>();
		expect(honest.chart(body).id).toBe("typed-map");
		const unregistered = refs<Record<string, never>, { plan: z.infer<typeof Items> }>();
		// @ts-expect-error the chart declares a map the registry does not mention
		unregistered.chart(body);
	});

	it("visit() is a numeric typed ref", () => {
		const typed = refs<Record<string, never>, Record<string, never>>();
		expect(typed.visit()).toEqual({ kind: "visit" });
		expect(typed.visit("work")).toEqual({ kind: "visit", state: "work" });
		t`visit ${typed.visit()} ${json(typed.visit("work"))}`;
	});

	it("types input() refs by input name and verifies input declarations against the chart", () => {
		const Feedback = z.object({ reason: z.string(), instructions: z.array(z.string()) });
		type Feedback = z.infer<typeof Feedback>;
		const typed = refs<
			Record<string, never>,
			Record<string, never>,
			EmptyFiles,
			EmptyMaps,
			{ fix: { feedback: Feedback; count: number } }
		>();

		expect(typed.input("feedback")).toEqual({ kind: "input", name: "feedback" });
		expect(typed.input("feedback", "reason")).toEqual({ kind: "input", name: "feedback", path: "reason" });
		expect(typed.event("feedback.reason")).toEqual({ kind: "event", path: "feedback.reason" });
		// @ts-expect-error unknown input name
		typed.input("feedbak");
		// @ts-expect-error typo in input selector
		typed.input("feedback", "reasn");
		// @ts-expect-error selectors do not descend into primitive inputs
		typed.input("count", "value");
		t`${typed.input("feedback", "reason")} ${json(typed.input("feedback"))}`;
		// @ts-expect-error a whole object input cannot be embedded silently
		t`${typed.input("feedback")}`;

		const body = {
			kind: "chart",
			id: "typed-inputs",
			initial: "gate",
			states: {
				gate: {
					kind: "state",
					action: agent("gate"),
					transitions: { BLOCK: { target: "fix", input: { feedback: untypedEvent() } } },
				},
				fix: {
					kind: "state",
					input: { feedback: Feedback },
					action: agent("fixer"),
					transitions: { OK: "done" },
				},
				done: final(),
			},
		} as const;
		const ok = refs<
			Record<string, never>,
			Record<string, never>,
			EmptyFiles,
			EmptyMaps,
			{ fix: { feedback: Feedback } }
		>();
		expect(ok.chart(body).id).toBe("typed-inputs");
		const unregistered = refs<Record<string, never>, Record<string, never>>();
		// @ts-expect-error the chart declares input the registry does not mention
		unregistered.chart(body);
		const wrong = refs<
			Record<string, never>,
			Record<string, never>,
			EmptyFiles,
			EmptyMaps,
			{ fix: { renamed: Feedback } }
		>();
		// @ts-expect-error input name drifted
		wrong.chart(body);
	});

	it("templates admit only primitive-valued refs; objects need an explicit json()", () => {
		// a string-valued selector and untyped refs interpolate freely
		t`path: ${result("plan", "meta.dir")} and ${untypedResult("anything")} and ${untypedArg("free")}`;
		// @ts-expect-error a whole object cannot be embedded silently
		t`plan: ${result("plan")}`;
		// @ts-expect-error an array cannot be embedded silently either
		t`steps: ${result("plan", "steps")}`;
		// ...but an explicit json() marks the intent
		const template = t`plan: ${json(result("plan"))}`;
		expect(template.refs).toEqual([{ kind: "result", state: "plan", json: true }]);
	});
});


describe("typed explicit actor protocols", () => {
	const Request = z.object({ patch: z.string() });
	const Receipt = z.object({ commit: z.string() });
	const Rejection = z.object({ reason: z.string() });
	const Protocol = protocol({
		APPLY: message({ input: Request, replies: { APPLIED: Receipt, REJECTED: Rejection } }),
		READ: message({ input: z.object({ path: z.string() }), reply: z.object({ text: z.string() }) }),
		PING: message({ input: z.object({ id: z.number() }) }),
	});
	const Template = actor({
		input: z.object({ file: z.string() }),
		protocol: Protocol,
		initial: "idle",
		states: {
			idle: receive({ on: { APPLY: "applied", READ: "read", PING: "pong" } }),
			applied: reply({ target: "idle", event: "APPLIED", output: { commit: "abc" } }),
			read: reply({ target: "idle", output: { text: "contents" } }),
			pong: reply({ target: "idle" }),
		},
	});
	const declaration = Template({ file: "src/index.ts" });

	it("infers target message inputs and exact named reply routes", () => {
		expect(send({ to: declaration, event: "APPLY", input: { patch: "p" }, target: "next" }).event).toBe("APPLY");
		expect(sendBatch({ to: declaration, event: "APPLY", inputs: [{ patch: "a" }, { patch: "b" }], target: "next" }).event).toBe("APPLY");
		expect(call({ to: declaration, event: "APPLY", input: { patch: "p" }, transitions: { APPLIED: "done", REJECTED: "retry" } }).event).toBe("APPLY");
		expect(call({ to: declaration, event: "READ", input: { path: "x" }, target: "next" }).event).toBe("READ");

		// @ts-expect-error unknown protocol message
		send({ to: declaration, event: "UNKNOWN", input: { patch: "p" }, target: "next" });
		// @ts-expect-error wrong singleton input
		send({ to: declaration, event: "APPLY", input: { path: "p" }, target: "next" });
		// @ts-expect-error wrong batch element input
		sendBatch({ to: declaration, event: "APPLY", inputs: [{ patch: "ok" }, { path: "bad" }], target: "next" });
		// @ts-expect-error singleton send has no inputs option
		send({ to: declaration, event: "APPLY", inputs: [{ patch: "p" }], target: "next" });
		// @ts-expect-error literal batches are non-empty
		sendBatch({ to: declaration, event: "APPLY", inputs: [], target: "next" });
		// @ts-expect-error named call must route every and only named reply
		call({ to: declaration, event: "APPLY", input: { patch: "p" }, transitions: { APPLIED: "done" } });
		// @ts-expect-error named call cannot add a reply event
		call({ to: declaration, event: "APPLY", input: { patch: "p" }, transitions: { APPLIED: "done", REJECTED: "retry", OTHER: "no" } });
		// @ts-expect-error single reply uses target, not named transitions
		call({ to: declaration, event: "READ", input: { path: "x" }, transitions: { DONE: "next" } });
		// @ts-expect-error a dynamic string is not a static declaration capability
		call({ to: "@editor", event: "APPLY", input: { patch: "p" }, transitions: { APPLIED: "done", REJECTED: "retry" } });
		// @ts-expect-error a static capability cannot be embedded in message data
		send({ to: declaration, event: "APPLY", input: { patch: declaration }, target: "next" });
	});

	it("types actor pools and permits callBatch only for single-reply protocols", () => {
		const Pool = actorPool({ concurrency: 2, worker: Template });
		const pool = Pool({ file: "src/index.ts" });
		expect(send({ to: pool, event: "PING", input: { id: 1 }, target: "next" }).event).toBe("PING");
		expect(sendBatch({ to: pool, event: "APPLY", inputs: [{ patch: "a" }], target: "next" }).event).toBe("APPLY");
		expect(callBatch({ to: pool, event: "READ", inputs: [{ path: "a" }, { path: "b" }], target: "next" }).event).toBe("READ");
		// @ts-expect-error named-reply messages cannot be used with callBatch
		callBatch({ to: pool, event: "APPLY", inputs: [{ patch: "a" }], target: "next" });
		// @ts-expect-error void messages cannot be used with callBatch
		callBatch({ to: pool, event: "PING", inputs: [{ id: 1 }], target: "next" });
	});

	it("mutually checks reply graphs and actor-local selectors", () => {
		// @ts-expect-error reply event is not declared for APPLY
		actor({
			input: z.object({ file: z.string() }), protocol: Protocol, initial: "idle",
			states: { idle: receive({ on: { APPLY: "bad" } }), bad: reply({ target: "idle", event: "OTHER", output: { commit: "x" } }) },
		});
		// @ts-expect-error reply output violates the READ contract
		actor({
			input: z.object({ file: z.string() }), protocol: Protocol, initial: "idle",
			states: { idle: receive({ on: { READ: "bad" } }), bad: reply({ target: "idle", output: { text: 42 } }) },
		});
		// @ts-expect-error a receive workflow must be able to reach a reply
		actor({
			input: z.object({ file: z.string() }), protocol: Protocol, initial: "idle",
			states: { idle: receive({ on: { READ: "loop" } }), loop: { kind: "state", action: agent("reader"), transitions: { DONE: "loop" } } },
		});
		// @ts-expect-error shared reply has ambiguous message reachability
		actor({
			input: z.object({ file: z.string() }), protocol: Protocol, initial: "idle",
			states: { idle: receive({ on: { APPLY: "shared", READ: "shared" } }), shared: reply({ target: "idle", output: { text: "x" } }) },
		});
		// @ts-expect-error actor input selector does not exist
		actor({
			input: z.object({ file: z.string() }), protocol: Protocol, initial: "idle",
			states: { idle: receive({ on: { READ: "work" } }), work: { kind: "state", action: agent("reader", { task: t`${actorInput("missing")}` }), transitions: { DONE: "settle" } }, settle: reply({ target: "idle", output: { text: "x" } }) },
		});
		// @ts-expect-error messageInput does not match the message context reaching work
		actor({
			input: z.object({ file: z.string() }), protocol: Protocol, initial: "idle",
			states: { idle: receive({ on: { READ: "work" } }), work: { kind: "state", action: agent("reader", { task: t`${messageInput("APPLY", "patch")}` }), transitions: { DONE: "settle" } }, settle: reply({ target: "idle", output: { text: "x" } }) },
		});
		// @ts-expect-error actor-local result cannot read a parent state
		actor({
			input: z.object({ file: z.string() }), protocol: Protocol, initial: "idle",
			states: { idle: receive({ on: { READ: "settle" } }), settle: reply({ target: "idle", output: { text: untypedResult("parent", "text") } }) },
		});
		// @ts-expect-error actor-local artifact cannot read a parent state
		actor({
			input: z.object({ file: z.string() }), protocol: Protocol, initial: "idle",
			states: { idle: receive({ on: { READ: "work" } }), work: { kind: "state", action: agent("reader", { reads: [untypedArtifactOf("parent", { artifact: "doc" })] }), transitions: { DONE: "settle" } }, settle: reply({ target: "idle", output: { text: "x" } }) },
		});
		// @ts-expect-error FAILED is reserved in actor transitions
		actor({
			input: z.object({ file: z.string() }), protocol: Protocol, initial: "idle",
			states: { idle: receive({ on: { READ: "work" } }), work: { kind: "state", action: agent("reader"), transitions: { FAILED: "settle" } }, settle: reply({ target: "idle", output: { text: "x" } }) },
		});
	});
});
