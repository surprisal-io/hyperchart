import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveRunMeta } from "../packages/hyperchart/src/runtime/generic/run_dir.js";
import { patchRunStatus } from "../packages/hyperchart/src/runtime/generic/run_status.js";
import { updateSessionProgress } from "../packages/hyperchart/src/runtime/generic/session_progress.js";
import { closeRunInspectorServer } from "../packages/hyperchart/src/inspect/inspector_server.js";
import {
	createHyperchartMcpTools,
	type HyperchartMcpTool,
} from "../packages/claude-hyperchart/src/mcp/tools.js";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	await closeRunInspectorServer();
});

function makeWorld(): { cwd: string; runsRoot: string; tools: Map<string, HyperchartMcpTool>; chartPath: string } {
	const root = mkdtempSync(join(tmpdir(), "claude-mcp-"));
	roots.push(root);
	const cwd = join(root, "project");
	const chartsDir = join(cwd, ".claude", "hypercharts");
	mkdirSync(chartsDir, { recursive: true });
	const runsRoot = join(root, "runs-root");
	const chartPath = join(chartsDir, "simple.chart.ts");
	writeFileSync(
		chartPath,
		`import { chart, final } from "@surprisal/hyperchart";
export default chart({ kind: "chart", id: "simple", initial: "done", states: { done: final() } });
`,
	);
	const tools = new Map(
		createHyperchartMcpTools({ cwd, runsRoot, openBrowser: () => undefined }).map((tool) => [tool.name, tool]),
	);
	return { cwd, runsRoot, tools, chartPath };
}

function text(result: { content: Array<{ text: string }> }): string {
	return result.content[0]?.text ?? "";
}

describe("hyperchart MCP tools", () => {
	it("registers the full tool surface", () => {
		const { tools } = makeWorld();
		expect([...tools.keys()].sort()).toEqual([
			"hyperchart_inspect",
			"hyperchart_list",
			"hyperchart_run",
			"hyperchart_run_inspect",
			"hyperchart_steer",
			"hyperchart_stop",
			"hyperchart_view",
		]);
	});

	it("lists charts, runs a chart to completion, and inspects the run", async () => {
		const { tools, runsRoot } = makeWorld();
		const listed = JSON.parse(text(await tools.get("hyperchart_list")!.handler({})));
		expect(listed.charts).toEqual(["simple.chart.ts"]);
		expect(listed.runs).toEqual([]);

		const inspected = JSON.parse(text(await tools.get("hyperchart_inspect")!.handler({ chartPath: "simple" })));
		expect(inspected.chartId).toBe("simple");

		const run = JSON.parse(text(await tools.get("hyperchart_run")!.handler({ chartPath: "simple", wait: true })));
		expect(run.status.state).toBe("complete");
		expect(run.runDir.startsWith(runsRoot)).toBe(true);

		const runInfo = JSON.parse(text(await tools.get("hyperchart_run_inspect")!.handler({ runDir: run.runId })));
		expect(runInfo.runId).toBe(run.runId);
		expect(runInfo.states.some((state: { id: string }) => state.id === "done")).toBe(true);

		const relisted = JSON.parse(text(await tools.get("hyperchart_list")!.handler({})));
		expect(relisted.runs).toHaveLength(1);
	}, 30_000);

	it("queues steering for a live session and rejects dead sessions", async () => {
		const { tools, runsRoot, cwd, chartPath } = makeWorld();
		const runDir = join(runsRoot, "steer-run");
		mkdirSync(join(runDir, "sessions"), { recursive: true });
		saveRunMeta(runDir, { chartPath, workDir: cwd, chartId: "simple", createdAt: new Date().toISOString() });
		const actionUid = { chart: "simple", state: "work", action: "agent" };
		updateSessionProgress(join(runDir, "sessions"), actionUid, { actionName: "worker", status: "running" });

		const queued = await tools.get("hyperchart_steer")!.handler({
			runDir: "steer-run",
			actionKey: "simple:work:agent",
			message: "focus",
		});
		expect(queued.isError).toBeUndefined();
		expect(readdirSync(join(runDir, "sessions", "steering"))).toHaveLength(1);

		updateSessionProgress(join(runDir, "sessions"), actionUid, { status: "completed" });
		const rejected = await tools.get("hyperchart_steer")!.handler({
			runDir: "steer-run",
			actionKey: "simple:work:agent",
			message: "late",
		});
		expect(rejected.isError).toBe(true);
	});

	it("stops a run that is not live by marking it stopped", async () => {
		const { tools, runsRoot, cwd, chartPath } = makeWorld();
		const runDir = join(runsRoot, "stop-run");
		mkdirSync(join(runDir, "sessions"), { recursive: true });
		saveRunMeta(runDir, { chartPath, workDir: cwd, chartId: "simple", createdAt: new Date().toISOString() });
		patchRunStatus(runDir, { runId: "stop-run", chartId: "simple", state: "running" });

		const stopped = JSON.parse(text(await tools.get("hyperchart_stop")!.handler({ runDir: "stop-run" })));
		expect(stopped.stopped).toHaveLength(1);
		const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8"));
		expect(status.state).toBe("stopped");
	});

	it("opens the browser inspector and returns a tokenized URL", async () => {
		const { tools, runsRoot, cwd, chartPath } = makeWorld();
		const runDir = join(runsRoot, "view-run");
		mkdirSync(join(runDir, "sessions"), { recursive: true });
		saveRunMeta(runDir, { chartPath, workDir: cwd, chartId: "simple", createdAt: new Date().toISOString() });

		const viewed = JSON.parse(text(await tools.get("hyperchart_view")!.handler({ runDir: "view-run", open: false })));
		expect(viewed.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/runs\/[A-Za-z0-9_-]+$/);
		const response = await fetch(viewed.url.replace("/runs/", "/api/runs/"));
		expect(response.status).toBe(200);
		const payload = (await response.json()) as { run: { runId: string } };
		expect(payload.run.runId).toBe("view-run");
	});
});

