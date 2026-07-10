import { describe, expect, it } from "vitest";
import type { HyperchartRunInfo } from "../src/react/types.js";
import {
	buildGraph,
	GRAPH_COMPACT_NODE_HEIGHT,
	GRAPH_COMPACT_NODE_WIDTH,
	graphLayoutSignature,
} from "../src/react/components/inspector/graph/graphModel.js";

function run(status: "pending" | "running" | "done", target = "done"): HyperchartRunInfo {
	return {
		runId: "layout-run",
		chartName: "layout",
		status: status === "done" ? "completed" : "running",
		cwd: "/workspace",
		createdAt: 1,
		updatedAt: status === "pending" ? 2 : 3,
		args: {},
		states: [
			{
				id: "work",
				type: "script",
				status,
				...(status === "pending" ? {} : { startedAt: 10 }),
				...(status === "running" ? { subProgress: { done: 1, total: 2, running: 1, failed: 0 } } : {}),
				attempts: status === "pending" ? 0 : 1,
				transitions: [{ event: "DONE", target }],
			},
			{ id: "done", type: "final", status: status === "done" ? "done" : "pending", final: true },
			{ id: "failed", type: "final", status: "pending", final: true },
		],
		stateCount: 3,
	};
}

describe("graph nodes", () => {
	it("declare fixed dimensions so controlled updates never hide nodes for remeasurement", () => {
		const graph = buildGraph(run("running"), new Set(["work", "done"]));

		expect(graph.nodes).toHaveLength(2);
		for (const node of graph.nodes) {
			expect(node.width).toBe(GRAPH_COMPACT_NODE_WIDTH);
			expect(node.height).toBe(GRAPH_COMPACT_NODE_HEIGHT);
		}
	});
});

describe("graphLayoutSignature", () => {
	it("stays stable when only live state presentation changes", () => {
		const pending = run("pending");
		const running = run("running");
		const done = run("done");
		const visible = new Set(["work", "done"]);

		expect(graphLayoutSignature(running, visible)).toBe(graphLayoutSignature(pending, visible));
		expect(graphLayoutSignature(done, visible)).toBe(graphLayoutSignature(pending, visible));
	});

	it("changes when graph topology or visibility changes", () => {
		const original = run("running");
		const changedTransition = run("running", "work");

		expect(graphLayoutSignature(changedTransition, new Set(["work", "done"]))).not.toBe(
			graphLayoutSignature(original, new Set(["work", "done"])),
		);
		expect(graphLayoutSignature(original, new Set(["work"]))).not.toBe(
			graphLayoutSignature(original, new Set(["work", "done"])),
		);
	});
});
