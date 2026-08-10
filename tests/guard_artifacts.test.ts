import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { agent, artifact, chart, contract, event, final, failed, hyperchartSource, inspectChartAst, normalizeChartConfig, script, start, tsImport, z } from "../packages/hyperchart/src/index.js";
import { arg, input, joinArtifactOf, json, key, item, result, t, visit } from "../packages/hyperchart/src/core/dsl.js";
import type { ChartAst, ChartCst, Templatable, ArtifactOfCst, JoinArtifactOfCst, SchemaRegistryLike, JsonSchema, SchemaAst } from "../packages/hyperchart/src/index.js";
import { ChartRuntime } from "../packages/hyperchart/src/runtime/generic/chart_runtime.js";
import { MemoryLogStore } from "../packages/hyperchart/src/runtime/generic/log_store.js";
import { FakeAgentExecutor } from "./fake_agent_executor.js";
import { checkArtifactFile, resolveArtifactValue } from "../packages/hyperchart/src/runtime/generic/artifacts.js";

const node = process.execPath;
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hyperchart-guard-env-"));
	tempDirs.push(dir);
	return dir;
}

function schema(value: z.ZodType): SchemaAst {
	return { kind: "jsonSchema", schema: z.toJSONSchema(value) as JsonSchema };
}

function parsed(config: ChartCst) {
	const result = normalizeChartConfig(config);
	if (!result.ok) throw new Error(result.diagnostics.map((entry) => entry.message).join("\n"));
	return result;
}

async function run(ast: ChartAst, workDir: string, args?: Record<string, unknown>, executor = new FakeAgentExecutor(), schemaRegistry?: SchemaRegistryLike) {
	const runtime = new ChartRuntime({ ast, logStore: new MemoryLogStore(), agentExecutor: executor, workDir, chartDir: workDir, ...(schemaRegistry === undefined ? {} : { schemaRegistry }) });
	try {
		return await start(runtime, args);
	} finally {
		await runtime.dispose();
	}
}

function envGuard(env: Record<string, Templatable | ArtifactOfCst | JoinArtifactOfCst>) {
	return script(node, ["-e", `let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => { const e = JSON.parse(s); require("node:fs").writeFileSync("seen-env.json", JSON.stringify({env: process.env, event: e})); process.exit(e.type === "DONE" && !("artifacts" in e) ? 0 : 1); });`], { env });
}

