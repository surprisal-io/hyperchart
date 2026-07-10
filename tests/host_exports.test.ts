import { describe, expect, it } from "vitest";
import {
	hyperchartRunFromInfo,
	type HyperchartHostAdapter,
	type HyperchartInfo,
	type HyperchartRunInfo,
	type HyperchartSessionSnapshot,
} from "../src/host/index.js";

describe("host public surface", () => {
	it("creates an inspector run from a canonical chart definition without React", () => {
		const chart: HyperchartInfo = {
			name: "sample",
			description: "sample.chart.ts",
			scope: "project",
			source: "/tmp/project/.pi/hypercharts/sample.chart.ts",
			states: [{ id: "work", type: "agent", status: "pending" }],
			stateCount: 1,
			updatedAt: 10,
		};

		const run: HyperchartRunInfo | undefined = hyperchartRunFromInfo(chart, { cwd: "/tmp/project" });

		expect(run).toMatchObject({
			runId: "chart:sample",
			chartName: "sample",
			mode: "static",
			cwd: "/tmp/project",
			states: chart.states,
			stateCount: 1,
		});
	});

	it("defines a harness-neutral snapshot adapter contract", async () => {
		const snapshot: HyperchartSessionSnapshot = { hypercharts: [], runs: [] };
		const adapter: HyperchartHostAdapter = {
			readSessionSnapshot: async () => snapshot,
		};

		await expect(adapter.readSessionSnapshot("/workspace", { runLimit: 10 })).resolves.toBe(snapshot);
	});
});
