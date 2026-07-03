import { describe, expect, it } from "vitest";
import { arg as untypedArg, json, refs, result as untypedResult, t } from "../src/index.js";

type Args = { topic: string; goal: string };

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
