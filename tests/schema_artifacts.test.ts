import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "../packages/hyperchart/src/index.js";
import type { RenderedArtifact } from "../packages/hyperchart/src/core/machine.js";
import type { JsonSchema, SchemaAst } from "../packages/hyperchart/src/core/types.js";
import { checkArtifactFile, resolveArtifactValue, serializeEnvValue } from "../packages/hyperchart/src/runtime/generic/artifacts.js";
import { checkSchema } from "../packages/hyperchart/src/runtime/generic/schema.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hyperchart-artifacts-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function schema(value: z.ZodType): SchemaAst {
	return { kind: "jsonSchema", schema: z.toJSONSchema(value) as JsonSchema };
}

describe("checkSchema", () => {
	it("validates zod-produced JSON Schema shapes", () => {
		const cases: Array<{ shape: SchemaAst; valid: unknown; invalid: unknown }> = [
			{ shape: schema(z.enum(["draft", "final"])), valid: "draft", invalid: "other" },
			{
				shape: schema(z.object({ id: z.string(), nested: z.object({ count: z.number() }) })),
				valid: { id: "x", nested: { count: 1 } },
				invalid: { id: "x", nested: { count: "1" } },
			},
			{ shape: schema(z.object({ maybe: z.string().optional() })), valid: {}, invalid: { maybe: 1 } },
			{ shape: schema(z.record(z.string(), z.number())), valid: { a: 1 }, invalid: { a: "1" } },
			{ shape: schema(z.array(z.object({ ok: z.boolean() }))), valid: [{ ok: true }], invalid: [{ ok: "yes" }] },
		];

		for (const item of cases) {
			expect(checkSchema(item.shape, item.valid), JSON.stringify(item.shape.schema)).toEqual({ ok: true });
			const invalid = checkSchema(item.shape, item.invalid);
			expect(invalid.ok).toBe(false);
			if (!invalid.ok) expect(invalid.errors.length).toBeGreaterThan(0);
		}
	});

	it("handles recursive zod JSON Schema refs", () => {
		const Category = z.object({
			name: z.string(),
			get children() {
				return z.array(Category);
			},
		});
		const categorySchema = schema(Category);

		expect(checkSchema(categorySchema, { name: "root", children: [{ name: "leaf", children: [] }] })).toEqual({
			ok: true,
		});
		const invalid = checkSchema(categorySchema, { name: "root", children: [{ name: 1, children: [] }] });
		expect(invalid.ok).toBe(false);
		if (!invalid.ok) expect(invalid.errors.join("\n")).toContain("/children/0/name");
	});
});

describe("artifacts", () => {
	it("resolves selected values after validating the whole file", async () => {
		const dir = await makeTempDir();
		await writeFile(join(dir, "evidence.json"), JSON.stringify({ facts: { score: 7 }, extra: true }), "utf8");
		const artifact: RenderedArtifact = {
			path: "evidence.json",
			shape: schema(z.object({ facts: z.object({ score: z.number() }), extra: z.boolean() })),
			select: "facts.score",
		};

		await expect(resolveArtifactValue(artifact, dir)).resolves.toBe(7);
	});

	it("returns file text for unshaped unselected artifacts", async () => {
		const dir = await makeTempDir();
		await writeFile(join(dir, "note.txt"), "hello", "utf8");

		await expect(resolveArtifactValue({ path: "note.txt" }, dir)).resolves.toBe("hello");
	});

	it("serializes string env values verbatim and JSON values as JSON", () => {
		expect(serializeEnvValue("plain")).toBe("plain");
		expect(serializeEnvValue({ x: 1 })).toBe('{"x":1}');
	});

	it("checks deliverable file existence and shape", async () => {
		const dir = await makeTempDir();
		const artifact: RenderedArtifact = { path: "out.json", shape: schema(z.object({ ok: z.boolean() })) };

		await expect(checkArtifactFile(artifact, dir)).resolves.toMatchObject({ ok: false });
		await writeFile(join(dir, "out.json"), JSON.stringify({ ok: true }), "utf8");
		await expect(checkArtifactFile(artifact, dir)).resolves.toEqual({ ok: true });
		await writeFile(join(dir, "out.json"), JSON.stringify({ ok: "yes" }), "utf8");
		await expect(checkArtifactFile(artifact, dir)).resolves.toMatchObject({ ok: false });
	});

	it("reports selector errors with artifact context", async () => {
		const dir = await makeTempDir();
		await writeFile(join(dir, "data.json"), JSON.stringify({ a: {} }), "utf8");

		await expect(resolveArtifactValue({ path: "data.json", select: "a.b" }, dir)).rejects.toThrow("selector 'a.b'");
	});

	it("rejects artifact paths outside the workDir", async () => {
		const dir = await makeTempDir();

		await expect(resolveArtifactValue({ path: "../secret.txt" }, dir)).rejects.toThrow("path escapes workDir");
		await expect(checkArtifactFile({ path: "../secret.txt" }, dir)).resolves.toMatchObject({
			ok: false,
			errors: [expect.stringContaining("path escapes workDir")],
		});
	});
});
