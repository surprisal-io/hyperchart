import { describe, expect, it } from "vitest";
import { withSamplingParams } from "../packages/pi-hyperchart/src/runtime/pi/sampling_params.js";

describe("per-invocation sampling parameters", () => {
	it("sets the parameters at the top level of the request and keeps the rest", () => {
		const payload = { model: "m", messages: [{ role: "user", content: "hi" }], tools: [] };
		expect(withSamplingParams(payload, { temperature: 0, top_p: 0.9 })).toEqual({
			...payload,
			temperature: 0,
			top_p: 0.9,
		});
	});

	it("replaces a value the model or Pi already put into the request", () => {
		expect(withSamplingParams({ model: "m", temperature: 1 }, { temperature: 0 })).toEqual({
			model: "m",
			temperature: 0,
		});
	});

	it("leaves a payload that is not a request object unchanged", () => {
		expect(withSamplingParams(undefined, { temperature: 0 })).toBeUndefined();
		expect(withSamplingParams("raw", { temperature: 0 })).toBeUndefined();
		expect(withSamplingParams([], { temperature: 0 })).toBeUndefined();
	});
});
