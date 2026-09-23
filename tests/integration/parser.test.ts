import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseChartModule, parseChartModuleSync } from "../../packages/hyperchart/src/index.js";
import { selectChartModuleExport } from "../../packages/hyperchart/src/core/parser.js";

const examplePath = fileURLToPath(new URL("../../examples/api/review.chart.ts", import.meta.url));

describe("parseChartModule", () => {
	it("unwraps nested default exports produced by a Jiti register loader", () => {
		const chart = { kind: "chart", id: "smoke", initial: "done", states: { done: { kind: "final" } } };

		expect(selectChartModuleExport({ default: { default: chart } }, "default")).toBe(chart);
	});

	it("loads scoped package imports from a chart bundle outside the package tree", () => {
		const dir = mkdtempSync(join(tmpdir(), "hyperchart-bundle-parser-"));
		const path = join(dir, "chart.ts");
		try {
			writeFileSync(
				path,
				[
					'import { final, refs } from "@surprisal/hyperchart";',
					"const { chart } = refs<Record<string, never>, Record<string, never>>();",
					'export default chart({ id: "bundled", initial: "done", states: { done: final() } });',
				].join("\n"),
			);
			const result = parseChartModuleSync(path);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.ast.id).toBe("bundled");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves typed actor and completion provenance across the Jiti package boundary", () => {
		const dir = mkdtempSync(join(tmpdir(), "hyperchart-bound-ref-parser-"));
		const path = join(dir, "chart.ts");
		try {
			writeFileSync(
				path,
				[
					'import { actor, completion, final, message, notify, protocol, receive, refs, reply, send, waitFor, z } from "@surprisal/hyperchart";',
					'const Work = protocol({ START: message({ input: z.object({}).strict() }) });',
					'type Actors = { worker: typeof Work };',
					'type Completions = { done: { event: "DONE"; payload: { value: string } } };',
					'const typed = refs<Record<string, never>, { wait: { value: string } }, Record<never, Record<string, unknown>>, Record<never, unknown>, Record<never, Record<string, unknown>>, Actors, Completions>();',
					'const workerRef = typed.actorRef("worker");',
					'const doneRef = typed.completionRef("done");',
					'const Worker = actor({ input: z.object({}).strict(), protocol: Work, initial: "idle", states: { idle: receive({ on: { START: "publish" } }), publish: notify({ to: doneRef, event: "DONE", payload: { value: "ok" }, target: "settle" }), settle: reply({ target: "idle" }) } });',
					'const worker = Worker({});',
					'export default typed.chart({ kind: "chart", id: "bound-ref-loader", completions: { done: completion({ event: "DONE", schema: z.object({ value: z.string() }).strict() }) }, actors: { worker }, initial: "dispatch", states: { dispatch: send({ to: workerRef, event: "START", input: {}, target: "wait" }), wait: waitFor({ from: doneRef, event: "DONE", target: "done" }), done: final() } });',
				].join("\n"),
			);
			const result = parseChartModuleSync(path);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.ast.states.dispatch).toMatchObject({ kind: "send", to: "@worker" });
				expect(result.ast.states.wait).toMatchObject({ kind: "state", action: { kind: "waitFor", from: "done" } });
				const worker = result.ast.actors["@worker"];
				expect(worker?.kind).toBe("actor");
				if (worker?.kind === "actor") {
					expect(worker.states.publish).toMatchObject({
						kind: "state",
						action: { kind: "notify", to: "done" },
					});
				}
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retains runtime contract registries for sync and async parsing", async () => {
		const dir = mkdtempSync(join(process.cwd(), "tests", ".hyperchart-contract-parser-"));
		const path = join(dir, "chart.ts");
		try {
			writeFileSync(
				path,
				[
					'import { chart, contract, final, script, z } from "@surprisal/hyperchart";',
					'const Reply = contract("parser-reply", "1", z.string().refine((value) => value === "ok"));',
					'export default chart({ id: "contract-parser", initial: "run", states: { run: { kind: "state", action: script(process.execPath, ["-e", ""] , { reply: Reply }), transitions: { DONE: "done" } }, done: final() } });',
				].join("\n"),
			);
			const sync = parseChartModuleSync(path);
			const asyncResult = await parseChartModule(path);
			for (const result of [sync, asyncResult]) {
				expect(result.ok).toBe(true);
				if (!result.ok) {
					continue;
				}
				const state = result.ast.states.run;
				if (state?.kind !== "state" || state.action.kind !== "script" || state.action.reply === undefined) {
					throw new Error("missing reply");
				}
				expect(result.schemaRegistry.get(state.action.reply.runtimeContract!)).toBeDefined();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads a trusted local TS chart module and returns a normalized AST", async () => {
		const result = await parseChartModule(examplePath);

		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error("expected parser success");
		}
		expect(result.source.path).toBe(examplePath);
		expect(result.ast.id).toBe("review-and-fix");
		expect(result.ast.states.research?.kind).toBe("state");
		expect(result.ast).toMatchSnapshot();
	});
});
