import { describe, expect, it } from "vitest";
import type { HyperchartRunInfo } from "../packages/hyperchart/src/react/types.js";
import {
	buildGraph,
	GRAPH_COMPACT_NODE_HEIGHT,
	GRAPH_COMPACT_NODE_WIDTH,
	graphLayoutSignature,
	reconcileGraphElements,
} from "../packages/hyperchart/src/react/components/inspector/graph/graphModel.js";
import { edgeMotionPoints } from "../packages/hyperchart/src/react/components/inspector/graph/edgeRouting.js";

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
				initial: true,
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
	it("keeps fixed and measured dimensions across controlled updates", () => {
		const graph = buildGraph(run("running"), new Set(["work", "done"]));

		expect(graph.nodes).toHaveLength(2);
		for (const node of graph.nodes) {
			expect(node.width).toBe(GRAPH_COMPACT_NODE_WIDTH);
			expect(node.height).toBe(GRAPH_COMPACT_NODE_HEIGHT);
			expect(node.measured).toEqual({
				width: GRAPH_COMPACT_NODE_WIDTH,
				height: GRAPH_COMPACT_NODE_HEIGHT,
			});
		}
		expect(graph.nodes.find((node) => node.id === "work")?.data.snapshotAt).toBe(3);
		expect(graph.nodes.find((node) => node.id === "work")?.data.state.initial).toBe(true);
		expect(graph.nodes.find((node) => node.id === "done")?.data.snapshotAt).toBeUndefined();
	});

	it("reuses the complete graph when only a non-running snapshot timestamp changes", () => {
		const visible = new Set(["work", "done"]);
		const previous = buildGraph(run("pending"), visible);
		const next = buildGraph({ ...run("pending"), updatedAt: 4 }, visible);

		expect(reconcileGraphElements(previous, next)).toBe(previous);
	});

	it("reuses the complete graph when a running duration heartbeat advances", () => {
		const visible = new Set(["work", "done"]);
		const previous = buildGraph(run("running"), visible);
		const next = buildGraph({ ...run("running"), updatedAt: 4 }, visible);

		expect(reconcileGraphElements(previous, next)).toBe(previous);
	});

	it("replaces a graph node when its initial marker changes", () => {
		const visible = new Set(["work", "done"]);
		const previous = buildGraph(run("pending"), visible);
		const nextRun = run("pending");
		nextRun.states[0] = { ...nextRun.states[0]!, initial: false };
		const next = buildGraph(nextRun, visible);

		expect(reconcileGraphElements(previous, next).nodes[0]).not.toBe(previous.nodes[0]);
	});

	it("marks running transitions for a compositor marker without React Flow's SVG dash animation", () => {
		const edge = buildGraph(run("running"), new Set(["work", "done"])).edges[0];

		expect(edge?.animated).not.toBe(true);
		expect(edge?.data).toMatchObject({ running: true });
	});

	it("does not serialize non-visual unknown runtime payloads while reconciling", () => {
		const previousRun = run("running");
		previousRun.states[0] = {
			...previousRun.states[0]!,
			mapConfig: { items: [{ key: "one", label: "one", value: 1n }] },
		};
		const nextRun = run("running");
		nextRun.states[0] = {
			...nextRun.states[0]!,
			mapConfig: { items: [{ key: "one", label: "one", value: 1n }] },
		};
		const visible = new Set(["work", "done"]);
		const previous = buildGraph(previousRun, visible);
		const next = buildGraph(nextRun, visible);

		expect(reconcileGraphElements(previous, next)).toBe(previous);
	});
});

describe("edgeMotionPoints", () => {
	it("samples routed paths at stable graph-space intervals", () => {
		const points = edgeMotionPoints({
			sourceX: 0,
			sourceY: 0,
			targetX: 100,
			targetY: 100,
			routedPoints: [
				{ x: 0, y: 0 },
				{ x: 100, y: 0 },
				{ x: 100, y: 100 },
			],
			count: 5,
		});

		expect(points).toEqual([
			{ x: 0, y: 0 },
			{ x: 50, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 50 },
			{ x: 100, y: 100 },
		]);
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
