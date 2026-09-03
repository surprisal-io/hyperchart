import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HyperchartInspectorDialog } from "../packages/hyperchart/src/react/HyperchartInspectorDialog.js";
import { HyperchartInspectorSidePanel } from "../packages/hyperchart/src/react/components/inspector/HyperchartInspectorSidePanel.js";
import type { HyperchartRunInfo } from "../packages/hyperchart/src/react/types.js";

const run: HyperchartRunInfo = {
	runId: "layout-run",
	branchId: "main",	chartName: "layout",
	status: "running",
	cwd: "/workspace",
	createdAt: 1,
	updatedAt: 2,
	args: {},
	states: [{ id: "done", type: "final", status: "done", final: true }],
	stateCount: 1,
};

describe("HyperchartInspectorDialog desktop layout", () => {
	it("places the side panel in an explicit second column without a responsive cascade dependency", () => {
		const markup = renderToStaticMarkup(
			createElement(HyperchartInspectorDialog, {
				runs: [run],
				onClose: () => {},
				portal: (children) => children,
			}),
		);

		expect(markup).toContain("grid-cols-[minmax(0,1fr)_390px]");
		expect(markup).not.toContain("lg:grid-cols-[minmax(0,1fr)_390px]");
		expect(markup).toContain("border-r");
		expect(markup).not.toContain("lg:border-r");
		expect(markup).toContain("visibility:visible");
		expect(markup).not.toContain("visibility:hidden");
	});

	it("reserves space for the side panel scrollbar instead of overlaying detail cards", () => {
		const markup = renderToStaticMarkup(createElement(HyperchartInspectorSidePanel, { run }));

		expect(markup).toContain("padding-right:1.5rem");
		expect(markup).toContain("scrollbar-gutter:stable");
		expect(markup).not.toContain("pr-6");
	});
});
