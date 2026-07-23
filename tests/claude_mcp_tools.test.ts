import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRunMeta, saveRunMeta } from "../packages/hyperchart/src/runtime/generic/run_dir.js";
import {
	hasTerminalNotificationReceipt,
	readTerminalNotificationRequest,
} from "../packages/hyperchart/src/runtime/generic/terminal_notifications.js";
import { patchRunStatus } from "../packages/hyperchart/src/runtime/generic/run_status.js";
import {
	closeUserInteraction,
	hasUserInteractionReceipt,
	markUserInteractionReceipt,
	persistUserInteractionRequest,
	readUserInteractionResponse,
} from "../packages/hyperchart/src/runtime/generic/user_interactions.js";
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

function createUserGate(
	world: Pick<ReturnType<typeof makeWorld>, "runsRoot" | "cwd" | "chartPath">,
	runId: string,
	seqId: number,
	options: { sessionId?: string; workDir?: string; events?: string[] } = {},
) {
	const runDir = join(world.runsRoot, runId);
	const workDir = options.workDir ?? world.cwd;
	saveRunMeta(runDir, {
		chartPath: world.chartPath,
		workDir,
		chartId: "simple",
		createdAt: new Date().toISOString(),
		originSessionId: options.sessionId ?? "session-a",
	});
	patchRunStatus(runDir, { runId, chartId: "simple", state: "running", pid: process.pid, heartbeatAt: Date.now() });
	persistUserInteractionRequest(runDir, {
		runId,
		seqId,
		actionUid: { chart: "simple", state: "review", action: "user" },
		prompt: `Approve ${runId}?`,
		options: ["yes", "no"],
		events: options.events ?? ["APPROVED", "REJECTED", "FAILED"],
		reply: {
			kind: "jsonSchema",
			schema: { type: "object", properties: { note: { type: "string" } }, required: ["note"], additionalProperties: false },
		},
	});
	return runDir;
}

