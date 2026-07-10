import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HyperchartRunStrip } from "../src/react/HyperchartRunStrip.js";
import type { HyperchartInfo, HyperchartRunInfo } from "../src/react/types.js";

const chart: HyperchartInfo = {
	name: "release",
	description: "Release chart",
	scope: "project",
	stateCount: 1,
};

function run(index: number): HyperchartRunInfo {
	return {
		runId: `run-${index}`,
		chartName: chart.name,
		status: "completed",
		cwd: "/workspace",
		createdAt: index,
		updatedAt: index,
		args: {},
		states: [],
		stateCount: 0,
	};
}

describe("HyperchartRunStrip", () => {
	it("stays hidden until the directory has a run", () => {
		const markup = renderToStaticMarkup(createElement(HyperchartRunStrip, { hypercharts: [chart], runs: [] }));

		expect(markup).toBe("");
	});

	it("labels chart actions as Run instead of overflow", () => {
		const markup = renderToStaticMarkup(
			createElement(HyperchartRunStrip, { hypercharts: [chart], runs: [run(1)] }),
		);

		expect(markup).toContain("Run…");
		expect(markup).not.toContain("More (1)");
	});

	it("counts only hidden runs in More", () => {
		const markup = renderToStaticMarkup(
			createElement(HyperchartRunStrip, {
				hypercharts: [chart],
				runs: Array.from({ length: 6 }, (_, index) => run(index)),
			}),
		);

		expect(markup).toContain("More (1)");
		expect(markup).not.toContain("More (2)");
	});
});
