import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeChartConfig, start } from "../packages/hyperchart/src/index.js";
import { agent, arg, chart, final, map } from "../packages/hyperchart/src/core/dsl.js";
import type { ChartAst, ChartCst, DurableLogRecord } from "../packages/hyperchart/src/index.js";
import { ChartRuntime } from "../packages/hyperchart/src/runtime/generic/chart_runtime.js";
import { JsonlLogStore, MemoryLogStore } from "../packages/hyperchart/src/runtime/generic/log_store.js";
import { FakeAgentExecutor } from "./fake_agent_executor.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hyperchart-runtime-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function make(config: ChartCst): ChartAst {
	const result = normalizeChartConfig(config);
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.ast;
}

function linearChart(): ChartAst {
	return make(
		chart({
			kind: "chart",
			id: "runtime-linear",
			initial: "work",
			states: {
				work: { kind: "state", action: agent("worker"), transitions: { DONE: "done" } },
				done: final(),
			},
		}),
	);
}

function timedChart(): ChartAst {
	return make(
		chart({
			kind: "chart",
			id: "runtime-timed",
			initial: "work",
			states: {
				work: {
					kind: "state",
					action: agent("worker"),
					after: { delayMs: 1, target: "timeout" },
					transitions: { DONE: "done" },
				},
				done: final(),
				timeout: final(),
			},
		}),
	);
}

function fanoutChart(): ChartAst {
	return make(
		chart({
			kind: "chart",
			id: "runtime-map",
			initial: "fanout",
			states: {
				fanout: map({
					over: arg("items"),
					initial: "work",
					onDone: "done",
					states: {
						work: { kind: "state", action: agent("worker"), transitions: { OK: "done" } },
						done: final(),
					},
				}),
				done: final(),
			},
		}),
	);
}

function invokeRecords(log: readonly DurableLogRecord[]) {
	return log.filter((record) => record.type === "state_action" && record.kind === "invoke");
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timed out waiting for runtime")), 1000);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

describe("ChartRuntime", () => {
	it("runs a linear agent chart through the real execution loop", async () => {
		const executor = new FakeAgentExecutor({ work: [{ type: "DONE", output: { ok: true } }] });
		const store = new MemoryLogStore();
		const runtime = new ChartRuntime({
			ast: linearChart(),
			logStore: store,
			agentExecutor: executor,
			workDir: process.cwd(),
			chartDir: process.cwd(),
		});

		const state = await withTimeout(start(runtime));

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(state.projection.results.work).toEqual({ ok: true });
		expect(executor.starts).toHaveLength(1);
		expect(invokeRecords(await store.readAll())).toHaveLength(1);
	});

	it("runs map fan-out instances", async () => {
		const executor = new FakeAgentExecutor({
			"fanout#0.work": [{ type: "OK" }],
			"fanout#1.work": [{ type: "OK" }],
		});
		const runtime = new ChartRuntime({
			ast: fanoutChart(),
			logStore: new MemoryLogStore(),
			agentExecutor: executor,
			workDir: process.cwd(),
			chartDir: process.cwd(),
		});

		const state = await withTimeout(start(runtime, { items: ["a", "b"] }));

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(executor.starts.map((effect) => effect.actionUid.state).sort()).toEqual(["fanout#0.work", "fanout#1.work"]);
	});

	it("fires timers and cancels the timed-out action", async () => {
		const executor = new FakeAgentExecutor({ work: [undefined] });
		const runtime = new ChartRuntime({
			ast: timedChart(),
			logStore: new MemoryLogStore(),
			agentExecutor: executor,
			workDir: process.cwd(),
			chartDir: process.cwd(),
			now: () => Number.POSITIVE_INFINITY,
		});

		const state = await withTimeout(start(runtime));

		expect(state.projection.activeLeaves).toEqual(["timeout"]);
		expect(executor.cancels).toHaveLength(1);
		expect(executor.cancels[0]?.state).toBe("work");
	});

	it("resumes unfinished work from a durable log without duplicating invoke records", async () => {
		const ast = linearChart();
		const dir = await makeTempDir();
		const logStore = new JsonlLogStore(join(dir, "log.jsonl"));
		const firstExecutor = new FakeAgentExecutor({ work: [undefined] });
		const firstRuntime = new ChartRuntime({
			ast,
			logStore,
			agentExecutor: firstExecutor,
			workDir: dir,
			chartDir: dir,
		});
		const firstRun = start(firstRuntime).catch(() => undefined);
		await firstExecutor.waitForStart();
		await firstRuntime.dispose();
		await firstRun;

		const secondExecutor = new FakeAgentExecutor({ work: [{ type: "DONE" }] });
		const secondRuntime = new ChartRuntime({
			ast,
			logStore,
			agentExecutor: secondExecutor,
			workDir: dir,
			chartDir: dir,
		});

		const state = await withTimeout(start(secondRuntime));

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(secondExecutor.starts).toHaveLength(1);
		expect(secondExecutor.starts[0]?.id).toBe(firstExecutor.starts[0]?.id);
		expect(invokeRecords(await logStore.readAll())).toHaveLength(1);
	});
});
