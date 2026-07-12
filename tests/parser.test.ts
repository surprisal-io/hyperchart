import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseChartModule, parseChartModuleSync } from "../packages/hyperchart/src/index.js";
import { selectChartModuleExport } from "../packages/hyperchart/src/core/parser.js";

const examplePath = fileURLToPath(new URL("../examples/api/review.chart.ts", import.meta.url));

describe("parseChartModule", () => {
	it("unwraps nested default exports produced by a Jiti register loader", () => {
		const chart = { kind: "chart", id: "smoke", initial: "done", states: { done: { kind: "final" } } };

		expect(selectChartModuleExport({ default: { default: chart } }, "default")).toBe(chart);
	});

	it("loads scoped package imports from a chart bundle outside the package tree", () => {
		const dir = mkdtempSync(join(tmpdir(), "hyperchart-bundle-parser-"));
		const path = join(dir, "chart.ts");
		try {
			writeFileSync(path, [
				'import { final, refs } from "@surprisal/hyperchart";',
				'const { chart } = refs<Record<string, never>, Record<string, never>>();',
				'export default chart({ id: "bundled", initial: "done", states: { done: final() } });',
			].join("\n"));
			const result = parseChartModuleSync(path);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.ast.id).toBe("bundled");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads a trusted local TS chart module and returns a normalized AST", async () => {
		const result = await parseChartModule(examplePath);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected parser success");
		expect(result.source.path).toBe(examplePath);
		expect(result.ast.id).toBe("review-and-fix");
		expect(result.ast.states.research?.kind).toBe("state");
		expect(result.ast).toMatchSnapshot();
	});
});
