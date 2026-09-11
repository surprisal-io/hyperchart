import { expect, it } from "vitest";
import { ActionVisitReentry } from "../packages/hyperchart/src/react/stories/InspectorDialog.stories.js";
import { actorReentryRun } from "../packages/hyperchart/src/react/fixtures/actor-fixtures.js";
import { embeddedActionVisitRows } from "../packages/hyperchart/src/react/components/inspector/helpers/actionVisits.js";
import { executionGraph } from "../packages/hyperchart/src/react/components/inspector/history/ActionVisitGraph.js";

it("keeps each completed and current invocation distinct in the dialog story's execution graph", () => {
	const args = ActionVisitReentry.args;
	const run = args?.runs?.[0];
	if (args === undefined || run === undefined) {
		throw new Error("Re-entry story must supply a captured run");
	}
	expect(run).toBe(actorReentryRun);
	expect(args.selectedRunId).toBe(run.runId);
	const rows = embeddedActionVisitRows(run);
	const repeated = rows.filter((row) => row.statePath === "between");
	expect(repeated.map((row) => row.visit?.status)).toEqual(["done", "done", "running"]);
	expect(new Set(repeated.map((row) => row.invokeSeqId)).size).toBe(3);

	const graph = executionGraph(run, rows);
	for (const row of repeated) {
		expect(graph.nodes.filter((node) => node.id === `visit-${row.invokeSeqId}`)).toHaveLength(1);
		expect(graph.nodes.find((node) => node.id === `visit-${row.invokeSeqId}`)).toMatchObject({
			type: "hyperchartState",
			data: { state: { status: row.visit?.status } },
		});
	}
});
