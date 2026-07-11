import { describe, expect, it } from "vitest";
import { agent, final, json, map, refs, t, z } from "../packages/hyperchart/src/index.js";
import { arg as untypedArg, event as untypedEvent, result as untypedResult } from "../packages/hyperchart/src/core/dsl.js";

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
