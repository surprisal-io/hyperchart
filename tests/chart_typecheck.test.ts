import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintChartModuleSource, preflightChartModule, typecheckChartModule } from "../src/runtime/pi/chart_typecheck.js";

describe("chart preflight", () => {
	it("passes valid TypeScript chart modules", async () => {
		const result = await preflightChartModule("examples/api/review.chart.ts");
		expect(result.ok).toBe(true);
	});

	it("reports TypeScript diagnostics before runtime loads a chart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hyperchart-typecheck-"));
		const chartPath = join(dir, "bad.chart.ts");
		writeFileSync(
			chartPath,
			`import { refs } from "${process.cwd().replaceAll("\\", "/")}/src/index.js";\n\nconst { chart, result } = refs();\n\nexport default chart({\n\tkind: "chart",\n\tid: "bad",\n\tinitial: "start",\n\tstates: {\n\t\tstart: {\n\t\t\tkind: "state",\n\t\t\taction: { kind: "script", command: "echo", args: [result("missing", "value")] },\n\t\t\ttransitions: {},\n\t\t},\n\t},\n});\n`,
			"utf8",
		);

		const result = await typecheckChartModule(chartPath);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.diagnostics).toContain("bad.chart.ts");
			expect(result.diagnostics).toContain("parameter of type 'never'");
		}
	});

	it("lints deprecated zod passthrough and unsafe type escapes", () => {
		const dir = mkdtempSync(join(tmpdir(), "hyperchart-lint-"));
		const chartPath = join(dir, "lint.chart.ts");
		writeFileSync(
			chartPath,
			`// @ts-ignore\nconst X: any = {};\nconst Y = z.object({ value: z.string() }).passthrough();\nconst Z = value as any;\n`,
			"utf8",
		);

		const diagnostics = lintChartModuleSource(chartPath);
		expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"TS_SUPPRESSION",
			"EXPLICIT_ANY",
			"DEPRECATED_ZOD_PASSTHROUGH",
			"EXPLICIT_ANY",
		]);
	});

	it("preflight aggregates source lint failures", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hyperchart-preflight-"));
		const chartPath = join(dir, "preflight.chart.ts");
		writeFileSync(
			chartPath,
			`import { z } from "${process.cwd().replaceAll("\\", "/")}/src/index.js";\nconst Shape = z.object({ value: z.string() }).passthrough();\n`,
			"utf8",
		);

		const result = await preflightChartModule(chartPath);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.diagnostics).toContain("Chart source lint failed");
			expect(result.diagnostics).toContain("DEPRECATED_ZOD_PASSTHROUGH");
		}
	});
});
