import { withRunStorage, resolveRunPaths, type RunStorage } from "../packages/hyperchart/src/runtime/generic/run_paths.js";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
	arg,
	artifact,
	artifactOf,
	chart,
	event,
	failed,
	final,
	normalizeChartConfig,
	inspectChartAst,
	result,
	t,
	tsAction,
	z,
	type ChartAst,
	type ChartCst,
	type ImportedActionEffect,
} from "../packages/hyperchart/src/index.js";
import { FunctionRunner } from "../packages/hyperchart/src/runtime/generic/function_runner.js";
import { ChartRuntime } from "../packages/hyperchart/src/runtime/generic/chart_runtime.js";
import { ArtifactStore } from "../packages/hyperchart/src/runtime/generic/artifact_store.js";
import { MemoryLogStore } from "../packages/hyperchart/src/runtime/generic/memory_log_store.js";
import { hyperchartRunFromRuntime } from "../packages/hyperchart/src/host/adapters.js";
import { FakeAgentExecutor } from "./fake_agent_executor.js";
import { start } from "./helpers/execution.js";
import { collectHistoryRecords } from "./helpers/history.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hyperchart-function-action-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function ast(config: ChartCst): ChartAst {
	const parsed = normalizeChartConfig(config);
	if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	return parsed.ast;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
	const started = Date.now();
	while (!(await predicate())) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function effect(module: string, exportName: string): ImportedActionEffect {
	const actionUid = { chart: "function-unit", state: "work", action: "tsImport" };
	const action = { kind: "tsImport" as const, uid: actionUid, module, export: exportName };
	return {
		kind: "tsImport",
		id: "function:work:1",
		actionUid,
		action,
		module,
		export: exportName,
		events: ["DONE", "FAILED"],
	};
}

