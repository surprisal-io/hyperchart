import { describe, expect, it } from "vitest";
import deckDirector from "../examples/deck-director.chart.js";
import { normalizeChartConfig } from "../src/index.js";

describe("examples", () => {
	it("deck-director chart normalizes cleanly", () => {
		const result = normalizeChartConfig(deckDirector);

		expect(result.diagnostics).toEqual([]);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected valid chart");
		// The bucket regions materialized under the parallel with absolute paths.
		expect(result.ast.states["research.official.scout"]?.kind).toBe("state");
	});
});
