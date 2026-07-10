import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiHyperchartHost } from "../src/runtime/pi/host_adapter.js";

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function writeChart(projectDir: string): Promise<string> {
	const chartsDir = join(projectDir, ".pi", "hypercharts");
	await mkdir(chartsDir, { recursive: true });
	const chartPath = join(chartsDir, "sample.chart.ts");
	await writeFile(
		chartPath,
		`export default { kind: "chart", id: "sample", initial: "work", states: {
  work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } },
  done: { kind: "final" },
} };\n`,
		"utf8",
	);
	return chartPath;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Pi Hyperchart host adapter", () => {
	it("returns canonical state-based chart definitions", async () => {
		const projectDir = await tempDir("hyperchart-project-");
		const agentDir = await tempDir("hyperchart-agent-");
		const chartPath = await writeChart(projectDir);

		const snapshot = await createPiHyperchartHost({ agentDir }).readSessionSnapshot(projectDir);

		expect(snapshot.runs).toEqual([]);
		expect(snapshot.hypercharts).toHaveLength(1);
		expect(snapshot.hypercharts[0]).toMatchObject({
			name: "sample",
			scope: "project",
			source: chartPath,
			stateCount: 2,
		});
		expect(snapshot.hypercharts[0]?.states?.map((state) => state.id)).toEqual(["work", "done"]);
		expect(snapshot.hypercharts[0]).not.toHaveProperty("phases");
	});

	it("reflects changes in imported chart definitions", async () => {
		const projectDir = await tempDir("hyperchart-project-");
		const agentDir = await tempDir("hyperchart-agent-");
		const chartsDir = join(projectDir, ".pi", "hypercharts");
		await mkdir(chartsDir, { recursive: true });
		await writeFile(join(chartsDir, "modular.chart.ts"), 'export { default } from "./definition.mjs";\n', "utf8");
		const definitionPath = join(chartsDir, "definition.mjs");
		await writeFile(definitionPath, 'export default { kind: "chart", id: "modular", initial: "only", states: { only: { kind: "final" } } };\n', "utf8");

		const host = createPiHyperchartHost({ agentDir });
		const first = await host.readSessionSnapshot(projectDir);
		await writeFile(definitionPath, 'export default { kind: "chart", id: "modular", initial: "first", states: { first: { kind: "state", action: { kind: "script", command: "true" }, transitions: { DONE: "done" } }, done: { kind: "final" } } };\n', "utf8");
		const second = await host.readSessionSnapshot(projectDir);

		expect(first.hypercharts.find((chart) => chart.name === "modular")?.stateCount).toBe(1);
		expect(second.hypercharts.find((chart) => chart.name === "modular")?.stateCount).toBe(2);
	});

	it("uses PI_CODING_AGENT_DIR when agentDir is omitted", async () => {
		const projectDir = await tempDir("hyperchart-project-");
		const agentDir = await tempDir("hyperchart-agent-");
		const userChartsDir = join(agentDir, "hypercharts");
		await mkdir(userChartsDir, { recursive: true });
		await writeFile(join(userChartsDir, "user.chart.ts"), 'export default { kind: "chart", id: "user-chart", initial: "done", states: { done: { kind: "final" } } };\n', "utf8");
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const snapshot = await createPiHyperchartHost().readSessionSnapshot(projectDir);
			expect(snapshot.hypercharts).toEqual([expect.objectContaining({ name: "user-chart", scope: "user" })]);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
	});

	it("loads CommonJS output stored with an mjs extension by Pi skills", async () => {
		const projectDir = await tempDir("hyperchart-project-");
		const agentDir = await tempDir("hyperchart-agent-");
		const chartPath = join(projectDir, "generated.chart.mjs");
		await writeFile(
			chartPath,
			'"use strict"; Object.defineProperty(exports, "__esModule", { value: true }); exports.default = { kind: "chart", id: "generated", initial: "done", states: { done: { kind: "final" } } };\n',
			"utf8",
		);
		const runDir = join(agentDir, "hypercharts", "runs", "generated-run");
		await mkdir(runDir, { recursive: true });
		await writeFile(join(runDir, "meta.json"), JSON.stringify({
			chartPath,
			workDir: projectDir,
			chartId: "generated",
			createdAt: "2026-07-10T00:00:00.000Z",
		}), "utf8");
		await writeFile(join(runDir, "status.json"), JSON.stringify({
			version: 1,
			runId: "generated-run",
			runDir,
			chartId: "generated",
			state: "complete",
			startedAt: 1,
			updatedAt: 2,
		}), "utf8");
		await writeFile(join(runDir, "log.jsonl"), "", "utf8");

		const require = createRequire(import.meta.url);
		const registerUrl = pathToFileURL(join(dirname(require.resolve("jiti/package.json")), "lib", "jiti-register.mjs")).href;
		const hostUrl = new URL("../dist/src/runtime/pi/host_adapter.js", import.meta.url).href;
		const script = `
let hostModule = await import(${JSON.stringify(hostUrl)});
while (hostModule && typeof hostModule === "object" && Object.keys(hostModule).length === 1 && "default" in hostModule) hostModule = hostModule.default;
const snapshot = await hostModule.createPiHyperchartHost({ agentDir: ${JSON.stringify(agentDir)} }).readSessionSnapshot(${JSON.stringify(projectDir)});
console.log(JSON.stringify(snapshot.runs));`;
		const child = spawnSync(process.execPath, ["--import", registerUrl, "--input-type=module", "-e", script], {
			cwd: projectDir,
			encoding: "utf8",
		});

		expect(child.status, child.stderr).toBe(0);
		expect(JSON.parse(child.stdout)).toEqual([
			expect.objectContaining({ runId: "generated-run", chartName: "generated", status: "completed", stateCount: 1 }),
		]);
	});

	it("loads matching runs through the runtime-backed adapter and isolates malformed runs", async () => {
		const projectDir = await tempDir("hyperchart-project-");
		const agentDir = await tempDir("hyperchart-agent-");
		const chartPath = await writeChart(projectDir);
		const runsRoot = join(agentDir, "hypercharts", "runs");
		const runDir = join(runsRoot, "sample-run");
		const malformedDir = join(runsRoot, "malformed-run");
		await mkdir(join(runDir, "sessions"), { recursive: true });
		await mkdir(malformedDir, { recursive: true });
		await writeFile(join(runDir, "meta.json"), JSON.stringify({
			chartPath,
			workDir: projectDir,
			chartId: "sample",
			createdAt: "2026-07-10T00:00:00.000Z",
		}), "utf8");
		await writeFile(join(runDir, "status.json"), JSON.stringify({
			version: 1,
			runId: "sample-run",
			runDir,
			chartId: "sample",
			state: "running",
			startedAt: 1,
			updatedAt: 2,
		}), "utf8");
		await writeFile(join(runDir, "log.jsonl"), `${JSON.stringify({ type: "args", args: { topic: "native" }, seqId: 1, parentId: null, timestamp: 1 })}\n`, "utf8");
		await writeFile(join(malformedDir, "meta.json"), "not json", "utf8");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const host = createPiHyperchartHost({ agentDir });
		const snapshot = await host.readSessionSnapshot(projectDir, { runLimit: 10 });
		await host.readSessionSnapshot(projectDir, { runLimit: 10 });

		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
		expect(snapshot.runs).toHaveLength(1);
		expect(snapshot.runs[0]).toMatchObject({
			runId: "sample-run",
			chartName: "sample",
			status: "running",
			cwd: projectDir,
			args: { topic: "native" },
			stateCount: 2,
		});
		expect(snapshot.runs[0]?.states.map((state) => state.id)).toEqual(["work", "done"]);
		expect(snapshot.runs[0]).not.toHaveProperty("phases");
	});
});
