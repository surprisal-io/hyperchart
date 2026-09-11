import {
	withRunStorage,
	resolveRunPaths,
	type RunStorage,
} from "../packages/hyperchart/src/runtime/generic/run_paths.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	agent,
	artifact,
	artifactOf,
	chart,
	final,
	normalizeChartConfig,
	script,
} from "../packages/hyperchart/src/index.js";
import { createBranchProjection, projectBranch } from "../packages/hyperchart/src/core/projection.js";
import { BranchExecution } from "../packages/hyperchart/src/execution/branch_execution.js";
import { ArtifactStore } from "../packages/hyperchart/src/runtime/generic/artifact_store.js";
import { materializeWorkspaceFromPins } from "../packages/hyperchart/src/runtime/generic/artifact_workspace.js";
import { ChartRuntime } from "../packages/hyperchart/src/runtime/generic/chart_runtime.js";
import { JsonlLogStore } from "../packages/hyperchart/src/runtime/generic/log_store.js";
import { FakeAgentExecutor } from "./fake_agent_executor.js";
import { start } from "./helpers/execution.js";
import { collectHistoryRecords } from "./helpers/history.js";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it.each([
	{ mode: "nudge", budget: 3 },
	{ mode: "restart", budget: 3 },
] as const)("requires local completion when forking validating artifacts with $mode recovery and budget=$budget", async ({
	mode,
	budget,
}) => {
	const directory = await mkdtemp(join(tmpdir(), "provisional-fork-"));
	directories.push(directory);
	const runId = "run";
	const storage: RunStorage = { kind: "jsonl", rootDir: directory, layout: "sha256" };
	const runDir = resolveRunPaths(runId, storage).runDir;
	const normalized = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "provisional-fork",
			initial: "seed",
			states: {
				seed: {
					kind: "state",
					action: script(
						process.execPath,
						["-e", 'require("node:fs").writeFileSync("notes.md", "A"); console.log(JSON.stringify({type:"DONE"}))'],
						{ artifacts: { notes: artifact("notes.md") } },
					),
					transitions: { DONE: "work" },
				},
				work: {
					kind: "state",
					action: agent("worker", {
						artifacts: { notes: artifact("notes.md") },
						validation: {
							guard: script(process.execPath, [
								"-e",
								'let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>process.exit(JSON.parse(s).output.accept ? 0 : 1));',
							]),
							onFail: mode === "restart" ? { nudge: 0, restart: budget } : { nudge: budget, restart: 0 },
						},
					}),
					transitions: { DONE: "read" },
				},
				read: {
					kind: "state",
					action: script(
						process.execPath,
						[
							"-e",
							'console.log(JSON.stringify({type:"DONE",output:{bytes:require("node:fs").readFileSync(process.env.NOTES,"utf8")}}))',
						],
						{ env: { NOTES: artifactOf("work", { artifact: "notes" }) } },
					),
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		}),
	);
	if (!normalized.ok) throw new Error(JSON.stringify(normalized.diagnostics));
	const ast = normalized.ast;
	const store = new JsonlLogStore(join(directory, "journal.jsonl"));
	await store.initializeRootBranch();
	const executor = new FakeAgentExecutor({
		work: [
			{ type: "DONE", output: { accept: false, result: "B" } },
			{ type: "DONE", output: { accept: true, result: "C" } },
		],
	});
	const sourceStart = executor.start.bind(executor);
	executor.start = (effect, emit) => {
		writeFileSync(join(directory, "notes.md"), effect.recovery === undefined ? "B" : "C");
		sourceStart(effect, emit);
	};
	const source = withRunStorage(
		storage,
		() =>
			new ChartRuntime({
				ast,
				branchId: "main",
				logStore: store,
				agentExecutor: executor,
				workDir: directory,
				chartDir: directory,
				runId,
			}),
	);
	try {
		await start(source);
	} finally {
		await source.dispose();
	}
	const records = await collectHistoryRecords(store, "main");
	const completion = records.find(
		(record) => record.type === "state_action" && record.kind === "complete" && record.actionUid.state === "work",
	);
	const _rejection = records.find(
		(record) => record.type === "state_action" && record.kind === "validated" && record.outcome !== true,
	);
	if (!completion) throw new Error("Source completion missing");
	const forkPoint = completion;
	const validating = projectBranch(
		createBranchProjection(ast),
		ast,
		records.filter((record) => record.seqId <= completion.seqId),
	);
	const verdict = records.find(
		(record) => record.type === "state_action" && record.kind === "validated" && record.outcome === true,
	);
	if (!verdict) throw new Error("Source verdict missing");
	await store.createBranch("fork", forkPoint.seqId, { sourceBranchId: "main", sourceSeqId: forkPoint.seqId });
	const forkStore = store.forBranch("fork");
	const semantic = await BranchExecution.restore({ ast, branchId: "fork", store: forkStore });
	const workspace = join(directory, "fork");
	await materializeWorkspaceFromPins(semantic.workspaceArtifactPins(), new ArtifactStore(runDir), workspace);
	expect(await readFile(join(workspace, "notes.md"), "utf8")).toBe("A");
	const local = new FakeAgentExecutor({ work: [{ type: "DONE", output: { accept: true, result: "B-local" } }] });
	const localStart = local.start.bind(local);
	local.start = (effect, emit) => {
		expect(effect.recovery?.failure.message).toContain("fresh branch-local completion");
		writeFileSync(join(workspace, "notes.md"), "B-local");
		localStart(effect, emit);
	};
	const runtime = withRunStorage(
		storage,
		() =>
			new ChartRuntime({
				ast,
				branchId: "fork",
				logStore: forkStore,
				agentExecutor: local,
				workDir: workspace,
				chartDir: directory,
				runId,
			}),
	);
	try {
		const result = await start(runtime);
		expect(result.projection.results.read).toEqual({ bytes: "B-local" });
		expect(result.projection.results.work).toEqual({ accept: true, result: "B-local" });
		expect(local.starts).toHaveLength(1);
		const pin = result.projection.artifactPins["notes.md"]!;
		expect(await readFile(await new ArtifactStore(runDir).get(pin.hash), "utf8")).toBe("B-local");
		const forkRecords = await collectHistoryRecords(forkStore, "fork");
		expect(projectBranch(createBranchProjection(ast), ast, forkRecords).results.read).toEqual({ bytes: "B-local" });
	} finally {
		await runtime.dispose();
	}
	expect(() => projectBranch(validating, ast, [{ ...verdict, branchId: "fork" }])).toThrow("branch-local completion");
}, 15_000);
