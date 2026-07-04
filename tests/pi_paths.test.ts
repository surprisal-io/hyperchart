import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	getHyperchartRunsRoot,
	getProjectHyperchartsDir,
	resolveHyperchartPath,
	resolveHyperchartRunDir,
} from "../src/runtime/pi/paths.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hyperchart-paths-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("pi hyperchart paths", () => {
	it("resolves chart names from the nearest project .pi/hypercharts directory", async () => {
		const project = await makeTempDir();
		const subdir = join(project, "packages", "app");
		const chartsDir = join(project, ".pi", "hypercharts");
		await mkdir(subdir, { recursive: true });
		await mkdir(chartsDir, { recursive: true });
		await writeFile(join(chartsDir, "deck-director.chart.ts"), "export default {}", "utf8");

		expect(getProjectHyperchartsDir(subdir)).toBe(chartsDir);
		expect(resolveHyperchartPath("deck-director", subdir)).toBe(join(chartsDir, "deck-director.chart.ts"));
	});

	it("keeps run ids under the pi agent directory", async () => {
		const project = await makeTempDir();
		const agentDir = await makeTempDir();

		expect(getHyperchartRunsRoot(agentDir)).toBe(join(agentDir, "hypercharts", "runs"));
		expect(resolveHyperchartRunDir("run-1", project, agentDir)).toBe(join(agentDir, "hypercharts", "runs", "run-1"));
		expect(resolveHyperchartRunDir("./local-run", project, agentDir)).toBe(join(project, "local-run"));
	});
});