describe("hyperchart MCP tools", () => {
	it("registers the full tool surface", () => {
		const { tools } = makeWorld();
		expect([...tools.keys()].sort()).toEqual([
			"hyperchart_inspect",
			"hyperchart_list",
			"hyperchart_respond",
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

	it("returns the global active user boundary from wait=true without pre-confirming delivery", async () => {
		const world = makeWorld("session-a");
		const activeDir = createUserGate(world, "000-active-gate", 4);
		const result = JSON.parse(text(await world.tools.get("hyperchart_run")!.handler({ chartPath: "simple", wait: true })));
		expect(result).toMatchObject({
			boundary: "user",
			final: false,
			runId: "000-active-gate",
			interaction: { runId: "000-active-gate", seqId: 4 },
			presentation: "claimed-not-confirmed",
		});
		expect(basename(result.runDir)).toBe(basename(activeDir));
		expect(result.waitedRun.runId).not.toBe(result.runId);
		expect(result.instruction).toContain("AskUserQuestion once for this delivery attempt");
		expect(result.instruction).toContain("hyperchart_respond");
		expect(hasUserInteractionReceipt(activeDir, 4, "claude", "session-a")).toBe(false);
		closeUserInteraction(activeDir, { runId: "000-active-gate", seqId: 4 }, "test cleanup");
	}, 30_000);

	it("validates, commits, retries, and isolates hyperchart_respond at the exact active owner", async () => {
		const world = makeWorld("session-a");
		const activeDir = createUserGate(world, "run-a", 1);
		const queuedDir = createUserGate(world, "run-b", 2);
		const respond = world.tools.get("hyperchart_respond")!;

		for (const [args, pattern] of [
			[{ runId: "run-a", seqId: 1, event: "FAILED", output: { note: "x" } }, /reserved/],
			[{ runId: "run-a", seqId: 1, event: "OTHER", output: { note: "x" } }, /not allowed/],
			[{ runId: "run-a", seqId: 1, event: "APPROVED", output: {} }, /does not match/],
			[{ runId: "run-b", seqId: 2, event: "APPROVED", output: { note: "early" } }, /not the active gate/],
		] as const) {
			const rejected = await respond.handler(args);
			expect(rejected.isError).toBe(true);
			expect(text(rejected)).toMatch(pattern);
		}

		const committed = JSON.parse(text(await respond.handler({
			runId: "run-a",
			seqId: 1,
			event: "APPROVED",
			output: { note: "human said yes" },
		})));
		expect(committed).toMatchObject({ committed: true, idempotent: false, runId: "run-a", seqId: 1 });
		expect(readUserInteractionResponse(activeDir, 1)?.event).toEqual({ type: "APPROVED", output: { note: "human said yes" } });

		// Identical durable retry must not require reparsing mutable chart source.
		writeFileSync(world.chartPath, "this is no longer valid TypeScript");
		const retried = JSON.parse(text(await respond.handler({
			runId: "run-a",
			seqId: 1,
			event: "APPROVED",
			output: { note: "human said yes" },
		})));
		expect(retried.idempotent).toBe(true);
		const conflict = await respond.handler({ runId: "run-a", seqId: 1, event: "REJECTED", output: { note: "different" } });
		expect(conflict.isError).toBe(true);
		expect(text(conflict)).toContain("Conflicting response");

		const foreignSession = new Map(createHyperchartMcpTools({ cwd: world.cwd, runsRoot: world.runsRoot, sessionId: "session-b" }).map((tool) => [tool.name, tool]));
		const deniedSession = await foreignSession.get("hyperchart_respond")!.handler({ runId: "run-b", seqId: 2, event: "APPROVED", output: { note: "x" } });
		expect(deniedSession.isError).toBe(true);
		expect(text(deniedSession)).toContain("not owned");
		const deniedCwd = await respond.handler({ runId: "run-b", seqId: 2, event: "APPROVED", output: { note: "x" }, cwd: resolve(world.cwd, "other") });
		expect(deniedCwd.isError).toBe(true);
		expect(text(deniedCwd)).toContain("another working directory");

		closeUserInteraction(queuedDir, { runId: "run-b", seqId: 2 }, "machine cancelled");
		const stale = await respond.handler({ runId: "run-b", seqId: 2, event: "APPROVED", output: { note: "late" } });
		expect(stale.isError).toBe(true);
		expect(text(stale)).toMatch(/stale|closed/);
	});

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
		writeFileSync(join(liveDir, "meta.json"), JSON.stringify({ workDir: cwd, chartId: "one", originSessionId: "s1" }));
		writeFileSync(
			join(liveDir, "status.json"),
			JSON.stringify({ chartId: "one", state: "running", pid: process.pid, heartbeatAt: Date.now() }),
		);
		writeFileSync(join(deadDir, "meta.json"), JSON.stringify({ workDir: cwd, chartId: "two", originSessionId: "s1" }));
		writeFileSync(join(deadDir, "status.json"), JSON.stringify({ chartId: "two", state: "complete" }));
		writeFileSync(join(foreignDir, "meta.json"), JSON.stringify({ workDir: root, chartId: "three", originSessionId: "s1" }));
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

	it("recovers the exact session's already-presented pinned gate before queued gates", () => {
		const world = makeWorld("session-a");
		createUserGate(world, "run-a", 1);
		const pinnedDir = createUserGate(world, "run-b", 2);
		createUserGate(world, "foreign-session", 1, { sessionId: "session-b" });
		markUserInteractionReceipt(pinnedDir, 2, "claude", "session-a");
		const hook = resolve("packages/claude-hyperchart/hooks/session_start.mjs");
		const invoke = (sessionId: string) => execFileSync(process.execPath, [hook], {
			input: JSON.stringify({ cwd: world.cwd, session_id: sessionId }),
			env: { ...process.env, HYPERCHART_RUNS_ROOT: world.runsRoot },
			encoding: "utf8",
		});

		const first = JSON.parse(invoke("session-a")) as { hookSpecificOutput: { additionalContext: string } };
		expect(first.hookSpecificOutput.additionalContext).toContain("ACTIVE HYPERCHART USER GATE (run-b, 2)");
		expect(first.hookSpecificOutput.additionalContext).toContain("AskUserQuestion is still in flight");
		expect(first.hookSpecificOutput.additionalContext).toContain("hyperchart_respond");
		expect(first.hookSpecificOutput.additionalContext).not.toContain("ACTIVE HYPERCHART USER GATE (run-a, 1)");
		expect(first.hookSpecificOutput.additionalContext).not.toContain("foreign-session");
		expect(invoke("session-x")).toBe("");

		closeUserInteraction(pinnedDir, { runId: "run-b", seqId: 2 }, "answered elsewhere");
		const promoted = JSON.parse(invoke("session-a")) as { hookSpecificOutput: { additionalContext: string } };
		expect(promoted.hookSpecificOutput.additionalContext).toContain("ACTIVE HYPERCHART USER GATE (run-a, 1)");
	});
});
