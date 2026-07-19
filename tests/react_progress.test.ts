import { describe, expect, it } from "vitest";
import type { HyperchartRunInfo, HyperchartStateInfo } from "../packages/hyperchart/src/host/models.js";
import { summarizeHyperchartProgress } from "../packages/pi-hyperchart/src/react/hyperchart-display.js";

function state(id: string, status: HyperchartStateInfo["status"], options: Partial<HyperchartStateInfo> = {}): HyperchartStateInfo {
	return { id, status, ...options };
}

function run(states: HyperchartStateInfo[], status: HyperchartRunInfo["status"] = "running"): HyperchartRunInfo {
	return {
		runId: "run-1",
		chartName: "review",
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

	it("does not treat a completed nested map-instance final as whole-run completion", () => {
		const progress = summarizeHyperchartProgress(run([
			state("prepare", "done", { endedAt: 10, transitions: [{ event: "READY", target: "research#market.scout" }] }),
			state("research#official.done", "done", { final: true }),
			state("research#market.scout", "running", {
				startedAt: 20,
				transitions: [{ event: "SCOUTED", target: "research#market.done" }],
			}),
			state("research#market.done", "pending", { final: true }),
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
