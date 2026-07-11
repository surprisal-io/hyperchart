import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const hostDir = fileURLToPath(new URL("../packages/hyperchart/src/host", import.meta.url));

describe("neutral host boundary", () => {
	it("does not depend on Pi paths, storage, or runtime readers", () => {
		const source = readdirSync(hostDir)
			.filter((name) => name.endsWith(".ts"))
			.map((name) => readFileSync(join(hostDir, name), "utf8"))
			.join("\n");

		expect(source).not.toMatch(/runtime\/pi|PI_CODING_AGENT_DIR|["']\.pi["']/);
		expect(source).not.toMatch(/node:(?:fs|os)/);
	});

	it("does not export a Pi filesystem implementation", () => {
		const source = readFileSync(join(hostDir, "index.ts"), "utf8");

		expect(source).not.toContain("readHyperchartSessionSnapshot");
		expect(source).not.toContain("hyperchartRunFromRunDir");
	});
});
