import { withRunStorage, resolveRunPaths } from "../packages/hyperchart/src/runtime/generic/run_paths.js";
import { collectHistoryRecords } from "./helpers/history.js";
import { writeFileSync } from "node:fs";
import { BranchExecution } from "../packages/hyperchart/src/execution/branch_execution.js";
import { createBranchProjection, projectBranch } from "../packages/hyperchart/src/core/projection.js";
import {
	decodeCheckpoint,
	prepareProjectionCheckpoint,
	projectionContractForAst,
} from "../packages/hyperchart/src/execution/projection_restore.js";
import { materializeWorkspaceFromPins } from "../packages/hyperchart/src/runtime/generic/artifact_workspace.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { start } from "./helpers/execution.js";
import {
	artifact,
	artifactOf,
	agent,
	chart,
	failed,
	final,
	normalizeChartConfig,
	script,
	z,
} from "../packages/hyperchart/src/index.js";
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
	if (!result.ok) {
		throw new Error(result.diagnostics.map((entry) => entry.message).join("\n"));
	}
	return result.ast;
}

function scriptChart(): ChartAst {
	return make(
		chart({
			kind: "chart",
			id: "pins-script",
			initial: "work",
			states: {
				work: {
					kind: "state",
					action: script(
						node,
						[
							"-e",
							'require("node:fs").writeFileSync("report.json", JSON.stringify({ok:true})); console.log(JSON.stringify({type:"DONE"}))',
						],
						{
							artifacts: { report: artifact("report.json", z.object({ ok: z.boolean() })) },
						},
					),
					transitions: { DONE: "done" },
				},
				done: final(),
				failed: failed(),
			},
		}),
	);
}

function agentChart(): ChartAst {
	return make(
		chart({
			kind: "chart",
			id: "pins-agent",
			initial: "work",
			states: {
				work: {
					kind: "state",
					action: agent("worker", { artifacts: { report: artifact("report.json") } }),
					transitions: { DONE: "done" },
				},
				done: final(),
				failed: failed(),
			},
		}),
	);
}

type Options = { runId?: string; executor?: FakeAgentExecutor; logStore?: MemoryLogStore };

async function run(ast: ChartAst, workDir: string, options: Options = {}) {
	const logStore = options.logStore ?? new MemoryLogStore();
	const runtime = withRunStorage(
		{ kind: "jsonl", rootDir: workDir, layout: "sha256" },
		() =>
			new ChartRuntime({
				ast,
				branchId: "main",
				logStore,
				agentExecutor: options.executor ?? new FakeAgentExecutor(),
				workDir,
				chartDir: workDir,
				...(options.runId === undefined ? {} : { runId: options.runId }),
			}),
	);
	try {
		const state = await start(runtime);
		return { state, log: await collectHistoryRecords(logStore, logStore.branchId) };
	} finally {
		await runtime.dispose();
	}
}

function completeRecord(log: readonly DurableLogRecord[]) {
	const record = log.find((entry) => entry.type === "state_action" && entry.kind === "complete");
	if (record?.type !== "state_action" || record.kind !== "complete") {
		throw new Error("no complete record");
	}
	return record;
}

