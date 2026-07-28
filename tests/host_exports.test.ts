import { describe, expect, it } from "vitest";
import { final, inspectChartAst, normalizeChartConfig } from "../packages/hyperchart/src/index.js";
import {
	hyperchartRunFromInfo,
	hyperchartRunFromInspectResult,
	type HyperchartHostAdapter,
	type HyperchartInfo,
	type HyperchartRunInfo,
	type HyperchartSessionSnapshot,
	type HyperchartSummaryInfo,
} from "../packages/hyperchart/src/host/index.js";

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
	(<Value>() => Value extends Right ? 1 : 2) ? true : false;

const summaryKeysAreLightweight: Equal<
	keyof HyperchartSummaryInfo,
	"name" | "description" | "scope" | "source" | "stateCount" | "updatedAt"
> = true;

describe("host public surface", () => {
	it("whitelists only lightweight chart summary metadata", () => {
		expect(summaryKeysAreLightweight).toBe(true);
	});

	it("projects launch argument metadata from static inspection without treating it as runtime args", () => {
		const parsed = normalizeChartConfig({
			kind: "chart",
			id: "launchable",
			args: { topic: { description: "Research subject", default: "Hyperchart" } },
			initial: "done",
			states: { done: final() },
		});
		if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));

		const inspect = inspectChartAst(parsed.ast);
		const run = hyperchartRunFromInspectResult(inspect);

		expect(inspect.args).toEqual({ topic: { description: "Research subject", default: "Hyperchart" } });
		expect(run.launchArgs).toEqual(inspect.args);
		expect(run.args).toEqual({});
		expect(JSON.parse(JSON.stringify(run.launchArgs))).toEqual(run.launchArgs);
	});

	it("creates an inspector run from a canonical chart definition without React", () => {
		const chart: HyperchartInfo = {
			name: "sample",
			description: "sample.chart.ts",
			scope: "project",
			source: "/tmp/project/.pi/hypercharts/sample.chart.ts",
			args: { topic: { description: "Research subject", default: "Hyperchart" } },
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
			launchArgs: chart.args,
			args: {},
			states: chart.states,
			stateCount: 1,
		});
	});

	it("defines a harness-neutral snapshot adapter contract", async () => {
		const snapshot: HyperchartSessionSnapshot = { hypercharts: [], runs: [] };
		const adapter: HyperchartHostAdapter = {
			readSessionSnapshot: async () => snapshot,
			readChartSnapshot: async () => undefined,
			readRunSnapshot: async () => undefined,
		};

		await expect(adapter.readSessionSnapshot("/workspace", { runLimit: 10 })).resolves.toBe(snapshot);
		await expect(adapter.readChartSnapshot("/workspace", "chart-1")).resolves.toBeUndefined();
		await expect(adapter.readRunSnapshot("/workspace", "run-1")).resolves.toBeUndefined();
	});
});
