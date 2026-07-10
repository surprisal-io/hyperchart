import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseChartModule } from "../src/index.js";
import { selectChartModuleExport } from "../src/core/parser.js";

const examplePath = fileURLToPath(new URL("../examples/api/review.chart.ts", import.meta.url));

describe("parseChartModule", () => {
	it("unwraps nested default exports produced by a Jiti register loader", () => {
		const chart = { kind: "chart", id: "smoke", initial: "done", states: { done: { kind: "final" } } };

		expect(selectChartModuleExport({ default: { default: chart } }, "default")).toBe(chart);
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
