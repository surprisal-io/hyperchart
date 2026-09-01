import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { artifact, artifactOf, agent, chart, failed, final, normalizeChartConfig, script, start, z } from "../packages/hyperchart/src/index.js";
import type { ChartAst, ChartCst, DurableLogRecord } from "../packages/hyperchart/src/index.js";
import type { ArtifactPin } from "../packages/hyperchart/src/core/durable_events.js";
import { explainReplay } from "../packages/hyperchart/src/core/replay_check.js";
import { inspectChartAst } from "../packages/hyperchart/src/core/inspect_ast.js";
import { hyperchartRunFromRuntime } from "../packages/hyperchart/src/host/adapters.js";
import { ArtifactStore } from "../packages/hyperchart/src/runtime/generic/artifact_store.js";
import { ChartRuntime } from "../packages/hyperchart/src/runtime/generic/chart_runtime.js";
import { MemoryLogStore } from "../packages/hyperchart/src/runtime/generic/memory_log_store.js";
import { FakeAgentExecutor } from "./fake_agent_executor.js";

const node = process.execPath;
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hyperchart-artifact-pins-"));
	tempDirs.push(dir);
	return dir;
}

function make(config: ChartCst): ChartAst {
	const result = normalizeChartConfig(config);
	if (!result.ok) throw new Error(result.diagnostics.map((entry) => entry.message).join("\n"));
	return result.ast;
}

function scriptChart(): ChartAst {
	return make(chart({
		kind: "chart", id: "pins-script", initial: "work",
		states: {
			work: {
				kind: "state",
				action: script(node, ["-e", 'require("node:fs").writeFileSync("report.json", JSON.stringify({ok:true})); console.log(JSON.stringify({type:"DONE"}))'], {
					artifacts: { report: artifact("report.json", z.object({ ok: z.boolean() })) },
				}),
				transitions: { DONE: "done" },
			},
			done: final(),
			failed: failed(),
		},
	}));
}

function agentChart(): ChartAst {
	return make(chart({
		kind: "chart", id: "pins-agent", initial: "work",
		states: {
			work: {
				kind: "state",
				action: agent("worker", { artifacts: { report: artifact("report.json") } }),
				transitions: { DONE: "done" },
			},
			done: final(),
			failed: failed(),
		},
	}));
}

type Options = { runDir?: string; executor?: FakeAgentExecutor; logStore?: MemoryLogStore };

async function run(ast: ChartAst, workDir: string, options: Options = {}) {
	const logStore = options.logStore ?? new MemoryLogStore();
	const runtime = new ChartRuntime({
		ast,
		branchId: "main",
		logStore,
		agentExecutor: options.executor ?? new FakeAgentExecutor(),
		workDir,
		chartDir: workDir,
		...(options.runDir === undefined ? {} : { runDir: options.runDir }),
	});
	try {
		const state = await start(runtime);
		return { state, log: await logStore.readAncestry(logStore.branchId) };
	} finally {
		await runtime.dispose();
	}
}

function completeRecord(log: readonly DurableLogRecord[]) {
	const record = log.find((entry) => entry.type === "state_action" && entry.kind === "complete");
	if (record?.type !== "state_action" || record.kind !== "complete") throw new Error("no complete record");
	return record;
}

