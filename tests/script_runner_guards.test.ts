import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeChartConfig, start, z } from "../src/index.js";
import { chart, final, script, tsImport } from "../src/core/dsl.js";
import type { ChartAst, ChartCst, DurableLogRecord } from "../src/index.js";
import { ChartRuntime } from "../src/runtime/generic/chart_runtime.js";
import { JsonlLogStore, MemoryLogStore } from "../src/runtime/generic/log_store.js";
import { runGuard } from "../src/runtime/generic/guards.js";
import { FakeAgentExecutor } from "./fake_agent_executor.js";

const tempDirs: string[] = [];
const node = process.execPath;

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hyperchart-script-"));
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

function scriptChart(action: ReturnType<typeof script>): ChartAst {
	return make(
		chart({
			kind: "chart",
			id: "script-chart",
			initial: "run",
			states: {
				run: { kind: "state", action, transitions: { DONE: "done", OTHER: "other", FAILED: "failed" } },
				done: final(),
				other: final(),
				failed: final(),
			},
		}),
	);
}

async function runScriptChart(ast: ChartAst, workDir: string) {
	const runtime = new ChartRuntime({
		ast,
		logStore: new MemoryLogStore(),
		agentExecutor: new FakeAgentExecutor(),
		workDir,
		chartDir: workDir,
	});
	return withTimeout(start(runtime));
}

describe("ScriptRunner via ChartRuntime", () => {
	it("uses the last JSON stdout line as the completion event", async () => {
		const dir = await makeTempDir();
		const ast = scriptChart(
			script(node, ["-e", 'console.log("noise"); console.log(JSON.stringify({type:"DONE", output:{value:3}}));'], {
				reply: z.object({ value: z.number() }),
			}),
		);

		const state = await runScriptChart(ast, dir);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(state.projection.results.run).toEqual({ value: 3 });
	});

	it("maps exit 0 without JSON to the only non-FAILED event", async () => {
		const dir = await makeTempDir();
		const ast = make(
			chart({
				kind: "chart",
				id: "implicit-script",
				initial: "run",
				states: {
					run: { kind: "state", action: script(node, ["-e", 'console.log("done")']), transitions: { DONE: "done" } },
					done: final(),
				},
			}),
		);

		const state = await runScriptChart(ast, dir);

		expect(state.projection.activeLeaves).toEqual(["done"]);
	});

	it("fails loudly when exit 0 is ambiguous", async () => {
		const dir = await makeTempDir();
		const ast = scriptChart(script(node, ["-e", 'console.log("done")']));

		const state = await runScriptChart(ast, dir);

		expect(state.projection.activeLeaves).toEqual(["failed"]);
		expect(state.projection.results.run).toBeUndefined();
	});

	it("maps non-zero exit to FAILED", async () => {
		const dir = await makeTempDir();
		const ast = scriptChart(script(node, ["-e", 'console.error("boom"); process.exit(2)']));

		const state = await runScriptChart(ast, dir);

		expect(state.projection.activeLeaves).toEqual(["failed"]);
	});

	it("re-runs a rejected script with attempt environment", async () => {
		const dir = await makeTempDir();
		const action = script(
			node,
			[
				"-e",
				`const attempt = Number(process.env.HYPERCHART_ATTEMPT || 0);
const ok = attempt > 0;
console.log(JSON.stringify({type:"DONE", output:{ok, attempt, reason: process.env.HYPERCHART_REJECT_REASON || null}}));`,
			],
			{ reply: z.object({ ok: z.boolean(), attempt: z.number(), reason: z.string().nullable() }) },
		);
		const guard = script(node, [
			"-e",
			`let input="";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const event = JSON.parse(input);
  if (event.output.ok) process.exit(0);
  console.error("not ok");
  process.exit(1);
});`,
		]);
		const ast = make(
			chart({
				kind: "chart",
				id: "script-reject",
				initial: "run",
				states: {
					run: {
						kind: "state",
						action,
						validate: guard,
						retries: 1,
						transitions: { DONE: "done", FAILED: "failed" },
					},
					done: final(),
					failed: final(),
				},
			}),
		);

		const state = await runScriptChart(ast, dir);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(state.projection.results.run).toEqual({ ok: true, attempt: 1, reason: "not ok" });
	});

	it("retries a rejected script when a fresh runtime resumes the durable log", async () => {
		const dir = await makeTempDir();
		const action = script(
			node,
			[
				"-e",
				`const attempt = Number(process.env.HYPERCHART_ATTEMPT || 0);
const ok = attempt > 0;
console.log(JSON.stringify({type:"DONE", output:{ok, attempt, reason: process.env.HYPERCHART_REJECT_REASON || null}}));`,
			],
			{ reply: z.object({ ok: z.boolean(), attempt: z.number(), reason: z.string().nullable() }) },
		);
		const guard = script(node, [
			"-e",
			`let input="";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const event = JSON.parse(input);
  if (event.output.ok) process.exit(0);
  console.error("not ok");
  process.exit(1);
});`,
		]);
		const ast = make(
			chart({
				kind: "chart",
				id: "script-reject-resume",
				initial: "run",
				states: {
					run: {
						kind: "state",
						action,
						validate: guard,
						retries: 1,
						transitions: { DONE: "done", FAILED: "failed" },
					},
					done: final(),
					failed: final(),
				},
			}),
		);
		const runState = ast.states.run;
		if (runState?.kind !== "state") throw new Error("expected run state");
		const actionUid = runState.action.uid;
		const rejectedLog: DurableLogRecord[] = [
			{ type: "state_action", kind: "invoke", actionUid, parentId: null, seqId: 1, timestamp: 1 },
			{
				type: "state_action",
				kind: "complete",
				actionUid,
				event: { type: "DONE", output: { ok: false, attempt: 0, reason: null } },
				parentId: 1,
				seqId: 2,
				timestamp: 2,
			},
			{
				type: "state_action",
				kind: "validated",
				actionUid,
				event: { type: "DONE", output: { ok: false, attempt: 0, reason: null } },
				guard,
				outcome: { ok: false, reason: "not ok" },
				parentId: 2,
				seqId: 3,
				timestamp: 3,
			},
		];
		const logStore = new JsonlLogStore(join(dir, "log.jsonl"));
		logStore.append(rejectedLog);
		const runtime = new ChartRuntime({
			ast,
			logStore,
			agentExecutor: new FakeAgentExecutor(),
			workDir: dir,
			chartDir: dir,
		});

		const state = await withTimeout(start(runtime));

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(state.projection.results.run).toEqual({ ok: true, attempt: 1, reason: "not ok" });
	});
});

