import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeChartConfig, start } from "../packages/hyperchart/src/index.js";
import { agent, arg, chart, final, map, user } from "../packages/hyperchart/src/core/dsl.js";
import type { ChartAst, ChartCst, DurableLogRecord, Effect } from "../packages/hyperchart/src/index.js";
import { ChartRuntime } from "../packages/hyperchart/src/runtime/generic/chart_runtime.js";
import { ArtifactStore } from "../packages/hyperchart/src/runtime/generic/artifact_store.js";
import { JsonlLogStore } from "../packages/hyperchart/src/runtime/generic/log_store.js";
import { MemoryLogStore } from "../packages/hyperchart/src/runtime/generic/memory_log_store.js";
import { FakeAgentExecutor } from "./fake_agent_executor.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hyperchart-runtime-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
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

function userChart(): ChartAst {
	return make(
		chart({
			kind: "chart",
			id: "runtime-user",
			initial: "ask",
			states: {
				ask: { kind: "state", action: user({ prompt: "Approve?", options: ["APPROVED"] }), transitions: { APPROVED: "done" } },
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

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
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
	it("appends and acknowledges durable effects in supplied order", async () => {
		const store = new MemoryLogStore();
		const runtime = new ChartRuntime({
			ast: linearChart(), branchId: "main",
			logStore: store,
			agentExecutor: new FakeAgentExecutor(),
			workDir: process.cwd(),
			chartDir: process.cwd(),
		});
		const effects: Effect[] = [
			{ kind: "durable_records", id: "first", records: [{ type: "args", args: {} }] },
			{ kind: "durable_records", id: "second", records: [{ type: "failure_intent", origin: "work", error: "test" }] },
		];

		runtime.runEffects(effects);
		const events = runtime.eventsQueue()[Symbol.asyncIterator]();
		expect(await events.next()).toMatchObject({ value: { kind: "durable_records_added", effectId: "first" } });
		expect(await events.next()).toMatchObject({ value: { kind: "durable_records_added", effectId: "second" } });
		expect((await store.readAll()).map((record) => record.seqId)).toEqual([2, 3]);
		await runtime.dispose();
	});

	it("quiesces delayed pinned-read restoration without starting an executor after disposal", async () => {
		const root = await makeTempDir();
		const runDir = join(root, "run");
		await mkdir(runDir);
		const source = join(root, "pinned-source.txt");
		await writeFile(source, "pinned");
		const ast = linearChart();
		const state = ast.states.work;
		if (state?.kind !== "state" || state.action.kind !== "agent") throw new Error("expected agent state");
		const pin = { hash: "a".repeat(64), size: 6 };
		const store = new MemoryLogStore();
		await store.appendDrafts([{
			type: "state_action",
			kind: "complete",
			actionUid: state.action.uid,
			event: { type: "DONE" },
			artifacts: { "input.txt": pin },
		}]);
		let releaseRead!: () => void;
		const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
		let readEntered!: () => void;
		const entered = new Promise<void>((resolve) => { readEntered = resolve; });
		vi.spyOn(ArtifactStore.prototype, "get").mockImplementation(async () => {
			readEntered();
			await readGate;
			return source;
		});
		const executor = new FakeAgentExecutor();
		const runtime = new ChartRuntime({
			ast, branchId: "main", logStore: store, agentExecutor: executor,
			workDir: root, chartDir: root, runDir,
		});
		runtime.runEffects([{
			kind: "agent",
			id: "delayed-read",
			actionUid: state.action.uid,
			action: state.action,
			sessionId: "delayed-read",
			reads: [{ path: "input.txt" }],
			events: ["DONE"],
		}]);
		await entered;

		let disposed = false;
		const disposal = runtime.dispose().then(() => { disposed = true; });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(disposed).toBe(false);
		expect(executor.starts).toHaveLength(0);
		releaseRead();
		await disposal;
		runtime.runEffects([{
			kind: "agent",
			id: "after-disposal",
			actionUid: state.action.uid,
			action: state.action,
			sessionId: "after-disposal",
			events: ["DONE"],
		}]);

		expect(executor.starts).toHaveLength(0);
		expect(await runtime.eventsQueue()[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined });
	});

	it("runs every component cleanup and surfaces failures from idempotent disposal", async () => {
		const calls: string[] = [];
		const agentExecutor = {
			start: () => undefined,
			reject: () => undefined,
			cancel: async () => undefined,
			dispose: async () => {
				calls.push("agent");
				throw new Error("agent cleanup failed");
			},
		};
		const runtime = new ChartRuntime({
			ast: linearChart(), branchId: "main", logStore: new MemoryLogStore(),
			agentExecutor, workDir: process.cwd(), chartDir: process.cwd(),
		});

		const first = runtime.dispose();
		const second = runtime.dispose();
		expect(second).toBe(first);
		await expect(first).rejects.toThrow(/agent cleanup failed/);
		expect(calls).toEqual(["agent"]);
	});

	it("runs a linear agent chart through the real execution loop", async () => {
		const executor = new FakeAgentExecutor({ work: [{ type: "DONE", output: { ok: true } }] });
		const store = new MemoryLogStore();
		const runtime = new ChartRuntime({
			ast: linearChart(), branchId: "main",
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
			ast: fanoutChart(), branchId: "main",
			logStore: new MemoryLogStore(),
			agentExecutor: executor,
			workDir: process.cwd(),
			chartDir: process.cwd(),
		});

		const state = await withTimeout(start(runtime, { items: ["a", "b"] }));

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(executor.starts.map((effect) => effect.actionUid.state).sort()).toEqual(["fanout#0.work", "fanout#1.work"]);
	});

	it("preserves a journal gate on dispose and consumes its resolved fact after restart", async () => {
		const ast = userChart();
		const root = await makeTempDir();
		const logStore = new JsonlLogStore(join(root, "log.jsonl"));
		await logStore.initializeRootBranch();
		const firstRuntime = new ChartRuntime({ ast, branchId: "main", logStore, agentExecutor: new FakeAgentExecutor(), workDir: root, chartDir: root });
		const firstRun = start(firstRuntime).catch(() => undefined);
		await waitUntil(() => logStore.snapshot().ancestry("main").some((record) => record.type === "user_interaction" && record.kind === "opened"));
		const opened = logStore.snapshot().ancestry("main").find((record) => record.type === "user_interaction" && record.kind === "opened");
		if (opened?.type !== "user_interaction" || opened.kind !== "opened") throw new Error("expected opened gate");
		await firstRuntime.dispose(); await firstRun;
		await logStore.respondToUserInteraction({ ast, gateSeqId: opened.seqId, event: { type: "APPROVED" } });
		const secondRuntime = new ChartRuntime({ ast, branchId: "main", logStore, agentExecutor: new FakeAgentExecutor(), workDir: root, chartDir: root });
		const state = await withTimeout(start(secondRuntime)); await secondRuntime.dispose();
		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(invokeRecords(await logStore.readAll())).toHaveLength(1);
		expect((await logStore.readAll()).filter((record) => record.type === "user_interaction" && record.kind === "resolved")).toHaveLength(1);
		expect((await logStore.readAll()).filter((record) => record.type === "state_action" && record.kind === "complete")).toHaveLength(0);
	});

	it("applies a control-API response committed by its own writer exactly once", async () => {
		const ast = userChart();
		const root = await makeTempDir();
		const runtimeStore = new JsonlLogStore(join(root, "log.jsonl"));
		await runtimeStore.initializeRootBranch();
		const runtime = new ChartRuntime({ ast, branchId: "main", logStore: runtimeStore, agentExecutor: new FakeAgentExecutor(), workDir: root, chartDir: root });
		const running = start(runtime);
		await waitUntil(() => runtimeStore.snapshot().ancestry("main").some((record) => record.type === "user_interaction" && record.kind === "opened"));
		const opened = runtimeStore.snapshot().ancestry("main").find((record) => record.type === "user_interaction" && record.kind === "opened");
		if (opened?.type !== "user_interaction" || opened.kind !== "opened") throw new Error("expected opened gate");
		const committed = await runtimeStore.respondToUserInteraction({ ast, gateSeqId: opened.seqId, event: { type: "APPROVED" } });
		runtime.acknowledgeCommittedRecords([committed.record], `test-control:${committed.record.seqId}`);
		const state = await withTimeout(running); await runtime.dispose();
		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect((await runtimeStore.readAll()).filter((record) => record.type === "user_interaction" && record.kind === "resolved")).toHaveLength(1);
	});

	it("fires timers and cancels the timed-out action", async () => {
		const executor = new FakeAgentExecutor({ work: [undefined] });
		const runtime = new ChartRuntime({
			ast: timedChart(), branchId: "main",
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
		await logStore.initializeRootBranch();
		const firstExecutor = new FakeAgentExecutor({ work: [undefined] });
		const firstRuntime = new ChartRuntime({
			ast, branchId: "main",
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
			ast, branchId: "main",
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