describe("validation script env", () => {
	it("renders args, results, input, and visit through the same template path as script actions", async () => {
		const dir = await tempDir();
		const prepare = script(node, ["-e", 'console.log(JSON.stringify({type:"DONE",output:{value:"from-result"}}))']);
		const guard = envGuard({
			ARG: t`${arg("topic")}`,
			RESULT: t`${result("prepare", "value")}`,
			INPUT: t`${input("review")}`,
			VISIT: t`${visit()}`,
		});
		const resultChart = parsed(chart({
			kind: "chart", id: "guard-template-env", initial: "prepare",
			states: {
				prepare: { kind: "state", action: prepare, transitions: { DONE: { target: "work", input: { review: event("value") } } } },
				work: { kind: "state", input: { review: z.string() }, action: script(node, ["-e", 'console.log(JSON.stringify({type:"DONE"}))']), validate: guard, transitions: { DONE: "done" } },
				done: final(), failed: failed(),
			},
		}));
		const state = await run(resultChart.ast, dir, { topic: "from-arg" });
		expect(state.projection.activeLeaves).toEqual(["done"]);
		const seen = JSON.parse(await readFile(join(dir, "seen-env.json"), "utf8")) as { env: Record<string, string>; event: Record<string, unknown> };
		expect(seen.env).toMatchObject({ ARG: "from-arg", RESULT: "from-result", INPUT: "from-result", VISIT: "1" });
		expect(seen.event).toEqual({ type: "DONE" });
	});

	it("resolves an unnamed self artifactOf against action artifacts only", async () => {
		const dir = await tempDir();
		const action = script(node, ["-e", 'require("node:fs").writeFileSync("action.json", "action"); console.log(JSON.stringify({type:"DONE"}))'], { artifacts: { action: artifact("action.json") } });
		const guard = script(node, ["-e", 'require("node:fs").writeFileSync("guard.json", "guard"); process.exit(process.env.SELF === "action.json" ? 0 : 1)'], {
			env: { SELF: { kind: "artifactOf", state: "work" } },
			artifacts: { diagnostic: artifact("guard.json") },
		});
		const result = parsed(chart({ kind: "chart", id: "guard-self-unnamed", initial: "work", states: {
			work: { kind: "state", action, validate: guard, transitions: { DONE: "done" } }, done: final(), failed: failed(),
		} }));
		expect((await run(result.ast, dir)).projection.activeLeaves).toEqual(["done"]);
	});

	it("reads the validating action's own artifact with exact shape and selector", async () => {
		const dir = await tempDir();
		const action = script(node, ["-e", 'require("node:fs").writeFileSync("report.json", JSON.stringify({ok:true})); console.log(JSON.stringify({type:"DONE"}))'], {
			artifacts: { report: artifact("report.json", z.object({ ok: z.boolean() })) },
		});
		const guard = script(node, ["-e", 'process.exit(process.env.SELF === "true" ? 0 : 1)'], {
			env: { SELF: { kind: "artifactOf", state: "work", artifact: "report", select: "ok" } },
		});
		const resultChart = parsed(chart({
			kind: "chart", id: "guard-self-artifact", initial: "work",
			states: { work: { kind: "state", action, validate: guard, transitions: { DONE: "done" } }, done: final(), failed: failed() },
		}));
		const state = await run(resultChart.ast, dir);
		expect(state.projection.activeLeaves).toEqual(["done"]);
	});

	it.each(["missing", "invalid"] as const)("rejects %s selected artifacts before invoking a guard", async (kind) => {
		const dir = await tempDir();
		if (kind === "invalid") await writeFile(join(dir, "report.json"), "not-json", "utf8");
		const guard = script(node, ["-e", 'require("node:fs").writeFileSync("called","yes"); process.exit(0)'], { env: { CHECK: { kind: "artifactOf", state: "work", artifact: "report", select: "ok" } } });
		const action = agent("worker", { artifacts: { report: artifact("report.json", z.object({ ok: z.boolean() })) } });
		const resultChart = parsed(chart({ kind: "chart", id: `guard-${kind}-artifact`, initial: "work", states: { work: { kind: "state", action, validate: guard, retries: 0, transitions: { DONE: "done" } }, done: final(), failed: failed() } }));
		const state = await run(resultChart.ast, dir, undefined, new FakeAgentExecutor({ work: [{ type: "DONE" }] }));
		expect(state.projection.activeLeaves).toEqual(["work"]);
		expect(state.projection.failure).toMatchObject({ origin: "work" });
		expect(await readFile(join(dir, "called"), "utf8").catch(() => undefined)).toBeUndefined();
	});

	it("supports guard artifacts and reply without turning the guard reply into an action result", async () => {
		const dir = await tempDir();
		const shape = z.object({ approved: z.boolean() });
		const config = chart({ kind: "chart", id: "guard-output", initial: "work", states: {
			work: {
				kind: "state",
				action: script(node, ["-e", 'console.log(JSON.stringify({type:"DONE",output:{value:1}}))']),
				validate: script(node, ["-e", 'require("node:fs").writeFileSync("diagnostic.json", JSON.stringify({approved:true})); console.log(JSON.stringify({type:"CHECKED",output:{approved:true}}))'], { artifacts: { diagnostic: artifact("diagnostic.json", shape) }, reply: shape }),
				transitions: { DONE: "consume" },
			},
			consume: { kind: "state", action: script(node, ["-e", 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(process.env.DIAG,"utf8")); console.log(JSON.stringify({type:v.approved?"DONE":"FAILED"}))'], { env: { DIAG: { kind: "artifactOf", state: "work", artifact: "diagnostic" } } }), transitions: { DONE: "done" } },
			done: final(), failed: failed(),
		} });
		const result = parsed(config);
		const state = await run(result.ast, dir, undefined, new FakeAgentExecutor(), result.schemaRegistry);
		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(state.projection.results.work).toEqual({ value: 1 });
	});

	it("preserves guard env/artifacts/reply in source and inspect representations", () => {
		const result = parsed(chart({ kind: "chart", id: "guard-inspect", initial: "work", states: {
			work: { kind: "state", action: script(node), validate: script(node, [], { env: { CHECK: "yes" }, artifacts: { report: artifact("report.json") }, reply: z.object({ ok: z.boolean() }) }), transitions: { DONE: "done" } }, done: final(),
		} }));
		const inspected = inspectChartAst(result.ast).states.find((state) => state.id === "work");
		expect(inspected?.guard).toMatchObject({ kind: "script", env: [{ name: "CHECK" }], artifacts: [{ name: "report" }], reply: { type: "object" } });
		expect(hyperchartSource(result.ast)).toContain("artifacts");
	});

	it("rejects duplicate action and guard artifact names during normalization", () => {
		const result = normalizeChartConfig(chart({ kind: "chart", id: "guard-duplicate", initial: "work", states: {
			work: { kind: "state", action: script(node, [], { artifacts: { report: artifact("action.json") } }), validate: script(node, [], { artifacts: { report: artifact("guard.json") } }), transitions: { DONE: "done" } }, done: final(),
		} }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "DUPLICATE_GUARD_ARTIFACT" })]));
	});

	it("fails closed when a guard-produced artifact is missing", async () => {
		const dir = await tempDir();
		const result = parsed(chart({ kind: "chart", id: "guard-missing-output", initial: "work", states: {
			work: { kind: "state", action: script(node, ["-e", 'console.log(JSON.stringify({type:"DONE"}))']), validate: script(node, ["-e", "process.exit(0)"], { artifacts: { report: artifact("missing.json") } }), retries: 0, transitions: { DONE: "done" } }, done: final(), failed: failed(),
		} }));
		const state = await run(result.ast, dir);
		expect(state.projection.activeLeaves).toEqual(["work"]);
		expect(state.projection.failure).toMatchObject({ origin: "work" });
	});

	it("validates an exact runtime-contract guard reply", async () => {
		const dir = await tempDir();
		const reply = contract("guard-reply", "1", z.object({ approved: z.boolean() }).superRefine(async (value, ctx) => { await Promise.resolve(); if (!value.approved) ctx.addIssue({ code: "custom", message: "not approved" }); }));
		const result = parsed(chart({ kind: "chart", id: "guard-contract-reply", initial: "work", states: {
			work: { kind: "state", action: script(node, ["-e", 'console.log(JSON.stringify({type:"DONE"}))']), validate: script(node, ["-e", 'console.log(JSON.stringify({type:"CHECKED",output:{approved:true}}))'], { reply }), transitions: { DONE: "done" } }, done: final(), failed: failed(),
		} }));
		expect((await run(result.ast, dir, undefined, new FakeAgentExecutor(), result.schemaRegistry)).projection.activeLeaves).toEqual(["done"]);
	});

	it("keeps ordinary one-argument tsImport guards and plain ChartEvent stdin", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "guard.mjs"), "export function check(event){ return event.type === 'DONE' && !('artifacts' in event); }\n", "utf8");
		const resultChart = parsed(chart({ kind: "chart", id: "guard-compat", initial: "work", states: {
			work: { kind: "state", action: script(node, ["-e", 'console.log(JSON.stringify({type:"DONE"}))']), validate: tsImport("./guard.mjs", "check"), transitions: { DONE: "done" } }, done: final(), failed: failed(),
		} }));
		expect((await run(resultChart.ast, dir)).projection.activeLeaves).toEqual(["done"]);
	});

	it("rejects web URLs while letting declared artifact schemas govern data", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "schema.json"), JSON.stringify({ type: "object", properties: {}, required: [] }), "utf8");
		const schemaCheck = await checkArtifactFile({ path: "schema.json", shape: schema(z.object({ type: z.string(), properties: z.record(z.string(), z.unknown()), required: z.array(z.string()) })) }, dir);
		expect(schemaCheck.ok).toBe(true);
		await writeFile(join(dir, "domain-type.json"), JSON.stringify({ type: "string" }), "utf8");
		expect((await checkArtifactFile({ path: "domain-type.json", shape: schema(z.object({ type: z.string() })) }, dir)).ok).toBe(true);
		await writeFile(join(dir, "domain.json"), JSON.stringify({ type: "house", properties: { rooms: 3 } }), "utf8");
		const domainShape = schema(z.object({ type: z.string(), properties: z.object({ rooms: z.number() }) }));
		expect((await checkArtifactFile({ path: "domain.json", shape: domainShape }, dir)).ok).toBe(true);
		expect(await resolveArtifactValue({ path: "domain.json", shape: domainShape }, dir)).toEqual({ type: "house", properties: { rooms: 3 } });
		const schemaWithoutRootType = { properties: { name: { type: "string" } }, required: ["name"] };
		await writeFile(join(dir, "schema-without-root-type.json"), JSON.stringify(schemaWithoutRootType), "utf8");
		expect((await checkArtifactFile({ path: "schema-without-root-type.json", shape: schema(z.record(z.string(), z.unknown())) }, dir)).ok).toBe(true);
		// The declared artifact schema is authoritative: schema-shaped data passes when it matches,
		// and a mismatch still fails through normal schema validation rather than a heuristic.
		const mismatch = await checkArtifactFile({ path: "domain-type.json", shape: schema(z.object({ type: z.literal("house") })) }, dir);
		expect(mismatch.ok).toBe(false);
		await expect(resolveArtifactValue({ path: "https://example.com/data.json" }, dir)).rejects.toThrow("web URLs are not local artifacts");
	});
});