describe("guards", () => {
	it("runs tsImport guards relative to chartDir", async () => {
		const dir = await makeTempDir();
		await writeFile(
			join(dir, "check.mjs"),
			"export function accepts(event) { return event.output?.ok === true ? true : {ok:false, reason:'bad'}; }\n",
			"utf8",
		);

		await expect(
			runGuard(
				tsImport("./check.mjs", "accepts"),
				{ type: "DONE", output: { ok: true } },
				{ chartDir: dir, workDir: dir },
			),
		).resolves.toBe(true);
		await expect(
			runGuard(
				tsImport("./check.mjs", "accepts"),
				{ type: "DONE", output: { ok: false } },
				{ chartDir: dir, workDir: dir },
			),
		).resolves.toEqual({ ok: false, reason: "bad" });
	});

	it("turns script guard stderr into a rejection reason", async () => {
		const dir = await makeTempDir();
		await expect(
			runGuard(
				script(node, ["-e", 'console.error("nope"); process.exit(1)']),
				{ type: "DONE" },
				{ chartDir: dir, workDir: dir },
			),
		).resolves.toEqual({ ok: false, reason: "nope" });
	});

	it("drains script guard stdout so verbose guards can exit", async () => {
		const dir = await makeTempDir();
		await expect(
			withTimeout(
				runGuard(
					script(node, ["-e", 'process.stdout.write("x".repeat(1024 * 1024)); process.exit(0)']),
					{ type: "DONE" },
					{ chartDir: dir, workDir: dir },
				),
			),
		).resolves.toBe(true);
	});
});
