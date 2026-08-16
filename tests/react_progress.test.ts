import { describe, expect, it } from "vitest";
import type { HyperchartRunInfo, HyperchartStateInfo } from "../packages/hyperchart/src/host/models.js";
import { summarizeHyperchartProgress } from "../packages/hyperchart/src/react/hyperchart-display.js";

function state(id: string, status: HyperchartStateInfo["status"], options: Partial<HyperchartStateInfo> = {}): HyperchartStateInfo {
	return { id, status, ...options };
}

function run(states: HyperchartStateInfo[], status: HyperchartRunInfo["status"] = "running"): HyperchartRunInfo {
	return {
		runId: "run-1",
		branchId: "main",		chartName: "review",
		status,
		cwd: "/project",
		createdAt: 1,
		updatedAt: 2,
		args: {},
		states,
		stateCount: states.length,
	};
}

describe("Hyperchart path progress", () => {
	it("combines the completed actual path with the shortest remaining path", () => {
		const progress = summarizeHyperchartProgress(run([
			state("prepare", "done", { endedAt: 10, transitions: [{ event: "READY", target: "review" }] }),
			state("review", "running", {
				startedAt: 20,
				transitions: [
					{ event: "SHORT", target: "done" },
					{ event: "LONG", target: "revise" },
				],
			}),
			state("revise", "pending", { transitions: [{ event: "REVISED", target: "done" }] }),
			state("done", "pending", { final: true }),
		]));

		expect(progress).toEqual({ done: 1, total: 2, pct: 50 });
	});

	it("continues from a nested map-instance final to the whole-chart final", () => {
		const progress = summarizeHyperchartProgress(run([
			state("prepare", "done", { endedAt: 10, transitions: [{ event: "READY", target: "research" }] }),
			state("research", "running", {
				type: "map",
				transitions: [{ event: "onDone", target: "synthesize" }],
			}),
			state("research#official.done", "done", { final: true }),
			state("research#market.scout", "running", {
				startedAt: 20,
				transitions: [{ event: "SCOUTED", target: "research#market.done" }],
			}),
			state("research#market.done", "pending", { final: true }),
			state("synthesize", "pending", { transitions: [{ event: "DONE", target: "done" }] }),
			state("done", "pending", { final: true }),
		]));

		expect(progress).toEqual({ done: 1, total: 4, pct: 25 });
	});

	it("enters downstream compounds instead of skipping directly through their onDone or failure transitions", () => {
		const progress = summarizeHyperchartProgress(run([
			state("pipeline", "running", {
				type: "compound",
				transitions: [{ event: "onDone", target: "plan" }],
			}),
			state("pipeline.review", "running", {
				startedAt: 20,
				transitions: [{ event: "APPROVE", target: "pipeline.done" }],
			}),
			state("pipeline.done", "pending", { final: true }),
			state("plan", "pending", {
				type: "compound",
				transitions: [
					{ event: "FAILED", target: "failed" },
					{ event: "onDone", target: "done" },
				],
			}),
			state("plan.first", "pending", {
				initial: true,
				transitions: [{ event: "READY", target: "plan.done" }],
			}),
			state("plan.done", "pending", { final: true }),
			state("done", "pending", { final: true }),
			state("failed", "pending", { final: true }),
		]));

		expect(progress).toEqual({ done: 0, total: 4, pct: 0 });
	});

	it("does not double-count completed compound, parallel, or region containers as action visits", () => {
		const progress = summarizeHyperchartProgress(run([
			state("research.scout", "done", {
				type: "agent",
				endedAt: 10,
				transitions: [{ event: "DONE", target: "research.region.done" }],
			}),
			state("research.region.done", "done", { final: true }),
			state("research.region", "done", { type: "region" }),
			state("research", "done", { type: "parallel" }),
			state("write", "running", {
				type: "agent",
				startedAt: 20,
				transitions: [{ event: "DONE", target: "done" }],
			}),
			state("done", "pending", { final: true }),
		]));

		expect(progress).toEqual({ done: 1, total: 2, pct: 50 });
	});

	it("reports full progress whenever the run reaches a final outcome", () => {
		const states = [
			state("work", "done", { transitions: [{ event: "DONE", target: "done" }] }),
			state("done", "done", { final: true }),
			state("failed", "skipped", { final: true }),
		];

		expect(summarizeHyperchartProgress(run(states, "completed")).pct).toBe(100);
	});

	it("does not treat unvisited alternative final states as incomplete work", () => {
		const states = [
			state("work", "done", { transitions: [{ event: "FAILED", target: "failed" }] }),
			state("done", "skipped", { final: true }),
			state("failed", "done", { final: true }),
		];

		expect(summarizeHyperchartProgress(run(states, "failed")).pct).toBe(100);
	});
});
