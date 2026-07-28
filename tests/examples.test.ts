import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import deckDirector from "../examples/deck-director.chart.js";
import quickstart from "../examples/quickstart.chart.js";
import { normalizeChartConfig, z } from "../packages/hyperchart/src/index.js";
import { ScriptRunner } from "../packages/hyperchart/src/runtime/index.js";

describe("examples", () => {
	it("runs the portable quickstart and produces its documented artifact", async () => {
		const parsed = normalizeChartConfig(quickstart);
		expect(parsed.diagnostics).toEqual([]);
		if (!parsed.ok) throw new Error("expected valid quickstart chart");
		const write = parsed.ast.states.write;
		if (write?.kind !== "state" || write.action.kind !== "script") throw new Error("expected script state");

		const workDir = await mkdtemp(join(tmpdir(), "hyperchart-quickstart-"));
		const runner = new ScriptRunner({ workDir });
		try {
			const completion = await runner.run({
				kind: "script",
				id: "quickstart",
				actionUid: write.action.uid,
				action: write.action,
				command: write.action.command,
				args: write.action.args,
				artifacts: [{ name: "greeting", path: "hello.txt" }],
				events: ["DONE", "FAILED"],
			});
			expect(completion).toEqual({ type: "DONE" });
			expect(await readFile(join(workDir, "hello.txt"), "utf8")).toBe("Hello from Hyperchart\n");
		} finally {
			await runner.dispose();
			await rm(workDir, { recursive: true, force: true });
		}
	});

	it("deck-director chart normalizes cleanly", () => {
		const result = normalizeChartConfig(deckDirector);

		expect(result.diagnostics).toEqual([]);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected valid chart");
		// The bucket regions materialized under the parallel with absolute paths.
		expect(result.ast.states.research?.kind).toBe("map");
		expect(result.ast.states["research.scout"]?.kind).toBe("state");
		expect(result.ast.states["chapters.author"]?.kind).toBe("state");
		expect(result.ast.args?.topic).toEqual({
			description: "Subject or question for the report",
			default: "Google I/O 2026 announcements",
		});
	});

	it("zod shapes convert to plain JSON Schema in the AST", () => {
		// Authored as zod values (z re-exported by the library), stored as serializable data: the
		// runtime hands this JSON Schema to the agent and validates the reply/file against it.
		const parsed = normalizeChartConfig(deckDirector);
		if (!parsed.ok) throw new Error("expected valid chart");
		const plan = parsed.ast.states.plan;
		if (plan?.kind !== "state" || plan.action.kind !== "agent") throw new Error("expected agent state");
		expect(plan.action.reply).toMatchObject({
			kind: "jsonSchema",
			schema: { type: "object", required: ["artifacts_dir", "buckets", "coverage_thresholds"] },
		});
		const normalize = parsed.ast.states.normalize;
		if (normalize?.kind !== "state" || normalize.action.kind !== "script") throw new Error("expected agent state");
		expect(normalize.action.artifacts?.evidence?.shape).toMatchObject({
			kind: "jsonSchema",
			schema: { type: "object", required: ["facts"] },
		});
	});

	it("the re-exported z round-trips for runtime validation", () => {
		const Claims = z.object({ claims: z.array(z.object({ id: z.string() })) });
		expect(Claims.safeParse({ claims: [{ id: "c1" }] }).success).toBe(true);
		expect(Claims.safeParse({ claims: [{}] }).success).toBe(false);
	});
});
