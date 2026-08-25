import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
	artifact,
	chart,
	contract,
	explainReplay,
	final, failed,
	script,
	z,
	normalizeChartConfig,
} from "../packages/hyperchart/src/index.js";
import type { ChartCst, StateAst, ScriptActionAst } from "../packages/hyperchart/src/index.js";
import { checkSchemaAsync } from "../packages/hyperchart/src/runtime/generic/schema.js";
import { checkArtifactFile, resolveArtifactValue } from "../packages/hyperchart/src/runtime/generic/artifacts.js";
import { ScriptRunner } from "../packages/hyperchart/src/runtime/generic/script_runner.js";
import type { RenderedArtifact, AgentEffect } from "../packages/hyperchart/src/core/machine.js";
import { validateFinishParams } from "../packages/pi-hyperchart/src/runtime/pi/finish_tool.js";

const tempDirs: string[] = [];
const node = process.execPath;

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hyperchart-contract-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function parsed(config: ChartCst) {
	const result = normalizeChartConfig(config);
	if (!result.ok) throw new Error(result.diagnostics.map((entry) => entry.message).join("\n"));
	return result;
}

function scriptConfig(reply?: z.ZodType, artifacts?: Record<string, string | ReturnType<typeof artifact>>): ChartCst {
	return chart({
		kind: "chart",
		id: "runtime-contract",
		initial: "run",
		states: {
			run: {
				kind: "state",
				action: script(node, ["-e", 'console.log(JSON.stringify({type:"DONE",output:{value:process.env.VALUE}}))'], {
					env: { VALUE: "ok" },
					...(reply === undefined ? {} : { reply }),
					...(artifacts === undefined ? {} : { artifacts }),
				}),
				transitions: { DONE: "done", ERROR: "failed" },
			},
			done: final(),
			failed: failed(),
		},
	});
}

function scriptState(result: ReturnType<typeof parsed>): {
	state: Extract<StateAst, { kind: "state" }>;
	action: ScriptActionAst;
} {
	const state = result.ast.states.run;
	if (state === undefined || state.kind !== "state" || state.action.kind !== "script")
		throw new Error("missing script state");
	return { state, action: state.action };
}