describe("artifact pins", () => {
	it("pins accepted script deliverables into the completion fact and the store", async () => {
		const workDir = await tempDir();
		const runDir = join(workDir, "run");
		const ast = scriptChart();

		const { state, log } = await run(ast, workDir, { runDir });

		expect(state.projection.activeLeaves).toEqual(["done"]);
		const record = completeRecord(log);
		const pin = record.artifacts?.["report.json"] as ArtifactPin;
		expect(pin).toBeDefined();
		const content = await readFile(join(workDir, "report.json"), "utf8");
		expect(pin.hash).toBe(createHash("sha256").update(content).digest("hex"));
		expect(pin.size).toBe(Buffer.byteLength(content));
		const store = new ArtifactStore(runDir);
		expect(await readFile(await store.get(pin.hash), "utf8")).toBe(content);
		expect(explainReplay(ast, log).unpinned).toEqual([]);
	});

	it("exposes pins on the host runtime view as visit artifactPins", async () => {
		const workDir = await tempDir();
		const runDir = join(workDir, "run");
		const ast = scriptChart();

		const { log } = await run(ast, workDir, { runDir });

		const runInfo = hyperchartRunFromRuntime(inspectChartAst(ast), ast, log);
		const work = runInfo.states.find((state) => state.id === "work");
		const pins = work?.visitHistory?.[0]?.artifactPins;
		expect(pins).toHaveLength(1);
		expect(pins?.[0]?.path).toBe("report.json");
		expect(pins?.[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(pins?.[0]?.size).toBeGreaterThan(0);
	});

	it("admits completions unpinned without a run directory and reports the diagnostic", async () => {
		const workDir = await tempDir();
		const ast = scriptChart();

		const { state, log } = await run(ast, workDir);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		const record = completeRecord(log);
		expect(record.artifacts).toBeUndefined();
		const explanation = explainReplay(ast, log);
		expect(explanation.unpinned).toHaveLength(1);
		expect(explanation.unpinned[0]?.state).toBe("work");
	});

	it("fails admission when a declared deliverable is missing at snapshot time", async () => {
		const workDir = await tempDir();
		const runDir = join(workDir, "run");
		const executor = new FakeAgentExecutor({ work: [{ type: "DONE" }] });

		const { log } = await run(agentChart(), workDir, { runDir, executor });

		expect(log.some((record) => record.type === "failure_intent")).toBe(true);
		expect(log.some((record) => record.type === "state_action" && record.kind === "complete")).toBe(false);
	});

	it("pins agent deliverables snapshotted at admission", async () => {
		const workDir = await tempDir();
		const runDir = join(workDir, "run");
		await writeFile(join(workDir, "report.json"), "agent report");
		const executor = new FakeAgentExecutor({ work: [{ type: "DONE" }] });

		const { state, log } = await run(agentChart(), workDir, { runDir, executor });

		expect(state.projection.activeLeaves).toEqual(["done"]);
		const pin = completeRecord(log).artifacts?.["report.json"] as ArtifactPin;
		expect(pin.hash).toBe(createHash("sha256").update("agent report").digest("hex"));
	});

	it("restores a pinned read overwritten between runs to its accepted revision", async () => {
		const workDir = await tempDir();
		const runDir = join(workDir, "run");
		const logStore = new MemoryLogStore();
		const { state: first } = await run(scriptChart(), workDir, { runDir, logStore });
		expect(first.projection.activeLeaves).toEqual(["done"]);
		const accepted = await readFile(join(workDir, "report.json"), "utf8");

		await writeFile(join(workDir, "report.json"), "overwritten by a sibling branch");

		const resumed = make(chart({
			kind: "chart", id: "pins-script", initial: "work",
			states: {
				work: {
					kind: "state",
					action: script(node, ["-e", 'require("node:fs").writeFileSync("report.json", JSON.stringify({ok:true})); console.log(JSON.stringify({type:"DONE"}))'], {
						artifacts: { report: artifact("report.json", z.object({ ok: z.boolean() })) },
					}),
					transitions: { DONE: "consume" },
				},
				consume: {
					kind: "state",
					action: agent("reader", { reads: [artifactOf("work")] }),
					transitions: { DONE: "done" },
				},
				done: final(),
				failed: failed(),
			},
		}));
		const executor = new FakeAgentExecutor({ consume: [{ type: "DONE" }] });
		const { state } = await run(resumed, workDir, { runDir, logStore, executor });

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(await readFile(join(workDir, "report.json"), "utf8")).toBe(accepted);
	});

	it("fails action entry when the pinned object is missing from the store", async () => {
		const workDir = await tempDir();
		const runDir = join(workDir, "run");
		const logStore = new MemoryLogStore();
		await run(scriptChart(), workDir, { runDir, logStore });
		await writeFile(join(workDir, "report.json"), "overwritten");
		await rm(join(runDir, "artifact_store"), { recursive: true, force: true });

		const resumed = make(chart({
			kind: "chart", id: "pins-script", initial: "work",
			states: {
				work: {
					kind: "state",
					action: script(node, ["-e", 'require("node:fs").writeFileSync("report.json", JSON.stringify({ok:true})); console.log(JSON.stringify({type:"DONE"}))'], {
						artifacts: { report: artifact("report.json", z.object({ ok: z.boolean() })) },
					}),
					transitions: { DONE: "consume" },
				},
				consume: {
					kind: "state",
					action: agent("reader", { reads: [artifactOf("work")] }),
					transitions: { DONE: "done" },
				},
				done: final(),
				failed: failed(),
			},
		}));
		const executor = new FakeAgentExecutor({ consume: [{ type: "DONE" }] });
		const { log } = await run(resumed, workDir, { runDir, logStore, executor });

		expect(log.some((record) => record.type === "failure_intent")).toBe(true);
		expect(await readFile(join(workDir, "report.json"), "utf8")).toBe("overwritten");
	});

	it("keeps current-file semantics for reads of unpinned legacy completions", async () => {
		const workDir = await tempDir();
		const runDir = join(workDir, "run");
		const logStore = new MemoryLogStore();
		// Producer ran on a runtime without an artifact store: its completion is unpinned.
		await run(scriptChart(), workDir, { logStore });
		await writeFile(join(workDir, "report.json"), "edited out of band");

		const resumed = make(chart({
			kind: "chart", id: "pins-script", initial: "work",
			states: {
				work: {
					kind: "state",
					action: script(node, ["-e", 'require("node:fs").writeFileSync("report.json", JSON.stringify({ok:true})); console.log(JSON.stringify({type:"DONE"}))'], {
						artifacts: { report: artifact("report.json", z.object({ ok: z.boolean() })) },
					}),
					transitions: { DONE: "consume" },
				},
				consume: {
					kind: "state",
					action: agent("reader", { reads: [artifactOf("work")] }),
					transitions: { DONE: "done" },
				},
				done: final(),
				failed: failed(),
			},
		}));
		const executor = new FakeAgentExecutor({ consume: [{ type: "DONE" }] });
		const { state } = await run(resumed, workDir, { runDir, logStore, executor });

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(await readFile(join(workDir, "report.json"), "utf8")).toBe("edited out of band");
	});

	it("rejects a snapshot whose stored bytes do not match the declared shape", async () => {
		const workDir = await tempDir();
		const runDir = join(workDir, "run");
		const ast = make(chart({
			kind: "chart", id: "pins-shape", initial: "work",
			states: {
				work: {
					kind: "state",
					action: agent("worker", { artifacts: { report: artifact("report.json", z.object({ ok: z.boolean() })) } }),
					transitions: { DONE: "done" },
				},
				done: final(),
				failed: failed(),
			},
		}));
		await writeFile(join(workDir, "report.json"), "not json");
		const executor = new FakeAgentExecutor({ work: [{ type: "DONE" }] });

		const { log } = await run(ast, workDir, { runDir, executor });

		expect(log.some((record) => record.type === "failure_intent")).toBe(true);
	});
});
