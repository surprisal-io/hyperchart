import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agent, artifact, artifactOf, chart, failed, final, result, script, t } from "../packages/hyperchart/src/core/dsl.js";
import { normalizeChartConfig } from "../packages/hyperchart/src/core/normalize.js";
import { hyperchartSource } from "../packages/hyperchart/src/core/source.js";

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
	it("prints chart argument metadata in generated definition source", () => {
		const parsed = normalizeChartConfig(chart({
			kind: "chart",
			id: "argument-source",
			args: { topic: { description: "Research subject", default: "Hyperchart" } },
			initial: "done",
			states: { done: final() },
		}));
		if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));

		const source = hyperchartSource(parsed.ast);
		expect(source).toContain("args: {");
		expect(source).toContain('description: "Research subject"');
		expect(source).toContain('default: "Hyperchart"');
	});

	it("keeps the positional args slot when script options exist without args", () => {
		const source = sourceForScript();
		expect(source).toMatch(/script\("echo", \[\], \{\s+env:/);
		expect(source).toContain('FOO: "bar"');
	});

	it("prints complete and failed terminals with notification options", () => {
		const parsed = normalizeChartConfig(chart({
			kind: "chart",
			id: "terminal-source",
			initial: "work",
			states: {
				work: { kind: "state", action: agent("worker", { artifacts: { report: artifact("report.txt") } }), transitions: { DONE: "done", FAILED: "failed" } },
				done: final(),
				failed: failed({ notify: { prompt: t`Failure ${result("work")}`, artifacts: [artifactOf("work", { artifact: "report" })], scope: "work" } }),
			},
		}));
		if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
		const source = hyperchartSource(parsed.ast);
		expect(source).toContain("done: final()");
		expect(source).toContain("failed: failed({");
		expect(source).toContain('scope: "work"');
		expect(source).toContain('artifactOf("work", {');
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