describe("runtime Zod contracts", () => {
	it("keeps ordinary Zod schemas on the JSON Schema compatibility path", async () => {
		const shape = z.string().refine((value) => value === "ok");
		const result = parsed(scriptConfig(shape));
		const { action } = scriptState(result);
		if (action.reply === undefined) throw new Error("missing reply");
		expect(action.reply.runtimeContract).toBeUndefined();
		expect(await checkSchemaAsync(action.reply, "ok")).toEqual({ ok: true });
	});

	it("uses sync refine/superRefine and async refine as exact validators", async () => {
		const sync = contract(
			"reply",
			"1",
			z.string().refine((value) => value === "ok", "must be ok"),
		);
		const superSync = contract(
			"super",
			"1",
			z.string().superRefine((value, ctx) => {
				if (value !== "ok") ctx.addIssue({ code: "custom", message: "super says no" });
			}),
		);
		const asyncShape = contract(
			"async",
			"1",
			z.string().refine(async (value) => value === "ok", "async says no"),
		);
		for (const [shape, valid, invalid] of [
			[sync, "ok", "no"],
			[superSync, "ok", "no"],
			[asyncShape, "ok", "no"],
		] as const) {
			const result = parsed(scriptConfig(shape));
			const { action } = scriptState(result);
			if (action.reply === undefined) throw new Error("missing reply");
			expect(action.reply.runtimeContract).toEqual({
				id: shape === sync ? "reply" : shape === superSync ? "super" : "async",
				version: "1",
			});
			expect(await checkSchemaAsync(action.reply, valid, result.schemaRegistry)).toEqual({ ok: true });
			const invalidResult = await checkSchemaAsync(action.reply, invalid, result.schemaRegistry);
			expect(invalidResult.ok).toBe(false);
			if (!invalidResult.ok) expect(invalidResult.errors.join("\n")).toContain("/");
		}
	});

	it("fails closed when a runtime registry is missing", async () => {
		const result = parsed(scriptConfig(contract("missing", "1", z.object({ value: z.string() }))));
		const { action } = scriptState(result);
		if (action.reply === undefined) throw new Error("missing reply");
		const check = await checkSchemaAsync(action.reply, { value: "ok" });
		expect(check.ok).toBe(false);
		if (!check.ok) expect(check.errors[0]).toContain("refusing JSON Schema fallback");
	});

	it("rejects conflicting duplicate identities", () => {
		const result = normalizeChartConfig(scriptConfig(contract("same", "1", z.string())));
		// A second contract is attached to a separate declaration in one chart.
		const config = chart({
			kind: "chart",
			id: "duplicate",
			initial: "one",
			states: {
				one: {
					kind: "state",
					action: script(node, ["-e", ""], {
						reply: contract("same", "1", z.string()),
					}),
					transitions: { DONE: "two" },
				},
				two: {
					kind: "state",
					action: script(node, ["-e", ""], {
						reply: contract("same", "1", z.number()),
					}),
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		});
		const duplicate = normalizeChartConfig(config);
		expect(result.ok).toBe(true);
		expect(duplicate.ok).toBe(false);
		if (!duplicate.ok)
			expect(duplicate.diagnostics.map((entry) => entry.message).join("\n")).toContain(
				"Conflicting runtime contract same@1",
			);
	});

	it("keeps ids containing delimiters distinct", () => {
		const result = parsed(
			chart({
				kind: "chart",
				id: "delimiter-identities",
				initial: "one",
				states: {
					one: {
						kind: "state",
						action: script(node, ["-e", ""], {
							reply: contract("a\0b", "c", z.string()),
						}),
						transitions: { DONE: "two" },
					},
					two: {
						kind: "state",
						action: script(node, ["-e", ""], {
							reply: contract("a", "b\0c", z.number()),
						}),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
		);
		expect(result.schemaRegistry.get({ id: "a\0b", version: "c" })).toBeDefined();
		expect(result.schemaRegistry.get({ id: "a", version: "b\0c" })).toBeDefined();
	});

	it("rejects exact contracts on replay-derived state inputs", () => {
		const result = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "contract-input",
				initial: "run",
				states: {
					run: {
						kind: "state",
						input: { value: contract("input", "1", z.string()) },
						action: script(node, ["-e", ""]),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
		);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.diagnostics.map((entry) => entry.message).join("\n")).toContain(
				"not supported for state or map inputs",
			);
	});

	it("retains input-side JSON Schema metadata for transform contracts", () => {
		const result = parsed(scriptConfig(contract("transform", "1", z.string().default("2").transform(Number))));
		const { action } = scriptState(result);
		if (action.reply === undefined) throw new Error("missing reply");
		expect(action.reply.schema).toMatchObject({ type: "string", default: "2" });
	});

	it("validates script replies, artifacts, and selected reads with the registry", async () => {
		const dir = await tempDir();
		const shape = contract("artifact", "1", z.object({ value: z.number() }));
		const result = parsed(scriptConfig(shape, { output: artifact("output.json", shape) }));
		const { state, action } = scriptState(result);
		if (action.reply === undefined) throw new Error("missing script reply");
		await writeFile(join(dir, "output.json"), JSON.stringify({ value: "bad" }), "utf8");
		const artifactShape = action.artifacts?.output?.shape;
		if (artifactShape === undefined) throw new Error("missing artifact shape");
		const artifactValue: RenderedArtifact = {
			path: "output.json",
			shape: artifactShape,
		};
		expect((await checkArtifactFile(artifactValue, dir, result.schemaRegistry)).ok).toBe(false);
		await expect(
			resolveArtifactValue({ ...artifactValue, select: "value" }, dir, result.schemaRegistry),
		).rejects.toThrow("schema mismatch");
		const runner = new ScriptRunner({
			workDir: dir,
			schemaRegistry: result.schemaRegistry,
		});
		const effect = {
			kind: "script" as const,
			id: "runtime-contract:run:script:1",
			actionUid: action.uid,
			action,
			command: node,
			args: ["-e", 'console.log(JSON.stringify({type:"DONE",output:{value:"bad"}}))'],
			events: ["DONE", "FAILED"],
			reply: action.reply,
			artifacts: [artifactValue],
		};
		await expect(runner.run(effect)).resolves.toMatchObject({ type: "FAILED" });
	});

	it("rejects invalid Pi finish-tool replies with actionable Zod paths", async () => {
		const result = parsed(scriptConfig(contract("finish", "1", z.object({ nested: z.object({ ok: z.boolean() }) }))));
		const { action } = scriptState(result);
		if (action.reply === undefined) throw new Error("missing script reply");
		const effect = {
			kind: "agent" as const,
			id: "finish-invocation",
			actionUid: {
				chart: result.ast.id,
				state: "run",
				action: "agent" as const,
			},
			action: {
				kind: "agent" as const,
				uid: { chart: result.ast.id, state: "run", action: "agent" as const },
				name: "worker",
				reply: action.reply,
			},
			events: ["DONE", "FAILED"],
			reply: action.reply,
		} as unknown as AgentEffect;
		const checked = await validateFinishParams(
			effect,
			{
				event: "DONE",
				output: { nested: { ok: "no" } },
			},
			result.schemaRegistry,
		);
		expect(checked.ok).toBe(false);
		if (!checked.ok) expect(checked.errors.join("\n")).toContain("/nested/ok");
	});

	it("changes normalized provenance when contract version changes", () => {
		const one = parsed(scriptConfig(contract("versioned", "1", z.string())));
		const two = parsed(scriptConfig(contract("versioned", "2", z.string())));
		const serialized = JSON.stringify(one.ast);
		expect(serialized).not.toContain("function");
		expect(serialized).toContain('"runtimeContract":{"id":"versioned","version":"1"}');
		expect(serialized).not.toEqual(JSON.stringify(two.ast));
		const oneState = one.ast.states.run;
		if (oneState?.kind !== "state") throw new Error("missing state");
		const explanation = explainReplay(two.ast, [
			{
				type: "args",
				args: {},
				parentId: null,
				seqId: 1,
				branchId: "main", timestamp: 1,
			},
			{
				type: "state_action",
				kind: "invoke",
			sessionId: "session-id",
				actionUid: oneState.action.uid,
				definition: oneState.action,
				parentId: 1,
				seqId: 2,
				branchId: "main", timestamp: 2,
			},
		]);
		expect(explanation.stale.some((entry) => entry.reason === "action_definition_changed")).toBe(true);
	});
});
