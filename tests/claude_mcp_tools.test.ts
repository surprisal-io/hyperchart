import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRunMeta, saveRunMeta } from "../packages/hyperchart/src/runtime/generic/run_dir.js";
import {
	hasTerminalNotificationReceipt,
	readTerminalNotificationRequest,
} from "../packages/hyperchart/src/runtime/generic/terminal_notifications.js";
import { patchRunStatus } from "../packages/hyperchart/src/runtime/generic/run_status.js";
import { updateSessionProgress } from "../packages/hyperchart/src/runtime/generic/session_progress.js";
import { closeRunInspectorServer } from "../packages/hyperchart/src/inspect/inspector_server.js";
import {
	createHyperchartMcpTools,
	type HyperchartMcpTool,
} from "../packages/claude-hyperchart/src/mcp/tools.js";

const roots: string[] = [];
let previousClaudeConfigDir: string | undefined;

beforeEach(() => {
	// Inspector overrides exported by the developer's shell must not leak into tests.
	delete process.env.HYPERCHART_INSPECTOR_PORT;
	delete process.env.HYPERCHART_INSPECTOR_HOST;
	delete process.env.SSH_CONNECTION;
	previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
});

afterEach(async () => {
	if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	await closeRunInspectorServer();
});

function makeWorld(sessionId?: string): {
	cwd: string;
	runsRoot: string;
	tools: Map<string, HyperchartMcpTool>;
	chartPath: string;
	chartsDir: string;
	userChartsDir: string;
} {
	const root = mkdtempSync(join(tmpdir(), "claude-mcp-"));
	roots.push(root);
	// User-scope settings must come from the test world, not the developer's ~/.claude.
	process.env.CLAUDE_CONFIG_DIR = join(root, "claude-config");
	const userChartsDir = join(root, "claude-config", "hypercharts");
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
		createHyperchartMcpTools({ cwd, runsRoot, ...(sessionId === undefined ? {} : { sessionId }), openBrowser: () => undefined }).map((tool) => [tool.name, tool]),
	);
	return { cwd, runsRoot, tools, chartPath, chartsDir, userChartsDir };
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
			"hyperchart_rewind",
			"hyperchart_run",
			"hyperchart_run_inspect",
			"hyperchart_steer",
			"hyperchart_stop",
			"hyperchart_view",
		]);
	});

	it("returns compact inspect digests by default and full objects with verbose", async () => {
		const { tools } = makeWorld();
		const digest = JSON.parse(text(await tools.get("hyperchart_inspect")!.handler({ chartPath: "simple" })));
		expect(digest.chartId).toBe("simple");
		expect(digest.definitionSource).toBeUndefined();
		expect(digest.states.every((state: object) => !("definitionSource" in state))).toBe(true);

		const full = JSON.parse(text(await tools.get("hyperchart_inspect")!.handler({ chartPath: "simple", verbose: true })));
		expect(full.definitionSource).toContain("chart(");

		const run = JSON.parse(text(await tools.get("hyperchart_run")!.handler({ chartPath: "simple", wait: true })));
		const runDigest = JSON.parse(text(await tools.get("hyperchart_run_inspect")!.handler({ runDir: run.runId })));
		expect(runDigest.runId).toBe(run.runId);
		expect(runDigest.status).toBe("completed");
		expect(runDigest.states.every((state: object) => !("definitionSource" in state))).toBe(true);
	}, 30_000);

	it("owns runs by the injected session and leases wait delivery without pre-confirming", async () => {
		const { tools, runsRoot, cwd } = makeWorld("session-a");
		const first = await tools.get("hyperchart_run")!.handler({ chartPath: "simple", wait: true });
		expect(text(first)).toContain("completed successfully");
		const [runId] = readdirSync(runsRoot);
		if (runId === undefined) throw new Error("expected run");
		const runDir = join(runsRoot, runId);
		expect(loadRunMeta(runDir).originSessionId).toBe("session-a");
		expect(hasTerminalNotificationReceipt(runDir, "claude", "session-a")).toBe(false);

		const second = JSON.parse(text(await tools.get("hyperchart_run")!.handler({ runDir: runId, wait: true })));
		expect(second.notification).toContain("confirmed or in progress");

		const foreignTools = new Map(createHyperchartMcpTools({ cwd, runsRoot, sessionId: "session-b" }).map((tool) => [tool.name, tool]));
		const foreign = JSON.parse(text(await foreignTools.get("hyperchart_run")!.handler({ runDir: runId, wait: true })));
		expect(foreign.limitation).toContain("not owned");
		expect(hasTerminalNotificationReceipt(runDir, "claude", "session-b")).toBe(false);
	}, 30_000);

	it("publishes the actual FAILED error before matching failed status", async () => {
		const { tools, chartsDir } = makeWorld();
		writeFileSync(join(chartsDir, "failure.chart.ts"), `import { chart, failed, script } from "@surprisal/hyperchart";
export default chart({ kind: "chart", id: "failure", initial: "work", states: {
	work: { kind: "state", action: script("node", ["-e", "console.error('specific boom'); process.exit(9)"]), transitions: { FAILED: "failed" } },
	failed: failed(),
} });
`);
		const run = JSON.parse(text(await tools.get("hyperchart_run")!.handler({ chartPath: "failure", wait: true })));
		expect(run.status).toMatchObject({ state: "failed", error: expect.stringContaining("specific boom") });
		const request = readTerminalNotificationRequest(run.runDir);
		expect(request?.payload).toMatchObject({ outcome: "failed", error: expect.stringContaining("specific boom") });
		expect(request?.payload.prompt).toContain("specific boom");
	}, 30_000);

	it("marks finals entered through a container's onDone as done", async () => {
		const { tools, chartsDir } = makeWorld();
		writeFileSync(
			join(chartsDir, "pardone.chart.ts"),
			`import { chart, compound, final, parallel, script } from "@surprisal/hyperchart";
const worker = () =>
	compound({
		initial: "step",
		states: {
			step: { kind: "state", action: script("node", ["-e", "process.exit(0)"]), transitions: { DONE: "done" } },
			done: final(),
		},
	});
export default chart({
	kind: "chart",
	id: "pardone",
	initial: "wrap",
	states: {
		wrap: compound({
			initial: "fan",
			states: {
				fan: parallel({ states: { left: worker(), right: worker() }, onDone: "done" }),
				done: final(),
			},
			onDone: "end",
		}),
		end: final(),
	},
});
`,
		);
		const run = JSON.parse(text(await tools.get("hyperchart_run")!.handler({ chartPath: "pardone", wait: true })));
		expect(run.status.state).toBe("complete");
		const digest = JSON.parse(text(await tools.get("hyperchart_run_inspect")!.handler({ runDir: run.runId })));
		const statusOf = (id: string) =>
			digest.states.find((state: { id: string }) => state.id === id)?.status ??
			(digest.pendingStates.includes(id) ? "pending" : undefined);
		expect(statusOf("wrap.done")).toBe("done");
		expect(statusOf("wrap")).toBe("done");
		expect(statusOf("wrap.fan")).toBe("done");
	}, 30_000);

	it("discovers charts and host-sectioned settings from the shared .hypercharts dir", async () => {
		const { tools, cwd } = makeWorld();
		const sharedDir = join(cwd, ".hypercharts");
		mkdirSync(sharedDir, { recursive: true });
		writeFileSync(
			join(sharedDir, "common.chart.ts"),
			`import { chart, final } from "@surprisal/hyperchart";
export default chart({ kind: "chart", id: "common", initial: "done", states: { done: final() } });
`,
		);
		writeFileSync(
			join(sharedDir, "settings.json"),
			JSON.stringify({
				pi: { roles: { reviewer: "pi/model" } },
				claude: { roles: { reviewer: "claude-haiku-4-5" }, toolsets: { reading: ["Read"] } },
			}),
		);

		const listed = JSON.parse(text(await tools.get("hyperchart_list")!.handler({})));
		expect(listed.charts).toEqual(
			expect.arrayContaining([
				{ name: "common", scope: "shared", chartPath: join(sharedDir, "common.chart.ts") },
				expect.objectContaining({ name: "simple", scope: "project" }),
			]),
		);

		const run = JSON.parse(text(await tools.get("hyperchart_run")!.handler({ chartPath: "common", wait: true })));
		expect(run.status.state).toBe("complete");
		const config = JSON.parse(readFileSync(join(run.runDir, "runner.config.json"), "utf8"));
		expect(config.modelRoles).toEqual({ reviewer: "claude-haiku-4-5" });
		expect(config.toolsets).toEqual({ reading: ["Read"] });
	}, 30_000);

	it("opens a static chart view without a run", async () => {
		const { tools } = makeWorld();
		const viewed = JSON.parse(text(await tools.get("hyperchart_view")!.handler({ chartPath: "simple", open: false })));
		expect(viewed.chartId).toBe("simple");
		expect(viewed.url).toContain("/runs/");
		const both = await tools.get("hyperchart_view")!.handler({});
		expect(both.isError).toBe(true);
	});

	it("rewinds a completed run and replays it to completion", async () => {
		const { tools, chartsDir } = makeWorld();
		writeFileSync(
			join(chartsDir, "steps.chart.ts"),
			`import { chart, final, script } from "@surprisal/hyperchart";
export default chart({
	kind: "chart",
	id: "steps",
	initial: "work",
	states: {
		work: { kind: "state", action: script("node", ["-e", "process.exit(0)"]), transitions: { DONE: "done" } },
		done: final(),
	},
});
`,
		);
		const run = JSON.parse(text(await tools.get("hyperchart_run")!.handler({ chartPath: "steps", wait: true })));
		expect(run.status.state).toBe("complete");
		const originalRequestId = readTerminalNotificationRequest(run.runDir)?.requestId;

		const rewound = JSON.parse(text(await tools.get("hyperchart_rewind")!.handler({ runDir: run.runId, state: "work" })));
		expect(rewound.removedRecords).toBeGreaterThan(0);
		expect(rewound.backupDir).toContain("rewind-backups");
		expect(existsSync(join(run.runDir, "terminal-notification"))).toBe(false);
		expect(existsSync(join(rewound.backupDir, "terminal-notification", "request.json"))).toBe(true);

		const resumed = JSON.parse(text(await tools.get("hyperchart_run")!.handler({ runDir: run.runId, wait: true })));
		expect(resumed.status.state).toBe("complete");
		expect(readTerminalNotificationRequest(run.runDir)?.requestId).not.toBe(originalRequestId);
	}, 30_000);

	it("lists charts, runs a chart to completion, and inspects the run", async () => {
		const { tools, runsRoot } = makeWorld();
		const listed = JSON.parse(text(await tools.get("hyperchart_list")!.handler({})));
		expect(listed.charts).toEqual([
			{ name: "simple", scope: "project", chartPath: join(listed.projectChartsDir, "simple.chart.ts") },
		]);
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

	it("lists user-scope charts and lets a same-named project chart win", async () => {
		const { tools, chartsDir, userChartsDir } = makeWorld();
		mkdirSync(join(userChartsDir, "bundle"), { recursive: true });
		writeFileSync(join(userChartsDir, "bundle", "chart.ts"), "export default {};\n");
		writeFileSync(join(userChartsDir, "simple.chart.ts"), "export default {};\n");
		writeFileSync(join(userChartsDir, "settings.json"), "{}");

		const listed = JSON.parse(text(await tools.get("hyperchart_list")!.handler({})));
		expect(listed.userChartsDir).toBe(userChartsDir);
		expect(listed.charts).toEqual([
			{ name: "bundle", scope: "user", chartPath: join(userChartsDir, "bundle", "chart.ts") },
			{ name: "simple", scope: "project", chartPath: join(chartsDir, "simple.chart.ts") },
		]);
	});

	it("passes merged model roles and toolsets from settings into the runner config", async () => {
		const { tools, chartsDir, userChartsDir } = makeWorld();
		mkdirSync(userChartsDir, { recursive: true });
		writeFileSync(
			join(userChartsDir, "settings.json"),
			JSON.stringify({ roles: { reviewer: "haiku", scout: "haiku" }, toolsets: { reading: ["Read", "Grep"] } }),
		);
		writeFileSync(
			join(chartsDir, "settings.json"),
			JSON.stringify({ roles: { reviewer: "opus" }, toolsets: { coding: ["Read", "Edit", "Bash"] } }),
		);

		const run = JSON.parse(text(await tools.get("hyperchart_run")!.handler({ chartPath: "simple", wait: true })));
		const config = JSON.parse(readFileSync(join(run.runDir, "runner.config.json"), "utf8"));

		expect(config.modelRoles).toEqual({ reviewer: "opus", scout: "haiku" });
		expect(config.toolsets).toEqual({ reading: ["Read", "Grep"], coding: ["Read", "Edit", "Bash"] });
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

		// The inspector's steering endpoint must land in the run's file queue.
		const steer = await fetch(`${viewed.url.replace("/runs/", "/api/runs/")}/steer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ actionKey: "simple:work:agent", message: "from inspector" }),
		});
		expect(steer.status).toBe(202);
		expect(readdirSync(join(runDir, "sessions", "steering"))).toHaveLength(1);
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
