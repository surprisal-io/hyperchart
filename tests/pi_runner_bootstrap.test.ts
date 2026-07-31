import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const bootstrapSource = fileURLToPath(
	new URL("../packages/pi-hyperchart/src/runtime/pi/hyperchart_runner.mjs", import.meta.url),
);
let tempDir = "";

afterEach(() => {
	if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true });
});

describe("Pi runner bootstrap", () => {
	it("loads Pi host modules from the exact entries supplied by the extension", () => {
		tempDir = mkdtempSync(join(repoRoot, ".hyperchart-pi-bootstrap-"));
		const bootstrap = join(tempDir, "hyperchart_runner.mjs");
		const configPath = join(tempDir, "runner.config.json");
		const outputPath = join(tempDir, "loaded.json");
		const codingAgent = join(tempDir, "active-pi.mjs");
		const typebox = join(tempDir, "active-typebox.mjs");
		copyFileSync(bootstrapSource, bootstrap);
		writeFileSync(codingAgent, `export const hostMarker = "active-pi";\n`, "utf8");
		writeFileSync(typebox, `export const typeboxMarker = "active-typebox";\n`, "utf8");
		writeFileSync(
			join(tempDir, "hyperchart_runner.ts"),
			`import { writeFileSync } from "node:fs";
import { hostMarker } from "@earendil-works/pi-coding-agent";
import { typeboxMarker } from "typebox";
export async function main(argv: string[]) {
  const config = JSON.parse(readFileSync(argv[0], "utf8"));
  writeFileSync(config.outputPath, JSON.stringify({ hostMarker, typeboxMarker }));
}
import { readFileSync } from "node:fs";
`,
			"utf8",
		);
		writeFileSync(
			configPath,
			JSON.stringify({ outputPath, piModules: { codingAgent, typebox } }),
			"utf8",
		);

		execFileSync(process.execPath, [bootstrap, configPath], {
			cwd: repoRoot,
			stdio: "pipe",
		});

		expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual({
			hostMarker: "active-pi",
			typeboxMarker: "active-typebox",
		});
	});
});