describe("artifact pins", () => {
	it("keeps rejected completion pins provisional through checkpoint recovery and fork isolation", async () => {
		const workDir = await tempDir();
		const runId = "run";
		const runDir = resolveRunPaths(runId, { kind: "jsonl", rootDir: workDir, layout: "sha256" }).runDir;
		const ast = make(
			chart({
				kind: "chart",
				id: "guarded-pins",
				initial: "seed",
				states: {
					seed: {
						kind: "state",
						action: script(
							node,
							[
								"-e",
								'require("node:fs").writeFileSync("notes.md", "accepted parent"); console.log(JSON.stringify({type:"DONE"}))',
							],
							{ artifacts: { notes: artifact("notes.md") } },
						),
						transitions: { DONE: "work" },
					},
					work: {
						kind: "state",
						action: agent("worker", {
							artifacts: { notes: artifact("notes.md") },
							validation: {
								guard: script(
									node,
									[
										"-e",
										'let s=""; process.stdin.on("data", c => s+=c); process.stdin.on("end", () => { require("node:fs").writeFileSync("diagnostic.txt", "guard ran"); process.exit(JSON.parse(s).output.accept ? 0 : 1); });',
									],
									{
										artifacts: { diagnostic: artifact("diagnostic.txt") },
										env: { SELF: artifactOf("work", { artifact: "notes" }) },
									},
								),
							},
						}),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
		);
		const executor = new FakeAgentExecutor({
			work: [
				{ type: "DONE", output: { accept: false } },
				{ type: "DONE", output: { accept: true } },
			],
		});
		const start = executor.start.bind(executor);
		executor.start = (effect, emit) => {
			writeFileSync(
				join(workDir, "notes.md"),
				effect.recovery === undefined ? "rejected bytes" : "accepted correction",
			);
			start(effect, emit);
		};
		const { state, log } = await run(ast, workDir, { runId, executor });
		const completions = log.filter(
			(entry): entry is Extract<DurableLogRecord, { type: "state_action"; kind: "complete" }> =>
				entry.type === "state_action" && entry.kind === "complete",
		);
		const parentPin = completions[0]?.artifacts?.["notes.md"];
		const rejectedPin = completions[1]?.artifacts?.["notes.md"];
		const acceptedPin = completions[2]?.artifacts?.["notes.md"];
		if (parentPin === undefined || rejectedPin === undefined || acceptedPin === undefined) {
			throw new Error("missing artifact pins");
		}
		const rejection = log.findIndex(
			(entry) => entry.type === "state_action" && entry.kind === "validated" && entry.outcome !== true,
		);
		for (const end of [log.indexOf(completions[1]!) + 1, rejection + 1]) {
			const projection = projectBranch(createBranchProjection(ast), ast, log.slice(0, end));
			const same = BranchExecution.fromProjection(ast, "main", projection);
			expect(same.artifactPins()).toEqual({ "notes.md": parentPin });
			expect(same.workspaceArtifactPins()).toEqual({ "notes.md": rejectedPin });
			const checkpoint = prepareProjectionCheckpoint(projection, projectionContractForAst(ast));
			const decoded = decodeCheckpoint(checkpoint, ast)!;
			expect(decoded.projection).toEqual(projection);
			const fork = BranchExecution.fromProjection(ast, "sibling", decoded.projection);
			expect(fork.workspaceArtifactPins()).toEqual({ "notes.md": parentPin });
			const recovery = join(workDir, `recovery-${end}`);
			const sibling = join(workDir, `sibling-${end}`);
			const store = new ArtifactStore(runDir);
			await materializeWorkspaceFromPins(same.workspaceArtifactPins(), store, recovery);
			await materializeWorkspaceFromPins(fork.workspaceArtifactPins(), store, sibling);
			expect(await readFile(join(recovery, "notes.md"), "utf8")).toBe("rejected bytes");
			expect(await readFile(join(sibling, "notes.md"), "utf8")).toBe("accepted parent");
		}
		expect(state.projection.artifactPins).toEqual({ "notes.md": acceptedPin });
		expect(state.projection.artifactPins["diagnostic.txt"]).toBeUndefined();
		expect(explainReplay(ast, log).stale).toEqual([]);
		expect(projectBranch(createBranchProjection(ast), ast, log).artifactPins).toEqual(state.projection.artifactPins);
	});

	it("pins accepted script deliverables into the completion fact and the store", async () => {
		const workDir = await tempDir();
		const runId = "run";
		const runDir = resolveRunPaths(runId, { kind: "jsonl", rootDir: workDir, layout: "sha256" }).runDir;
		const ast = scriptChart();

		const { state, log } = await run(ast, workDir, { runId });

		expect(state.projection.activeLeaves).toEqual(["done"]);
		const record = completeRecord(log);
		const pin = record.artifacts?.["report.json"] as ArtifactPin;
		expect(pin).toBeDefined();
		const content = await readFile(join(workDir, "report.json"), "utf8");
		expect(pin.hash).toBe(createHash("sha256").update(content).digest("hex"));
		expect(pin.size).toBe(Buffer.byteLength(content));
		expect(state.projection.artifactPins["report.json"]).toEqual(pin);
		const store = new ArtifactStore(runDir);
		expect(await readFile(await store.get(pin.hash), "utf8")).toBe(content);
		expect(explainReplay(ast, log).unpinned).toEqual([]);
	});

	it("exposes pins on the host runtime view as visit artifactPins", async () => {
		const workDir = await tempDir();
		const runId = "run";
		const _runDir = resolveRunPaths(runId, { kind: "jsonl", rootDir: workDir, layout: "sha256" }).runDir;
		const ast = scriptChart();

		const { log } = await run(ast, workDir, { runId });

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
		const runId = "run";
		const _runDir = resolveRunPaths(runId, { kind: "jsonl", rootDir: workDir, layout: "sha256" }).runDir;
		const executor = new FakeAgentExecutor({ work: [{ type: "DONE" }] });

		const { log } = await run(agentChart(), workDir, { runId, executor });

		expect(log.some((record) => record.type === "failure_intent")).toBe(true);
		expect(log.some((record) => record.type === "state_action" && record.kind === "complete")).toBe(false);
	});

	it("pins agent deliverables snapshotted at admission", async () => {
		const workDir = await tempDir();
		const runId = "run";
		const _runDir = resolveRunPaths(runId, { kind: "jsonl", rootDir: workDir, layout: "sha256" }).runDir;
		await writeFile(join(workDir, "report.json"), "agent report");
		const executor = new FakeAgentExecutor({ work: [{ type: "DONE" }] });

		const { state, log } = await run(agentChart(), workDir, { runId, executor });

		expect(state.projection.activeLeaves).toEqual(["done"]);
		const pin = completeRecord(log).artifacts?.["report.json"] as ArtifactPin;
		expect(pin.hash).toBe(createHash("sha256").update("agent report").digest("hex"));
	});

	it("restores a pinned read overwritten between runs to its accepted revision", async () => {
		const workDir = await tempDir();
		const runId = "run";
		const _runDir = resolveRunPaths(runId, { kind: "jsonl", rootDir: workDir, layout: "sha256" }).runDir;
		const logStore = new MemoryLogStore();
		const { state: first } = await run(scriptChart(), workDir, { runId, logStore });
		expect(first.projection.activeLeaves).toEqual(["done"]);
		const accepted = await readFile(join(workDir, "report.json"), "utf8");

		await writeFile(join(workDir, "report.json"), "overwritten by a sibling branch");

		const resumed = make(
			chart({
				kind: "chart",
				id: "pins-script",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: script(
							node,
							[
								"-e",
								'require("node:fs").writeFileSync("report.json", JSON.stringify({ok:true})); console.log(JSON.stringify({type:"DONE"}))',
							],
							{
								artifacts: { report: artifact("report.json", z.object({ ok: z.boolean() })) },
							},
						),
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
			}),
		);
		const executor = new FakeAgentExecutor({ consume: [{ type: "DONE" }] });
		const { state } = await run(resumed, workDir, { runId, logStore, executor });

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(await readFile(join(workDir, "report.json"), "utf8")).toBe(accepted);
	});

	it("fails action entry when the pinned object is missing from the store", async () => {
		const workDir = await tempDir();
		const runId = "run";
		const runDir = resolveRunPaths(runId, { kind: "jsonl", rootDir: workDir, layout: "sha256" }).runDir;
		const logStore = new MemoryLogStore();
		await run(scriptChart(), workDir, { runId, logStore });
		await writeFile(join(workDir, "report.json"), "overwritten");
		await rm(join(runDir, "artifact_store"), { recursive: true, force: true });

		const resumed = make(
			chart({
				kind: "chart",
				id: "pins-script",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: script(
							node,
							[
								"-e",
								'require("node:fs").writeFileSync("report.json", JSON.stringify({ok:true})); console.log(JSON.stringify({type:"DONE"}))',
							],
							{
								artifacts: { report: artifact("report.json", z.object({ ok: z.boolean() })) },
							},
						),
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
			}),
		);
		const executor = new FakeAgentExecutor({ consume: [{ type: "DONE" }] });
		const { log } = await run(resumed, workDir, { runId, logStore, executor });

		expect(log.some((record) => record.type === "failure_intent")).toBe(true);
		expect(await readFile(join(workDir, "report.json"), "utf8")).toBe("overwritten");
	});

	it("keeps current-file semantics for reads of unpinned legacy completions", async () => {
		const workDir = await tempDir();
		const runId = "run";
		const _runDir = resolveRunPaths(runId, { kind: "jsonl", rootDir: workDir, layout: "sha256" }).runDir;
		const logStore = new MemoryLogStore();
		// Producer ran on a runtime without an artifact store: its completion is unpinned.
		await run(scriptChart(), workDir, { logStore });
		await writeFile(join(workDir, "report.json"), "edited out of band");

		const resumed = make(
			chart({
				kind: "chart",
				id: "pins-script",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: script(
							node,
							[
								"-e",
								'require("node:fs").writeFileSync("report.json", JSON.stringify({ok:true})); console.log(JSON.stringify({type:"DONE"}))',
							],
							{
								artifacts: { report: artifact("report.json", z.object({ ok: z.boolean() })) },
							},
						),
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
			}),
		);
		const executor = new FakeAgentExecutor({ consume: [{ type: "DONE" }] });
		const { state } = await run(resumed, workDir, { runId, logStore, executor });

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(await readFile(join(workDir, "report.json"), "utf8")).toBe("edited out of band");
	});

	it("rejects a snapshot whose stored bytes do not match the declared shape", async () => {
		const workDir = await tempDir();
		const runId = "run";
		const _runDir = resolveRunPaths(runId, { kind: "jsonl", rootDir: workDir, layout: "sha256" }).runDir;
		const ast = make(
			chart({
				kind: "chart",
				id: "pins-shape",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: agent("worker", { artifacts: { report: artifact("report.json", z.object({ ok: z.boolean() })) } }),
						transitions: { DONE: "done" },
					},
					done: final(),
					failed: failed(),
				},
			}),
		);
		await writeFile(join(workDir, "report.json"), "not json");
		const executor = new FakeAgentExecutor({ work: [{ type: "DONE" }] });

		const { log } = await run(ast, workDir, { runId, executor });

		expect(log.some((record) => record.type === "failure_intent")).toBe(true);
	});
});
