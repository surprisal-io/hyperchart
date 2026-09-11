import { describe, expect, it } from "vitest";
import type { HyperchartRunInfo } from "../packages/hyperchart/src/react/types.js";
import { executionGraph } from "../packages/hyperchart/src/react/components/inspector/history/ActionVisitGraph.js";
import type { ActionVisitRow } from "../packages/hyperchart/src/react/components/inspector/helpers/actionVisits.js";

function row(invokeSeqId: number, statePath: string, graphStateId: string): ActionVisitRow {
	return { invokeSeqId, statePath, graphStateId, originBranchId: "main" };
}

const run = {
	runId: "execution-hierarchy",
	branchId: "main",
	status: "completed",
	updatedAt: 1,
	states: [
		{ id: "before", status: "done" },
		{ id: "samples", type: "map", status: "done", mapConfig: { visitHistory: [{ visit: 1, spawnSeqId: 1, startedAt: 1, itemCount: 2, status: "done" }] } },
		{ id: "samples#0.sample", scopeParentId: "samples#0", status: "done" },
		{ id: "samples#0.persist", scopeParentId: "samples#0", status: "done" },
		{ id: "samples#1.sample", scopeParentId: "samples#1", status: "done" },
		{ id: "samples#1.persist", scopeParentId: "samples#1", status: "done" },
		{ id: "after", status: "done" },
	],
} as unknown as HyperchartRunInfo;

describe("hierarchical execution graph", () => {
	it("keeps map actions inside parallel worker lanes and preserves top-level order", () => {
		const graph = executionGraph(run, [
			row(1, "before", "before"),
			row(2, "samples#0.sample", "samples#0.sample"),
			row(3, "samples#1.sample", "samples#1.sample"),
			row(4, "samples#0.persist", "samples#0.persist"),
			row(5, "samples#1.persist", "samples#1.persist"),
			row(6, "after", "after"),
		]);
		const actionNodes = graph.nodes.filter((node) => node.type === "hyperchartState");
		expect(actionNodes).not.toHaveLength(0);
		expect(actionNodes.every((node) => node.width === 270 && node.height === 118)).toBe(true);
		expect(actionNodes.every((node) => node.style?.width === 270 && node.style?.height === 118)).toBe(true);
		expect(actionNodes.every((node) => node.handles?.some((handle) => handle.id === "target-top" && handle.x === 135 && handle.y === 0))).toBe(true);
		expect(actionNodes.every((node) => node.handles?.some((handle) => handle.id === "source-bottom" && handle.x === 135 && handle.y === 118))).toBe(true);
		expect(graph.nodes.every((node) => node.width === node.style?.width && node.height === node.style?.height)).toBe(true);
		const mapNode = graph.nodes.find((node) => node.type === "mapVisitGroup");
		expect(mapNode?.data).toEqual({ state: expect.objectContaining({ id: "samples", type: "map" }), stateId: "samples", targetSeqId: 1 });
		expect(mapNode?.selectable).not.toBe(false);
		const workers = graph.nodes.filter((node) => node.type === "workerLane");
		expect(workers).toHaveLength(2);
		expect(workers.every((node) => node.parentId === mapNode?.id)).toBe(true);
		expect(graph.nodes.find((node) => node.id === "visit-2")?.parentId).toBe(workers[0]?.id);
		expect(graph.nodes.find((node) => node.id === "visit-3")?.parentId).toBe(workers[1]?.id);
		expect(graph.edges).toEqual(expect.arrayContaining([
			expect.objectContaining({ source: "visit-1", target: "visit-2", type: "smoothstep" }),
			expect.objectContaining({ source: "visit-1", target: "visit-3" }),
			expect.objectContaining({ source: "visit-2", target: "visit-4", type: "straight" }),
			expect.objectContaining({ source: "visit-3", target: "visit-5", type: "straight" }),
			expect.objectContaining({ source: "visit-4", target: "visit-6", type: "smoothstep" }),
			expect.objectContaining({ source: "visit-5", target: "visit-6" }),
		]));
	});

	it("keeps parallel-region actions inside the authored parallel container", () => {
		const parallelRun = {
			...run,
			states: [
				{ id: "before", status: "done" },
				{ id: "fanout", type: "parallel", status: "running" },
				{ id: "fanout.left", type: "region", scopeParentId: "fanout", status: "running" },
				{ id: "fanout.left.fetch", scopeParentId: "fanout.left", status: "done" },
				{ id: "fanout.left.review", scopeParentId: "fanout.left", status: "running" },
				{ id: "fanout.right", type: "region", scopeParentId: "fanout", status: "running" },
				{ id: "fanout.right.fetch", scopeParentId: "fanout.right", status: "done" },
				{ id: "after", status: "pending" },
			],
		} as unknown as HyperchartRunInfo;
		const graph = executionGraph(parallelRun, [
			row(1, "before", "before"),
			row(2, "fanout.left.fetch", "fanout.left.fetch"),
			row(3, "fanout.right.fetch", "fanout.right.fetch"),
			row(4, "fanout.left.review", "fanout.left.review"),
			row(5, "after", "after"),
		]);
		const parallel = graph.nodes.find((node) => node.id === "parallel-visit-fanout-1-2");
		expect(parallel?.data).toEqual({ state: expect.objectContaining({ id: "fanout", type: "parallel" }), stateId: "fanout" });
		const regions = graph.nodes.filter((node) => node.type === "workerLane");
		expect(regions).toHaveLength(2);
		expect(regions.map((node) => ("label" in node.data ? node.data.label : undefined))).toEqual(["left", "right"]);
		expect(graph.nodes.find((node) => node.id === "visit-4")?.parentId).toBe(regions[0]?.id);
	});

	it("groups actor-internal action visits under their real actor occurrence", () => {
		const actorRun = {
			...run,
			states: [
				{ id: "dispatch", type: "sendBatch", status: "done" },
				{ id: "@worker", type: "actor-occurrence", status: "waiting" },
				{ id: "@worker.process", type: "agent", scopeParentId: "@worker", status: "done" },
				{ id: "publish", type: "agent", status: "running" },
			],
		} as unknown as HyperchartRunInfo;
		const graph = executionGraph(actorRun, [
			row(2, "@worker.process", "@worker.process"),
			row(4, "@worker.process", "@worker.process"),
			row(6, "publish", "publish"),
		]);
		const actor = graph.nodes.find((node) => node.id === "actor-visit-@worker-1-2");
		expect(actor?.data).toEqual({ state: expect.objectContaining({ id: "@worker", type: "actor-occurrence" }), stateId: "@worker" });
		expect(graph.nodes.filter((node) => node.parentId === actor?.id)).toHaveLength(2);
		expect(graph.nodes.filter((node) => node.type === "workerLane")).toHaveLength(0);
	});

	it("creates a new map container when the same map is revisited", () => {
		const graph = executionGraph(run, [
			row(2, "samples#0.sample", "samples#0.sample"),
			row(3, "samples#0.persist", "samples#0.persist"),
			row(6, "after", "after"),
			row(8, "samples#0.sample", "samples#0.sample"),
		]);
		const maps = graph.nodes.filter((node) => node.type === "mapVisitGroup");
		expect(maps).toHaveLength(2);
		expect(maps.map((node) => node.id)).toEqual([
			"map-visit-samples-1-2",
			"map-visit-samples-2-8",
		]);
	});
});
