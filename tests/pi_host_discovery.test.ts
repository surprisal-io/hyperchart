import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiHyperchartHost } from "../packages/pi-hyperchart/src/runtime/pi/host_adapter.js";
import { updateSessionProgress } from "../packages/hyperchart/src/runtime/generic/session_progress.js";

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
		`export default { kind: "chart", id: "sample", args: { topic: { description: "Research subject", default: "Hyperchart" } }, initial: "work", states: {
  work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } },
  done: { kind: "final" },
} };\n`,
		"utf8",
	);
	return chartPath;
}

async function writeWaitingMapChart(projectDir: string): Promise<string> {
	const chartsDir = join(projectDir, ".pi", "hypercharts");
	await mkdir(chartsDir, { recursive: true });
	const chartPath = join(chartsDir, "waiting-map.chart.ts");
	await writeFile(
		chartPath,
		`export default { kind: "chart", id: "waiting-map", initial: "items", states: {
  items: { kind: "map", over: { kind: "arg", name: "items" }, concurrency: 1, initial: "work", onDone: "done", states: {
    work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } },
    done: { kind: "final" },
  } },
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
	it("returns lightweight chart definition summaries without graph snapshots", async () => {
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
		expect(Object.keys(snapshot.hypercharts[0] ?? {}).sort()).toEqual([
			"description",
			"name",
			"scope",
			"source",
			"stateCount",
			"updatedAt",
		]);
		expect(snapshot.hypercharts[0]).not.toHaveProperty("args");
		expect(snapshot.hypercharts[0]).not.toHaveProperty("states");
		expect(snapshot.hypercharts[0]).not.toHaveProperty("definitionSource");
		expect(snapshot.hypercharts[0]).not.toHaveProperty("phases");
	});

	it("loads launch argument metadata only through on-demand chart inspection", async () => {
		const projectDir = await tempDir("hyperchart-project-");
		const agentDir = await tempDir("hyperchart-agent-");
		await writeChart(projectDir);
		const host = createPiHyperchartHost({ agentDir });

		const summary = await host.readSessionSnapshot(projectDir);
		const definition = await host.readChartSnapshot(projectDir, "sample");

		expect(summary.hypercharts[0]).not.toHaveProperty("args");
		expect(definition).toMatchObject({
			name: "sample",
			args: { topic: { description: "Research subject", default: "Hyperchart" } },
			stateCount: 2,
		});
		expect(definition?.states?.map((state) => state.id)).toEqual(["work", "done"]);
		expect(await host.readChartSnapshot(projectDir, "missing")).toBeUndefined();
	});

	it("does not retain agent definition details in session summaries", async () => {
		const projectDir = await tempDir("hyperchart-project-");
		const agentDir = await tempDir("hyperchart-agent-");
		await writeChart(projectDir);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "worker.md"),
			"---\nname: worker\nmodel: provider/model\nthinking: high\ntools: read, write\n---\nWorker instructions.\n",
			"utf8",
		);

		const snapshot = await createPiHyperchartHost({ agentDir }).readSessionSnapshot(projectDir);

		expect(snapshot.hypercharts[0]).toMatchObject({ name: "sample", stateCount: 2 });
		expect(snapshot.hypercharts[0]).not.toHaveProperty("states");
	});

	it("does not execute chart modules while building session summaries", async () => {
		const projectDir = await tempDir("hyperchart-project-");
		const agentDir = await tempDir("hyperchart-agent-");
		const chartsDir = join(projectDir, ".pi", "hypercharts");
		const marker = join(projectDir, "summary-side-effect.txt");
		await mkdir(chartsDir, { recursive: true });
		const chartPath = join(chartsDir, "side-effect.chart.ts");
		await writeFile(
			chartPath,
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\nexport default { kind: "chart", id: "side-effect", initial: "done", states: { done: { kind: "final" } } };\n`,
			"utf8",
		);
		const runDir = join(agentDir, "hypercharts", "runs", "side-effect-run");
		await mkdir(runDir, { recursive: true });
		await writeFile(join(runDir, "meta.json"), JSON.stringify({
			chartPath,
			workDir: projectDir,
			chartId: "side-effect",
			createdAt: "2026-07-10T00:00:00.000Z",
		}), "utf8");
		await writeFile(join(runDir, "status.json"), JSON.stringify({
			version: 1,
			runId: "side-effect-run",
			runDir,
			chartId: "side-effect",
			state: "complete",
			startedAt: 1,
			updatedAt: 2,
		}), "utf8");
		await writeFile(join(runDir, "log.jsonl"), "", "utf8");

		const snapshot = await createPiHyperchartHost({ agentDir }).readSessionSnapshot(projectDir);

		expect(snapshot.hypercharts).toEqual([
			expect.objectContaining({ name: "side-effect", stateCount: 1 }),
		]);
		expect(snapshot.runs).toEqual([
			expect.objectContaining({ runId: "side-effect-run", chartName: "side-effect", status: "completed" }),
		]);
		expect(snapshot.runs[0]).not.toHaveProperty("stateCount");
		expect(existsSync(marker)).toBe(false);
	});

	it("loads only the selected definition and honors project, shared, then user precedence", async () => {
		const projectDir = await tempDir("hyperchart-project-");
		const agentDir = await tempDir("hyperchart-agent-");
		const projectChartsDir = join(projectDir, ".pi", "hypercharts");
		const sharedChartsDir = join(projectDir, ".hypercharts");
		const userChartsDir = join(agentDir, "hypercharts");
		const unrelatedMarker = join(projectDir, "unrelated-side-effect.txt");
		const shadowedMarker = join(projectDir, "shadowed-side-effect.txt");
		await Promise.all([
			mkdir(projectChartsDir, { recursive: true }),
			mkdir(sharedChartsDir, { recursive: true }),
			mkdir(userChartsDir, { recursive: true }),
		]);
		await writeFile(
			join(projectChartsDir, "selected.chart.ts"),
			'export default { kind: "chart", id: "clash", initial: "project", states: { project: { kind: "final" } } };\n',
			"utf8",
		);
		await writeFile(
			join(sharedChartsDir, "selected.chart.ts"),
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(shadowedMarker)}, "shared");\nexport default { kind: "chart", id: "clash", initial: "shared", states: { shared: { kind: "final" } } };\n`,
			"utf8",
		);
		await writeFile(
			join(userChartsDir, "selected.chart.ts"),
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(shadowedMarker)}, "user");\nexport default { kind: "chart", id: "clash", initial: "user", states: { user: { kind: "final" } } };\n`,
			"utf8",
		);
		await writeFile(
			join(projectChartsDir, "unrelated.chart.ts"),
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(unrelatedMarker)}, "executed");\nexport default { kind: "chart", id: "unrelated", initial: "done", states: { done: { kind: "final" } } };\n`,
			"utf8",
		);

		const host = createPiHyperchartHost({ agentDir });
		const summary = await host.readSessionSnapshot(projectDir);
		const definition = await host.readChartSnapshot(projectDir, "clash");

		expect(summary.hypercharts.find((chart) => chart.name === "clash")?.source).toBe(join(projectChartsDir, "selected.chart.ts"));
		expect(definition?.source).toBe(join(projectChartsDir, "selected.chart.ts"));
		expect(definition?.states?.map((state) => state.id)).toEqual(["project"]);
		expect(existsSync(unrelatedMarker)).toBe(false);
		expect(existsSync(shadowedMarker)).toBe(false);
	});

	it("omits graph-derived summary fields when a module only re-exports its definition", async () => {
		const projectDir = await tempDir("hyperchart-project-");
		const agentDir = await tempDir("hyperchart-agent-");
		const chartsDir = join(projectDir, ".pi", "hypercharts");
		await mkdir(chartsDir, { recursive: true });
		await writeFile(join(chartsDir, "modular.chart.ts"), 'export { default } from "./definition.mjs";\n', "utf8");
		await writeFile(join(chartsDir, "definition.mjs"), 'export default { kind: "chart", id: "modular", initial: "only", states: { only: { kind: "final" } } };\n', "utf8");

		const summary = await createPiHyperchartHost({ agentDir }).readSessionSnapshot(projectDir);

		expect(summary.hypercharts).toEqual([
			expect.objectContaining({ name: "modular", source: join(chartsDir, "modular.chart.ts") }),
		]);
		expect(summary.hypercharts[0]).not.toHaveProperty("stateCount");
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
		const hostUrl = new URL("../packages/pi-hyperchart/dist/runtime/pi/host_adapter.js", import.meta.url).href;
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
			expect.objectContaining({ runId: "generated-run", chartName: "generated", status: "completed" }),
		]);
		expect(JSON.parse(child.stdout)[0]).not.toHaveProperty("stateCount");
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
			originSessionId: "session-a",
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
			originSessionId: "session-a",
		});
		expect(snapshot.runs[0]).not.toHaveProperty("args");
		expect(snapshot.runs[0]).not.toHaveProperty("states");
		expect(snapshot.runs[0]).not.toHaveProperty("stateCount");
		expect(snapshot.runs[0]).not.toHaveProperty("activeState");
		expect(snapshot.runs[0]).not.toHaveProperty("phases");
	});

	it("keeps graph-derived run fields behind on-demand run inspection", async () => {
		const projectDir = await tempDir("hyperchart-project-");
		const agentDir = await tempDir("hyperchart-agent-");
		const chartPath = await writeWaitingMapChart(projectDir);
		const runDir = join(agentDir, "hypercharts", "runs", "waiting-map-run");
		await mkdir(runDir, { recursive: true });
		await writeFile(join(runDir, "meta.json"), JSON.stringify({
			chartPath,
			workDir: projectDir,
			chartId: "waiting-map",
			createdAt: "2026-07-10T00:00:00.000Z",
		}), "utf8");
		const actionUid = { chart: "waiting-map", state: "items#a.work", action: "agent" };
		await writeFile(join(runDir, "log.jsonl"), [
			{ type: "args", args: { items: { a: "Alpha", b: "Beta", c: "Gamma" } }, parentId: null, seqId: 1, timestamp: 1 },
			{ type: "spawned", path: "items", instances: { a: "Alpha", b: "Beta", c: "Gamma" }, parentId: 1, seqId: 2, timestamp: 2 },
			{
				type: "state_action",
				kind: "invoke",
				actionUid,
				definition: {
					kind: "agent",
					uid: { chart: "waiting-map", state: "items.work", action: "agent" },
					name: "worker",
				},
				parentId: 2,
				seqId: 3,
				timestamp: 3,
			},
		].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");

		const host = createPiHyperchartHost({ agentDir });
		const snapshot = await host.readSessionSnapshot(projectDir, { runLimit: 1 });
		const full = await host.readRunSnapshot(projectDir, "waiting-map-run");
		const waitingCount = full?.states.filter((state) => state.status === "waiting").length;

		expect(waitingCount).toBeGreaterThan(0);
		expect(full?.stateCount).toBeGreaterThan(0);
		expect(snapshot.runs[0]).not.toHaveProperty("stateCount");
		expect(snapshot.runs[0]).not.toHaveProperty("progressPercent");
		expect(snapshot.runs[0]).not.toHaveProperty("activeStateCount");
	});

	it("keeps session snapshots summary-only and loads full transcripts through the inspector API", async () => {
		const projectDir = await tempDir("hyperchart-project-");
		const agentDir = await tempDir("hyperchart-agent-");
		const chartPath = await writeChart(projectDir);
		const runDir = join(agentDir, "hypercharts", "runs", "transcript-run");
		const sessionsDir = join(runDir, "sessions");
		await mkdir(sessionsDir, { recursive: true });
		await writeFile(join(runDir, "meta.json"), JSON.stringify({
			chartPath,
			workDir: projectDir,
			chartId: "sample",
			createdAt: "2026-07-10T00:00:00.000Z",
		}), "utf8");
		const actionUid = { chart: "sample", state: "work", action: "agent" };
		await writeFile(join(runDir, "log.jsonl"), [
			{ type: "args", args: {}, parentId: null, seqId: 1, timestamp: 1 },
			{ type: "state_action", kind: "invoke", actionUid, definition: { kind: "agent", uid: actionUid, name: "worker" }, parentId: 1, seqId: 2, timestamp: 2 },
		].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
		const transcriptFile = join(sessionsDir, "transcript.jsonl");
		await writeFile(transcriptFile, `${JSON.stringify({ id: "message-1", type: "message", message: { role: "assistant", content: "large transcript payload" } })}\n`, "utf8");
		updateSessionProgress(sessionsDir, actionUid, {
			actionName: "worker",
			status: "running",
			sessionFile: transcriptFile,
		}, "sample:work:agent:1:2");

		const host = createPiHyperchartHost({ agentDir });
		const summary = await host.readSessionSnapshot(projectDir, { runLimit: 1 });
		const full = await host.readRunSnapshot(projectDir, "transcript-run");
		const fullSession = full?.states.find((state) => state.id === "work")?.session;

		expect(summary.runs[0]).toMatchObject({ runId: "transcript-run" });
		expect(summary.runs[0]).not.toHaveProperty("states");
		expect(summary.runs[0]).not.toHaveProperty("activeState");
		expect(JSON.stringify(summary)).not.toContain("large transcript payload");
		expect(fullSession?.messages).toEqual([
			{ id: "message-1", role: "assistant", text: "large transcript payload" },
		]);
	});

	it("keeps a metadata-only run visible with persisted status when runtime inspection fails", async () => {
		const projectDir = await tempDir("hyperchart-project-");
		const agentDir = await tempDir("hyperchart-agent-");
		const runDir = join(agentDir, "hypercharts", "runs", "missing-chart-run");
		await mkdir(runDir, { recursive: true });
		await writeFile(join(runDir, "meta.json"), JSON.stringify({
			chartPath: join(projectDir, "deleted.chart.ts"),
			workDir: projectDir,
			chartId: "deleted-chart",
			createdAt: "2026-07-10T00:00:00.000Z",
		}), "utf8");
		await writeFile(join(runDir, "status.json"), JSON.stringify({
			version: 1,
			runId: "missing-chart-run",
			runDir,
			chartId: "deleted-chart",
			state: "complete",
			startedAt: 10,
			updatedAt: 20,
			exitCode: 0,
		}), "utf8");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const host = createPiHyperchartHost({ agentDir });
		const snapshot = await host.readSessionSnapshot(projectDir);
		const full = await host.readRunSnapshot(projectDir, "missing-chart-run");

		warn.mockRestore();
		expect(snapshot.runs).toEqual([
			expect.objectContaining({
				runId: "missing-chart-run",
				chartName: "deleted-chart",
				status: "completed",
				cwd: projectDir,
			}),
		]);
		expect(snapshot.runs[0]).not.toHaveProperty("issues");
		expect(full?.issues?.[0]).toMatchObject({
			severity: "error",
			kind: "run_failed",
			source: "status",
		});
	});
});
