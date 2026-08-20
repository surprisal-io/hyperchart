import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintChartModuleSource, preflightChartModule, typecheckChartModule } from "../packages/hyperchart/src/runtime/generic/chart_typecheck.js";

describe("chart preflight", () => {
	it("passes valid TypeScript chart modules", async () => {
		const result = await preflightChartModule("examples/api/review.chart.ts");
		expect(result.ok).toBe(true);
	});

	it("resolves bundled Node types for charts outside the project tree", async () => {
		const originalCwd = process.cwd();
		const dir = mkdtempSync(join(tmpdir(), "hyperchart-external-typecheck-"));
		const chartPath = join(dir, "external.chart.ts");
		writeFileSync(
			chartPath,
			'import { refs } from "@surprisal/hyperchart";\nconst pid: number = process.pid;\nconst timer: NodeJS.Timeout | undefined = undefined;\nexport default { pid, timer, refs };\n',
			"utf8",
		);

		process.chdir(dir);
		try {
			const result = await typecheckChartModule(chartPath);
			expect(result.ok).toBe(true);
		} finally {
			process.chdir(originalCwd);
		}
	});

	it("reports TypeScript diagnostics before runtime loads a chart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hyperchart-typecheck-"));
		const chartPath = join(dir, "bad.chart.ts");
		writeFileSync(
			chartPath,
			`import { refs } from "${process.cwd().replaceAll("\\", "/")}/packages/hyperchart/src/index.js";\n\nconst { chart, result } = refs();\n\nexport default chart({\n\tkind: "chart",\n\tid: "bad",\n\tinitial: "start",\n\tstates: {\n\t\tstart: {\n\t\t\tkind: "state",\n\t\t\taction: { kind: "script", command: "echo", args: [result("missing", "value")] },\n\t\t\ttransitions: {},\n\t\t},\n\t},\n});\n`,
			"utf8",
		);

		const result = await typecheckChartModule(chartPath);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.diagnostics).toContain("bad.chart.ts");
			expect(result.diagnostics).toContain("parameter of type 'never'");
		}
	});

	it("explains that omitted artifact schemas infer unknown in typed registries", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hyperchart-registry-guidance-"));
		const chartPath = join(dir, "registry-guidance.chart.ts");
		writeFileSync(
			chartPath,
			`import { refs } from "@surprisal/hyperchart";\nconst { chart } = refs<Record<string, never>, Record<string, never>, { work: { report: string } }>();\nexport default chart({\n\tkind: "chart",\n\tid: "registry-guidance",\n\tinitial: "work",\n\tstates: {\n\t\twork: { kind: "state", action: { kind: "script", command: "echo", artifacts: { report: "report.txt" } }, transitions: { DONE: "done" } },\n\t\tdone: { kind: "final" },\n\t},\n});\n`,
			"utf8",
		);

		const result = await preflightChartModule(chartPath);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.diagnostics).toContain("files registry is out of sync with the chart");
			expect(result.diagnostics).toContain("omitted schema is inferred as unknown");
			expect(result.diagnostics).toContain("Declare the artifact schema");
		}
	});

	it("explains how action reply schemas populate the results registry", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hyperchart-results-guidance-"));
		const chartPath = join(dir, "results-guidance.chart.ts");
		writeFileSync(
			chartPath,
			`import { refs } from "@surprisal/hyperchart";\nconst { chart } = refs<Record<string, never>, { work: string }>();\nexport default chart({\n\tkind: "chart",\n\tid: "results-guidance",\n\tinitial: "work",\n\tstates: {\n\t\twork: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } },\n\t\tdone: { kind: "final" },\n\t},\n});\n`,
			"utf8",
		);

		const result = await preflightChartModule(chartPath);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.diagnostics).toContain("results registry is out of sync with the chart");
			expect(result.diagnostics).toContain("actions that declare a reply schema");
			expect(result.diagnostics).toContain("remove the state from the results registry");
		}
	});

	it("explains that untyped map sources infer unknown item types", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hyperchart-maps-guidance-"));
		const chartPath = join(dir, "maps-guidance.chart.ts");
		writeFileSync(
			chartPath,
			`import { refs } from "@surprisal/hyperchart";\nconst { chart } = refs<Record<string, never>, Record<string, never>, Record<never, Record<string, unknown>>, { research: string }>();\nexport default chart({\n\tkind: "chart",\n\tid: "maps-guidance",\n\tinitial: "research",\n\tstates: {\n\t\tresearch: { kind: "map", over: { kind: "result", state: "source" }, initial: "done", onDone: "done", states: { done: { kind: "final" } } },\n\t\tdone: { kind: "final" },\n\t},\n});\n`,
			"utf8",
		);

		const result = await preflightChartModule(chartPath);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.diagnostics).toContain("maps registry is out of sync with the chart");
			expect(result.diagnostics).toContain("untyped source is inferred as unknown");
			expect(result.diagnostics).toContain("declare its schema");
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
			`import { z } from "${process.cwd().replaceAll("\\", "/")}/packages/hyperchart/src/index.js";\nconst Shape = z.object({ value: z.string() }).passthrough();\n`,
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