describe("session start hook", () => {
	it("lists only live runs for the hook cwd", () => {
		const root = mkdtempSync(join(tmpdir(), "claude-hook-"));
		roots.push(root);
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		const runsRoot = join(root, "runs");
		const liveDir = join(runsRoot, "live-run");
		const deadDir = join(runsRoot, "dead-run");
		const foreignDir = join(runsRoot, "foreign-run");
		for (const dir of [liveDir, deadDir, foreignDir]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(liveDir, "meta.json"), JSON.stringify({ workDir: cwd, chartId: "one" }));
		writeFileSync(
			join(liveDir, "status.json"),
			JSON.stringify({ chartId: "one", state: "running", pid: process.pid, heartbeatAt: Date.now() }),
		);
		writeFileSync(join(deadDir, "meta.json"), JSON.stringify({ workDir: cwd, chartId: "two" }));
		writeFileSync(join(deadDir, "status.json"), JSON.stringify({ chartId: "two", state: "complete" }));
		writeFileSync(join(foreignDir, "meta.json"), JSON.stringify({ workDir: root, chartId: "three" }));
		writeFileSync(
			join(foreignDir, "status.json"),
			JSON.stringify({ chartId: "three", state: "running", pid: process.pid, heartbeatAt: Date.now() }),
		);

		const output = execFileSync(
			process.execPath,
			[resolve("packages/claude-hyperchart/hooks/session_start.mjs")],
			{
				input: JSON.stringify({ cwd, session_id: "s1" }),
				env: { ...process.env, HYPERCHART_RUNS_ROOT: runsRoot },
				encoding: "utf8",
			},
		);
		const parsed = JSON.parse(output) as { hookSpecificOutput: { additionalContext: string } };
		expect(parsed.hookSpecificOutput.additionalContext).toContain("live-run");
		expect(parsed.hookSpecificOutput.additionalContext).not.toContain("dead-run");
		expect(parsed.hookSpecificOutput.additionalContext).not.toContain("foreign-run");
	});
});
