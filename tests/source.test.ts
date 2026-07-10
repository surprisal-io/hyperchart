import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agent, chart, final, script } from "../src/core/dsl.js";
import { normalizeChartConfig } from "../src/core/normalize.js";
import { hyperchartSource } from "../src/core/source.js";

function sourceForScript() {
	const parsed = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "script-source",
			initial: "run",
			states: {
				run: {
					kind: "state",
					action: script("echo", [], { env: { FOO: "bar" } }),
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		}),
	);
	if (!parsed.ok) throw new Error("expected valid chart");
	return hyperchartSource(parsed.ast);
}

describe("hyperchart source", () => {
	it("keeps the positional args slot when script options exist without args", () => {
		const source = sourceForScript();
		expect(source).toMatch(/script\("echo", \[\], \{\s+env:/);
		expect(source).toContain('FOO: "bar"');
	});

	it("preserves common JSON Schema constraints in generated Zod definitions", () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "schema-source",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: agent("worker", {
							reply: z.object({
								score: z.number().min(5).max(10).multipleOf(0.5),
								slug: z
									.string()
									.min(3)
									.max(20)
									.regex(/^[a-z]+$/),
								tags: z.array(z.string()).min(1).max(3),
							}),
						}),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) throw new Error("expected valid chart");
		const source = hyperchartSource(parsed.ast);
		expect(source).toContain("z.number().min(5).max(10).multipleOf(0.5)");
		expect(source).toContain('z.string().min(3).max(20).regex(new RegExp("^[a-z]+$"))');
		expect(source).toContain("z.array(z.string()).min(1).max(3)");
	});
});
