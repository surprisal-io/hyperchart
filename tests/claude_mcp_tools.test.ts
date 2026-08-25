import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadRunMeta, saveRunMeta } from "../packages/hyperchart/src/runtime/generic/run_dir.js";
import {
	hasTerminalNotificationReceipt,
	readTerminalNotificationRequest,
} from "../packages/hyperchart/src/runtime/generic/terminal_notifications.js";
import { patchRunStatus } from "../packages/hyperchart/src/runtime/generic/run_status.js";
import {
	hasUserInteractionReceipt,
	markUserInteractionReceipt,
	readUserInteractionResponse,
} from "../packages/hyperchart/src/runtime/generic/user_interactions.js";
import { actionUidKey, updateSessionProgress } from "../packages/hyperchart/src/runtime/generic/session_progress.js";
import { closeRunInspectorServer } from "../packages/hyperchart/src/inspect/inspector_server.js";
import {
	createHyperchartMcpTools,
	type HyperchartMcpTool,
} from "../packages/claude-hyperchart/src/mcp/tools.js";
import type { ReplySchemaSummary } from "../packages/hyperchart/src/host/summarize.js";
import { answerFromReplySummary } from "./reply_summary_helpers.js";

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

function largeRepresentableGateSchema(): Record<string, unknown> {
	return {
		type: "object",
		properties: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, { type: "string", pattern: "a".repeat(250) }])),
		required: Array.from({ length: 20 }, (_, index) => `field${index}`),
		additionalProperties: false,
	};
}

function complexGateSchema(): Record<string, unknown> {
	return z.toJSONSchema(z.object({
		decision: z.enum(["approve", "reject"]),
		review: z.object({
			note: z.string().min(3).max(12).regex(/^[a-z]+$/),
			priority: z.number().int().min(1).max(5).default(2),
			optionalNote: z.string().optional(),
		}),
		findings: z.array(z.object({
			kind: z.literal("finding"),
			value: z.union([z.literal("ok"), z.number().int().min(1)]),
		})).min(1).max(2),
	}));
}

