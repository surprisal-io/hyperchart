import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HyperchartRunStrip } from "../packages/hyperchart/src/react/HyperchartRunStrip.js";
import { MoreHyperchartsDialog } from "../packages/hyperchart/src/react/components/run-strip/MoreHyperchartsDialog.js";
import type {
	HyperchartRunInfo,
	HyperchartRunSummaryInfo,
	HyperchartSessionSnapshot,
	HyperchartSummaryInfo,
} from "../packages/hyperchart/src/react/types.js";

const chart: HyperchartSummaryInfo = {
	name: "release",
	description: "Release chart",
	scope: "project",
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

	it("accepts the canonical session snapshot chart summary when stateCount is omitted", () => {
		const snapshot: HyperchartSessionSnapshot = {
			hypercharts: [chart],
			runs: [
				{
					runId: "summary-run",
					chartName: "release",
					status: "running",
					cwd: "/workspace",
					createdAt: 1,
					updatedAt: 2,
					stateCount: 20,
					progressDone: 3,
					progressTotal: 10,
					progressPercent: 30,
					activeState: "deploy",
					activeStateCount: 4,
				},
			],
		};
		const markup = renderToStaticMarkup(createElement(HyperchartRunStrip, snapshot));

		expect(markup).toContain('role="progressbar"');
		expect(markup).toContain("width:30%");
		expect(markup).toContain("running: deploy +3");
	});

	it("renders a canonical chart summary in the More dialog when stateCount is omitted", () => {
		const markup = renderToStaticMarkup(
			createElement(MoreHyperchartsDialog, {
				hypercharts: [chart],
				runs: [],
				onSelectRun: () => undefined,
				onClose: () => undefined,
			}),
		);

		expect(markup).toContain("Start chart");
		expect(markup).toContain(chart.name);
	});

	it("hides progress when summary progress metadata is omitted but keeps known running state", () => {
		const summary: HyperchartRunSummaryInfo = {
			runId: "no-progress",
			chartName: "release",
			status: "running",
			cwd: "/workspace",
			createdAt: 1,
			updatedAt: 2,
			activeState: "deploy",
		};
		const markup = renderToStaticMarkup(createElement(HyperchartRunStrip, { hypercharts: [chart], runs: [summary] }));

		expect(markup).not.toContain('role="progressbar"');
		expect(markup).toContain(">running</span>");
		expect(markup).toContain("running: deploy");
	});

	it("hides progress when summary progress metadata is only partial", () => {
		const summary: HyperchartRunSummaryInfo = {
			runId: "partial-progress",
			chartName: "release",
			status: "blocked",
			cwd: "/workspace",
			createdAt: 1,
			updatedAt: 2,
			progressPercent: 42,
		};
		const markup = renderToStaticMarkup(createElement(HyperchartRunStrip, { hypercharts: [chart], runs: [summary] }));

		expect(markup).not.toContain('role="progressbar"');
		expect(markup).not.toContain("width:42%");
		expect(markup).toContain(">blocked</span>");
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