describe("FunctionRunner and tsAction", () => {
	it("runs a full durable slice with resolved params/input, absolute paths, validation, and artifact pins", async () => {
		const root = await tempDir();
		const chartDir = join(root, "chart");
		const workDir = join(root, "workspace");
		const projectDir = join(root, "project");
		const runId = "run";
		const storage: RunStorage = { kind: "jsonl", rootDir: root, layout: "sha256" };
		const runDir = resolveRunPaths(runId, storage).runDir;
		await Promise.all([mkdir(chartDir), mkdir(workDir), mkdir(projectDir), mkdir(runDir)]);
		await writeFile(
			join(chartDir, "actions.mjs"),
			`import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
export async function produce(params, ctx) {
  await writeFile(ctx.artifacts.report, JSON.stringify({ ok: true, topic: params.TOPIC }));
  return { type: "DONE", output: { value: "from-result" } };
}
export async function consume(params, ctx) {
  const observed = {
    params,
    input: ctx.input,
    absolute: [ctx.chartDir, ctx.workDir, ctx.projectDir, ctx.artifacts.summary].every(isAbsolute),
    paths: { chartDir: ctx.chartDir, workDir: ctx.workDir, projectDir: ctx.projectDir, summary: ctx.artifacts.summary },
    events: ctx.events,
    action: ctx.actionUid.action,
  };
  await writeFile(ctx.artifacts.summary, JSON.stringify(observed));
  return { type: "DONE", output: { ok: true } };
}
`,
		);
		const parsed = normalizeChartConfig(chart({
			kind: "chart",
			id: "function-vertical",
			initial: "produce",
			states: {
				produce: {
					kind: "state",
					action: tsAction("./actions.mjs", "produce", {
						env: { TOPIC: t`${arg("topic")}` },
						artifacts: { report: artifact("report.json", z.object({ ok: z.boolean(), topic: z.string() })) },
						reply: z.object({ value: z.string() }),
					}),
					transitions: { DONE: { target: "consume", input: { review: event("value") } } },
				},
				consume: {
					kind: "state",
					input: { review: z.string() },
					action: tsAction("./actions.mjs", "consume", {
						env: {
							RESULT: t`${result("produce", "value")}`,
							REPORT_OK: artifactOf("produce", { artifact: "report", select: "ok" }),
						},
						artifacts: { summary: artifact("summary.json", z.object({ absolute: z.literal(true) }).passthrough()) },
						reply: z.object({ ok: z.literal(true) }),
					}),
					transitions: { DONE: "done" },
				},
				done: final(),
				failed: failed(),
			},
		}));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const store = new MemoryLogStore();
		const runtime = withRunStorage(storage, () => new ChartRuntime({
			ast: parsed.ast,
			branchId: "main",
			logStore: store,
			agentExecutor: new FakeAgentExecutor(),
			chartDir,
			workDir,
			projectDir,
			runId,
			schemaRegistry: parsed.schemaRegistry,
		}));

		const state = await withTimeout(start(runtime, { topic: "durable functions" }));
		await runtime.dispose();

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(state.projection.results.consume).toEqual({ ok: true });
		const observed = JSON.parse(await readFile(join(workDir, "summary.json"), "utf8")) as Record<string, unknown>;
		expect(observed).toMatchObject({
			params: { RESULT: "from-result", REPORT_OK: true },
			input: { review: "from-result" },
			absolute: true,
			events: ["DONE"],
			action: "tsImport",
		});
		const paths = observed.paths as Record<string, string>;
		expect(Object.values(paths).every(isAbsolute)).toBe(true);
		expect(paths).toMatchObject({ chartDir, workDir, projectDir, summary: join(workDir, "summary.json") });

		const records = await collectHistoryRecords(store, "main");
		const inspected = inspectChartAst(parsed.ast).states.find((candidate) => candidate.id === "consume");
		expect(inspected).toMatchObject({ kind: "tsImport", module: "./actions.mjs", export: "consume", env: [{ name: "RESULT" }, { name: "REPORT_OK" }] });
		const hosted = hyperchartRunFromRuntime(inspectChartAst(parsed.ast), parsed.ast, records).states.find((candidate) => candidate.id === "consume");
		expect(hosted).toMatchObject({
			type: "tsImport",
			module: "./actions.mjs",
			export: "consume",
			visitHistory: [{ invocation: { kind: "tsImport", module: "./actions.mjs", export: "consume", params: { RESULT: "from-result" } } }],
		});
		const hostedInvocation = hosted?.visitHistory?.[0]?.invocation;
		expect(hostedInvocation?.kind === "tsImport" ? hostedInvocation.params?.REPORT_OK : undefined).toMatchObject({ path: "report.json", select: "ok" });
		const completes = records.filter((record) => record.type === "state_action" && record.kind === "complete");
		expect(completes).toHaveLength(2);
		const summaryComplete = completes.find((record) => record.actionUid.state === "consume");
		if (summaryComplete?.type !== "state_action" || summaryComplete.kind !== "complete") throw new Error("missing completion");
		const summaryPin = summaryComplete.artifacts?.["summary.json"];
		expect(summaryPin?.hash).toBe(createHash("sha256").update(await readFile(join(workDir, "summary.json"))).digest("hex"));
		expect(state.projection.artifactPins["summary.json"]).toEqual(summaryPin);
		if (summaryPin === undefined) throw new Error("missing summary artifact pin");
		expect(await readFile(await new ArtifactStore(runDir).get(summaryPin.hash), "utf8")).toBe(await readFile(join(workDir, "summary.json"), "utf8"));
	});

	it("converts imported exceptions into durable FAILED completion", async () => {
		const root = await tempDir();
		await writeFile(join(root, "throw.mjs"), `export function run() { throw new Error("imported boom"); }\n`);
		const chartAst = ast(chart({
			kind: "chart", id: "function-failed", initial: "work",
			states: { work: { kind: "state", action: tsAction("./throw.mjs", "run"), transitions: { DONE: "done" } }, done: final() },
		}));
		const store = new MemoryLogStore();
		const runtime = new ChartRuntime({ ast: chartAst, branchId: "main", logStore: store, agentExecutor: new FakeAgentExecutor(), chartDir: root, workDir: root });
		const state = await withTimeout(start(runtime));
		await runtime.dispose();

		expect(state.projection.failure).toMatchObject({ origin: "work", error: "imported boom" });
		const failureIntent = (await collectHistoryRecords(store, "main")).find((record) => record.type === "failure_intent");
		expect(failureIntent).toMatchObject({ type: "failure_intent", origin: "work", error: "imported boom" });
	});

	it("aborts a timed-out action and suppresses its completion", async () => {
		const root = await tempDir();
		await writeFile(
			join(root, "abort.mjs"),
			`import { writeFileSync } from "node:fs";
export function run(_params, ctx) {
  writeFileSync(ctx.artifacts.ready, "ready");
  ctx.signal.addEventListener("abort", () => writeFileSync(ctx.artifacts.aborted, "aborted"), { once: true });
  return new Promise(() => {});
}
`,
		);
		const chartAst = ast(chart({
			kind: "chart", id: "function-timeout", initial: "work",
			states: {
				work: {
					kind: "state",
					action: tsAction("./abort.mjs", "run", { artifacts: { ready: "ready.txt", aborted: "aborted.txt" } }),
					after: { delayMs: 200, target: "timeout" },
					transitions: { DONE: "done" },
				},
				done: final(), timeout: final(),
			},
		}));
		const store = new MemoryLogStore();
		const runtime = new ChartRuntime({ ast: chartAst, branchId: "main", logStore: store, agentExecutor: new FakeAgentExecutor(), chartDir: root, workDir: root });
		const state = await withTimeout(start(runtime));
		await waitUntil(async () => (await readFile(join(root, "aborted.txt"), "utf8").catch(() => undefined)) === "aborted");
		await runtime.dispose();

		expect(state.projection.activeLeaves).toEqual(["timeout"]);
		expect((await collectHistoryRecords(store, "main")).filter((record) => record.type === "state_action" && record.kind === "complete")).toHaveLength(0);
	});

	it("uses shared completion validation for unsupported events and FAILED-without-error", async () => {
		const root = await tempDir();
		await writeFile(join(root, "invalid.mjs"), `export const unsupported = () => ({ type: "OTHER" });\nexport const failedWithoutError = () => ({ type: "FAILED" });\n`);
		const runner = new FunctionRunner({ chartDir: root, workDir: root });
		await expect(runner.run(effect("./invalid.mjs", "unsupported"))).resolves.toEqual({
			type: "FAILED",
			error: "imported action emitted unsupported event 'OTHER'; allowed: DONE, FAILED",
		});
		await expect(runner.run(effect("./invalid.mjs", "failedWithoutError"))).resolves.toEqual({
			type: "FAILED",
			error: "imported action emitted FAILED without an error",
		});
		await runner.dispose();
	});

	it("settles cancel immediately, suppresses a late result, and never waits for user code", async () => {
		const root = await tempDir();
		await writeFile(
			join(root, "late.mjs"),
			`let release;
export function hang() { return new Promise((resolve) => { release = resolve; }); }
export function finish() { release?.({ type: "DONE", output: { late: true } }); }
`,
		);
		const runner = new FunctionRunner({ chartDir: root, workDir: ".", projectDir: "." });
		const importedEffect = effect("./late.mjs", "hang");
		const pending = runner.run(importedEffect);
		await new Promise((resolve) => setImmediate(resolve));
		await expect(runner.run(importedEffect)).rejects.toThrow("already running");
		await withTimeout(runner.cancel(importedEffect.actionUid), 100);
		await expect(withTimeout(pending, 100)).resolves.toBeUndefined();
		const module = (await import(new URL(`file://${join(root, "late.mjs")}`).href)) as { finish(): void };
		module.finish();
		await new Promise((resolve) => setImmediate(resolve));

		const blockedPreparation = runner.run(importedEffect, undefined, () => new Promise<void>(() => {}));
		await new Promise((resolve) => setImmediate(resolve));
		await withTimeout(runner.cancel(importedEffect.actionUid), 100);
		await expect(withTimeout(blockedPreparation, 100)).resolves.toBeUndefined();
		await withTimeout(runner.dispose(), 100);
	});

	it("disposes a ChartRuntime with a permanently hanging action without waiting forever", async () => {
		const root = await tempDir();
		await writeFile(
			join(root, "hang.mjs"),
			`import { writeFileSync } from "node:fs";
export function hang(_params, ctx) {
  writeFileSync(ctx.artifacts.ready, "ready");
  return new Promise(() => {});
}
`,
		);
		const chartAst = ast(chart({
			kind: "chart", id: "function-dispose", initial: "work",
			states: {
				work: { kind: "state", action: tsAction("./hang.mjs", "hang", { artifacts: { ready: "ready.txt" } }), transitions: { DONE: "done" } },
				done: final(),
			},
		}));
		const runtime = new ChartRuntime({ ast: chartAst, branchId: "main", logStore: new MemoryLogStore(), agentExecutor: new FakeAgentExecutor(), chartDir: root, workDir: root });
		const running = start(runtime).catch(() => undefined);
		await waitUntil(async () => (await readFile(join(root, "ready.txt"), "utf8").catch(() => undefined)) === "ready");
		await withTimeout(runtime.dispose(), 150);
		await withTimeout(running, 150);
	});
});