describe("hyperchart MCP tools", () => {
	it("registers the full tool surface", () => {
		const { tools } = makeWorld();
		expect([...tools.keys()].sort()).toEqual([
			"hyperchart_branches",
			"hyperchart_fork",
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

	it("always returns compact inspect digests and rejects the former verbose escape hatch", async () => {
		const { tools } = makeWorld();
		const digest = JSON.parse(text(await tools.get("hyperchart_inspect")!.handler({ chartPath: "simple" })));
		expect(digest.chartId).toBe("simple");
		expect(digest.definitionSource).toBeUndefined();
		expect(digest.stateDigests.every((state: object) => !("definitionSource" in state))).toBe(true);

		const verbose = await tools.get("hyperchart_inspect")!.handler({ chartPath: "simple", verbose: true });
		expect(verbose.isError).toBe(true);
		expect(text(verbose)).toContain("hyperchart_view");

		const run = JSON.parse(text(await tools.get("hyperchart_run")!.handler({ branchId: "main", chartPath: "simple", wait: true })));
		expect(run).not.toHaveProperty("inspector");
		expect(run).not.toHaveProperty("notification");
		const runDigest = JSON.parse(text(await tools.get("hyperchart_run_inspect")!.handler({ branchId: "main", runDir: run.runId })));
		expect(runDigest.runId).toBe(run.runId);
		expect(runDigest.status).toBe("completed");
		expect(runDigest.stateDigests.every((state: object) => !("definitionSource" in state))).toBe(true);
	}, 30_000);

	it("requires fresh runs to select exactly main", async () => {
		const { tools } = makeWorld();
		for (const selector of [{ branchId: "experiment" }, { branchIds: ["main", "experiment"] }]) {
			const result = await tools.get("hyperchart_run")!.handler({ chartPath: "simple", ...selector });
			expect(result.isError).toBe(true);
			expect(text(result)).toMatch(/fresh run must select exactly branch 'main'.*fork durable branches.*resume/i);
		}
	});

	it("returns only bounded startup coordinates for wait=false", async () => {
		const { tools } = makeWorld();
		const started = JSON.parse(text(await tools.get("hyperchart_run")!.handler({ branchId: "main", chartPath: "simple", wait: false })));
		expect(started).toMatchObject({ chartId: "simple", runId: expect.any(String), runDir: expect.stringMatching(/^\//) });
		expect(started).not.toHaveProperty("inspector");
		expect(started).not.toHaveProperty("states");
		expect(started).not.toHaveProperty("messages");
		await tools.get("hyperchart_run")!.handler({ branchId: "main", runDir: started.runId, wait: true });
	}, 30_000);

	it("never loads transcripts into run inspection tool responses", async () => {
		const { tools, runsRoot, cwd, chartPath } = makeWorld();
		const runDir = join(runsRoot, "verbose-run");
		const sessionsDir = join(runDir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		saveRunMeta(runDir, { chartPath, workDir: cwd, chartId: "simple", createdAt: new Date().toISOString() });
		const actionUid = { chart: "simple", state: "done", action: "agent" };
		const transcriptFile = join(sessionsDir, "verbose.jsonl");
		writeFileSync(transcriptFile, [
			JSON.stringify({ hyperchartTranscript: 1, sessionId: "verbose-session", createdAt: 1 }),
			JSON.stringify({ id: "assistant-1", role: "assistant", text: "verbose transcript" }),
		].join("\n") + "\n");
		updateSessionProgress(sessionsDir, actionUid, {
			actionName: "worker",
			status: "completed",
			sessionFile: transcriptFile,
		}, "simple:done:agent:1:2");

		const compact = JSON.parse(text(await tools.get("hyperchart_run_inspect")!.handler({ branchId: "main", runDir: "verbose-run" })));
		const rejected = await tools.get("hyperchart_run_inspect")!.handler({ branchId: "main", runDir: "verbose-run", verbose: true });
		expect(JSON.stringify(compact)).not.toContain("verbose transcript");
		expect(rejected.isError).toBe(true);
		expect(text(rejected)).toContain("hyperchart_view");
	});

	it("owns runs by the injected session and leases wait delivery without pre-confirming", async () => {
		const { tools, runsRoot, cwd } = makeWorld("session-a");
		const first = await tools.get("hyperchart_run")!.handler({ branchId: "main", chartPath: "simple", wait: true });
		expect(JSON.parse(text(first))).toMatchObject({ boundary: "terminal", final: true, status: { state: "complete" } });
		const [runId] = readdirSync(runsRoot);
		if (runId === undefined) throw new Error("expected run");
		const runDir = join(runsRoot, runId);
		expect(loadRunMeta(runDir).originSessionId).toBe("session-a");
		expect(hasTerminalNotificationReceipt(runDir, "claude", "session-a")).toBe(false);
		const firstRequestId = readTerminalNotificationRequest(runDir)!.requestId;

		const second = JSON.parse(text(await tools.get("hyperchart_run")!.handler({ branchId: "main", runDir: runId, wait: true })));
		expect(second.deliveryNotice).toContain("terminal boundary");
		expect(readTerminalNotificationRequest(runDir)!.requestId).not.toBe(firstRequestId);

		const foreignTools = new Map(createHyperchartMcpTools({ cwd, runsRoot, sessionId: "session-b" }).map((tool) => [tool.name, tool]));
		const foreign = JSON.parse(text(await foreignTools.get("hyperchart_run")!.handler({ branchId: "main", runDir: runId, wait: true })));
		expect(foreign.limitation).toContain("not owned");
		expect(hasTerminalNotificationReceipt(runDir, "claude", "session-b")).toBe(false);
	}, 30_000);

	it("publishes the actual FAILED error before matching failed status", async () => {
		const { tools, chartsDir } = makeWorld();
		writeFileSync(join(chartsDir, "failure.chart.ts"), `import { chart, failed, script } from "@surprisal/hyperchart";
export default chart({ kind: "chart", id: "failure", initial: "work", states: {
	work: { kind: "state", action: script("node", ["-e", "console.error('specific boom'); process.exit(9)"]), transitions: { ERROR: "failed" } },
	failed: failed(),
} });
`);
		const run = JSON.parse(text(await tools.get("hyperchart_run")!.handler({ branchId: "main", chartPath: "failure", wait: true })));
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
		const run = JSON.parse(text(await tools.get("hyperchart_run")!.handler({ branchId: "main", chartPath: "pardone", wait: true })));
		expect(run.status.state).toBe("complete");
		const digest = JSON.parse(text(await tools.get("hyperchart_run_inspect")!.handler({ branchId: "main", runDir: run.runId })));
		const statusOf = (id: string) =>
			digest.stateDigests.find((state: { id: string }) => state.id === id)?.status ??
			(digest.pendingStateIds.includes(id) ? "pending" : undefined);
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

		const run = JSON.parse(text(await tools.get("hyperchart_run")!.handler({ branchId: "main", chartPath: "common", wait: true })));
		expect(run.status.state).toBe("complete");
		const config = JSON.parse(readFileSync(join(run.runDir, "runner.config.json"), "utf8"));
		expect(config.modelRoles).toEqual({ reviewer: "claude-haiku-4-5" });
		expect(config.toolsets).toEqual({ reading: ["Read"] });
	}, 30_000);

	it("opens a static chart view without a run", async () => {
		const { tools } = makeWorld();
		const viewed = JSON.parse(text(await tools.get("hyperchart_view")!.handler({ chartPath: "simple", open: false })));
		expect(viewed).toEqual({ url: expect.stringContaining("/runs/") });
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
		const run = JSON.parse(text(await tools.get("hyperchart_run")!.handler({ branchId: "main", chartPath: "steps", wait: true })));
		expect(run.status.state).toBe("complete");
		const originalRequestId = readTerminalNotificationRequest(run.runDir)?.requestId;

		const terminalBefore = readFileSync(join(run.runDir, "terminal-notification", "request.json"), "utf8");
		const rewindResult = await tools.get("hyperchart_rewind")!.handler({ branchId: "main", runDir: run.runId, state: "work" });
		expect(rewindResult.isError, text(rewindResult)).toBeUndefined();
		const rewound = JSON.parse(text(rewindResult));
		expect(rewound).toMatchObject({ branchId: "main", preservedRecords: expect.any(Number) });
		expect(rewound.previousHeadSeqId).toBeGreaterThan(0);
		expect(rewound.headSeqId).toBeNull();
		expect(readFileSync(join(run.runDir, "terminal-notification", "request.json"), "utf8")).toBe(terminalBefore);

		const resumed = JSON.parse(text(await tools.get("hyperchart_run")!.handler({ branchId: "main", runDir: run.runId, wait: true })));
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

		const run = JSON.parse(text(await tools.get("hyperchart_run")!.handler({ branchId: "main", chartPath: "simple", wait: true })));
		expect(run.status.state).toBe("complete");
		expect(run.runDir.startsWith(runsRoot)).toBe(true);

		const runInfo = JSON.parse(text(await tools.get("hyperchart_run_inspect")!.handler({ branchId: "main", runDir: run.runId })));
		expect(runInfo.runId).toBe(run.runId);
		expect(runInfo.stateDigests.some((state: { id: string }) => state.id === "done")).toBe(true);

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

	it("rejects multi-branch selection for a fresh chart with fork/resume guidance", async () => {
		const { tools } = makeWorld();
		const result = await tools.get("hyperchart_run")!.handler({
			chartPath: "simple",
			branchIds: ["main", "experiment"],
		});
		expect(result).toMatchObject({ isError: true });
		expect(text(result)).toMatch(/start main, fork durable branches, then resume/);
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

		const run = JSON.parse(text(await tools.get("hyperchart_run")!.handler({ branchId: "main", chartPath: "simple", wait: true })));
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
		const actionKey = actionUidKey(actionUid);
		updateSessionProgress(join(runDir, "sessions"), actionUid, { actionName: "worker", status: "running" }, `${actionKey}:1:7`);

		const queued = await tools.get("hyperchart_steer")!.handler({
			runDir: "steer-run",
			branchId: "main",
			actionKey,
			message: "focus",
		});
		expect(queued.isError).toBeUndefined();
		const queuedFiles = readdirSync(join(runDir, "sessions", "steering"));
		expect(queuedFiles).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(runDir, "sessions", "steering", queuedFiles[0]!), "utf8"))).toMatchObject({ branchId: "main", actionKey, invokeSeqId: 7, message: "focus" });

		updateSessionProgress(join(runDir, "sessions"), actionUid, { status: "completed" }, `${actionKey}:1:7`);
		const rejected = await tools.get("hyperchart_steer")!.handler({
			runDir: "steer-run",
			branchId: "main",
			actionKey,
			message: "late",
		});
		expect(rejected.isError).toBe(true);

		updateSessionProgress(join(runDir, "sessions"), actionUid, { status: "running" }, `${actionKey}:2:8`);
		updateSessionProgress(join(runDir, "sessions"), actionUid, { status: "running" }, `${actionKey}:3:9`);
		const ambiguous = await tools.get("hyperchart_steer")!.handler({
			runDir: "steer-run",
			branchId: "main",
			actionKey,
			message: "which one",
		});
		expect(ambiguous).toMatchObject({ isError: true });
		expect(text(ambiguous)).toMatch(/ambiguous/);
	});

	it("stops a run that is not live by marking it stopped", async () => {
		const { tools, runsRoot, cwd, chartPath } = makeWorld();
		const runDir = join(runsRoot, "stop-run");
		mkdirSync(join(runDir, "sessions"), { recursive: true });
		saveRunMeta(runDir, { chartPath, workDir: cwd, chartId: "simple", createdAt: new Date().toISOString() });
		patchRunStatus(runDir, { runId: "stop-run", branchIds: ["main"], chartId: "simple", state: "running" });

		const stopped = JSON.parse(text(await tools.get("hyperchart_stop")!.handler({ runDir: "stop-run" })));
		expect(stopped.stopped).toHaveLength(1);
		const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8"));
		expect(status.state).toBe("stopped");
	});

	it("opens the browser inspector with full transcript details and returns a tokenized URL", async () => {
		const { tools, runsRoot, cwd, chartPath } = makeWorld();
		const runDir = join(runsRoot, "view-run");
		const sessionsDir = join(runDir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		saveRunMeta(runDir, { chartPath, workDir: cwd, chartId: "simple", createdAt: new Date().toISOString() });
		const actionUid = { chart: "simple", state: "done", action: "agent" };
		const transcriptFile = join(sessionsDir, "view-run.jsonl");
		writeFileSync(transcriptFile, [
			JSON.stringify({ hyperchartTranscript: 1, sessionId: "view-session", createdAt: 1 }),
			JSON.stringify({ id: "assistant-1", role: "assistant", text: "inspector transcript" }),
		].join("\n") + "\n");
		updateSessionProgress(sessionsDir, actionUid, {
			actionName: "worker",
			status: "running",
			sessionFile: transcriptFile,
		}, `${actionUidKey(actionUid)}:1:11`, "main");

		const viewed = JSON.parse(text(await tools.get("hyperchart_view")!.handler({ runDir: "view-run", branchId: "main", open: false })));
		expect(viewed.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/runs\/[A-Za-z0-9_-]+$/);
		const response = await fetch(viewed.url.replace("/runs/", "/api/runs/"));
		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			run: { runId: string; states: Array<{ id: string; session?: { messages?: unknown[] } }> };
		};
		expect(payload.run.runId).toBe("view-run");
		expect(payload.run.states.find((state) => state.id === "done")?.session?.messages).toEqual([
			{ id: "assistant-1", role: "assistant", text: "inspector transcript" },
		]);

		// The inspector's steering endpoint must land in the run's file queue.
		const steer = await fetch(`${viewed.url.replace("/runs/", "/api/runs/")}/steer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ actionKey: actionUidKey(actionUid), message: "from inspector" }),
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


});