describe("joinArtifactOf validation env", () => {
	it("renders joined producer paths as a JSON array", async () => {
		const dir = await tempDir();
		const chartConfig = chart({ kind: "chart", id: "guard-join-env", initial: "items", states: {
			items: {
				kind: "map", over: arg("items"), initial: "produce", onDone: "end",
				states: {
					produce: { kind: "state", action: script(node, ["-e", 'require("node:fs").mkdirSync("out",{recursive:true}); require("node:fs").writeFileSync("out/report.txt","x"); console.log(JSON.stringify({type:"DONE"}))'], { artifacts: { report: artifact("out/report.txt") } }), transitions: { DONE: "check" } },
					check: { kind: "state", action: script(node, ["-e", 'process.exit(JSON.parse(process.env.ALL).length === 2 ? 0 : 1)'], { env: { ALL: joinArtifactOf("items.produce") } }), validate: script(node, ["-e", 'process.exit(JSON.parse(process.env.ALL).length === 2 && (process.env.KEY === "a" || process.env.KEY === "b") && process.env.ITEM === "{}" ? 0 : 1)'], { env: { ALL: joinArtifactOf("items.produce"), KEY: t`${key()}`, ITEM: t`${json(item())}` } }), transitions: { DONE: "finish" } },
					finish: final(),
				},
			},
			end: final(),
		} });
		const normalized = parsed(chartConfig);
		const state = await run(normalized.ast, dir, { items: { a: {}, b: {} } });
		expect(state.projection.activeLeaves).toEqual(["end"]);
	});
});
