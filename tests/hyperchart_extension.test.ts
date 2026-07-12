import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import register from "../packages/pi-hyperchart/extensions/hyperchart.js";
import { HYPERCHART_COMMAND_EVENT, requestHyperchartCommand, type HyperchartCommandRequest } from "../packages/pi-hyperchart/src/command.js";
import { saveRunMeta } from "../packages/hyperchart/src/runtime/generic/run_dir.js";
import { patchRunStatus, readRunStatus } from "../packages/pi-hyperchart/src/runtime/pi/run_status.js";
import { updateSessionProgress } from "../packages/pi-hyperchart/src/runtime/pi/session_progress.js";

type HyperchartCommand = {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	getArgumentCompletions: (prefix: string) => AutocompleteItem[] | null;
};
type HyperchartTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: (update: unknown) => void,
		ctx: ExtensionCommandContext,
	) => Promise<{ details?: unknown }>;
};
type Notification = { message: string; type: "info" | "warning" | "error" | undefined };

let previousAgentDir: string | undefined;
let previousCwd = process.cwd();
let tempDir = "";
let agentDir = "";
let projectDir = "";
let otherProjectDir = "";

beforeEach(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	previousCwd = process.cwd();
	tempDir = mkdtempSync(join(tmpdir(), "hyperchart-extension-"));
	agentDir = join(tempDir, "agent");
	projectDir = join(tempDir, "project");
	otherProjectDir = join(tempDir, "other-project");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(otherProjectDir, { recursive: true });
	projectDir = realpathSync(projectDir);
	otherProjectDir = realpathSync(otherProjectDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.chdir(projectDir);
});

afterEach(() => {
	process.chdir(previousCwd);
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempDir, { recursive: true, force: true });
});

describe("hyperchart extension", () => {
	it("registers one consolidated hyperchart tool", () => {
		expect(registeredToolNames()).toEqual(["hyperchart"]);
	});

	it("lists project and user charts with project precedence", async () => {
		const projectCharts = join(projectDir, ".pi", "hypercharts");
		const userCharts = join(agentDir, "hypercharts");
		mkdirSync(projectCharts, { recursive: true });
		mkdirSync(userCharts, { recursive: true });
		writeFileSync(join(userCharts, "shared.chart.ts"), "export default {};\n");
		writeFileSync(join(userCharts, "user-only.chart.ts"), "export default {};\n");
		writeFileSync(join(projectCharts, "shared.chart.ts"), "export default {};\n");
		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);

		const result = await tool.execute("tool-call", { action: "list" }, new AbortController().signal, () => undefined, ctx);
		const charts = (result.details as { charts: Array<{ name: string; scope: string }> }).charts;
		const text = (result as { content: Array<{ type: string; text: string }> }).content[0]?.text;

		expect(text).toBe([
			"Found 2 Hyperchart definitions:",
			`- shared [project] ${join(projectCharts, "shared.chart.ts")}`,
			`- user-only [user] ${join(userCharts, "user-only.chart.ts")}`,
		].join("\n"));
		expect(charts).toEqual([
			expect.objectContaining({ name: "shared", scope: "project" }),
			expect.objectContaining({ name: "user-only", scope: "user" }),
		]);
	});

	it("registers tools from a self-contained chart bundle extension without listing its implementation files", async () => {
		const bundleDir = join(projectDir, ".pi", "hypercharts", "bundled");
		mkdirSync(join(bundleDir, "extensions", "custom"), { recursive: true });
		writeFileSync(join(bundleDir, "chart.ts"), "export default {};\n");
		writeFileSync(join(bundleDir, "extensions", "custom", "index.ts"), [
			"export default function register(pi: any) {",
			"  pi.registerTool({ name: 'bundle_tool', parameters: {}, execute() {} });",
			"}",
		].join("\n"));

		expect(registeredToolNames()).toEqual(["bundle_tool", "hyperchart"]);
		const list = await registeredTool("hyperchart").execute(
			"tool-call",
			{ action: "list" },
			new AbortController().signal,
			() => undefined,
			commandContext(projectDir).ctx,
		);
		const charts = (list.details as { charts: Array<{ name: string }> }).charts;
		expect(charts.map((chart) => chart.name)).toEqual(["bundled"]);
	});

	it("stops one run through the consolidated tool", async () => {
		const chartPath = writeChart("stoppable");
		const runDir = createRun("stoppable-run", projectDir, chartPath);
		patchRunStatus(runDir, {
			runId: "stoppable-run",
			chartId: "demo",
			state: "running",
			pid: 999_999_999,
			heartbeatAt: Date.now(),
		});
		const result = await registeredTool("hyperchart").execute(
			"tool-call",
			{ action: "stop", runDir: "stoppable-run" },
			new AbortController().signal,
			() => undefined,
			commandContext(projectDir).ctx,
		);

		expect(readRunStatus(runDir)).toMatchObject({ state: "stopped", exitCode: 0 });
		expect((result as { content: Array<{ text: string }> }).content[0]?.text).toContain("stoppable-run (marked stopped)");
	});

	it("accepts commands from another pi extension over the shared event bus", async () => {
		let sessionStart: ((event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		let commandRequest: ((request: HyperchartCommandRequest) => void) | undefined;
		const pi = {
			registerCommand: () => {},
			registerTool: () => {},
			on: (event: string, handler: (event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) => {
				if (event === "session_start") sessionStart = handler;
			},
			events: {
				on: (event: string, handler: (request: HyperchartCommandRequest) => void) => {
					if (event === HYPERCHART_COMMAND_EVENT) commandRequest = handler;
				},
				emit: () => {},
			},
		} as unknown as ExtensionAPI;
		register(pi);
		const { ctx, notifications } = commandContext(projectDir);
		await sessionStart?.({ reason: "startup" }, ctx);

		const handled = await requestHyperchartCommand({
			emit(event, payload) {
				if (event === HYPERCHART_COMMAND_EVENT) commandRequest?.(payload as HyperchartCommandRequest);
			},
		}, "status");

		expect(handled).toBe(true);
		expect(notifications).toContainEqual({ message: "No hyperchart runs", type: "info" });
		await expect(requestHyperchartCommand({
			emit(event, payload) {
				if (event === HYPERCHART_COMMAND_EVENT) commandRequest?.(payload as HyperchartCommandRequest);
			},
		}, "resume")).rejects.toThrow("resume requires a runId");
	});

	it("offers documented top-level commands and run ids with an empty prefix", () => {
		const runId = "demo-run";
		createRun(runId, projectDir, writeChart("demo"));

		const values = registeredCommand()
			.getArgumentCompletions("")
			?.map((item) => item.value);

		expect(values).toContain("view");
		expect(values).toContain(runId);
	});

	it("enriches inspected agents with defaults from subagent definitions", async () => {
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		writeFileSync(
			join(agentDir, "agents", "worker.md"),
			"---\ndescription: Reviews implementation details\nmodel: anthropic/claude-sonnet\nthinking: high\ntools:\n  - read\n  - grep\n---\nWorker prompt\n",
			"utf8",
		);
		const chartPath = writeChart("inspect-defaults");
		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);

		const result = await tool.execute("tool-call", { action: "inspect", chartPath }, new AbortController().signal, () => undefined, ctx);
		const details = result.details as { states: Array<Record<string, unknown>> };

		expect(details.states.find((state) => state.id === "work")).toMatchObject({
			description: "Reviews implementation details",
			model: "anthropic/claude-sonnet",
			thinking: "high",
			tools: ["read", "grep"],
		});
	});

	it("loads agent descriptions from the selected chart bundle", async () => {
		const bundleDir = join(agentDir, "hypercharts", "described-bundle");
		mkdirSync(join(bundleDir, "agents"), { recursive: true });
		copyFileSync(writeChart("described-source"), join(bundleDir, "chart.ts"));
		writeFileSync(
			join(bundleDir, "agents", "worker.md"),
			"---\ndescription: Bundle-local analyzer\n---\nAnalyze locally\n",
			"utf8",
		);
		const result = await registeredTool("hyperchart").execute(
			"tool-call",
			{ action: "inspect", chartPath: join(bundleDir, "chart.ts") },
			new AbortController().signal,
			() => undefined,
			commandContext(projectDir).ctx,
		);
		const details = result.details as { states: Array<Record<string, unknown>> };

		expect(details.states.find((state) => state.id === "work")).toMatchObject({
			agent: "worker",
			description: "Bundle-local analyzer",
		});
	});

	it("marks unavailable agent definitions in static inspect results", async () => {
		const chartPath = writeChart("inspect-missing-agent");
		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);

		const result = await tool.execute("tool-call", { action: "inspect", chartPath }, new AbortController().signal, () => undefined, ctx);
		const details = result.details as { states: Array<Record<string, unknown>> };

		expect(details.states.find((state) => state.id === "work")).toMatchObject({
			agent: "worker",
			agentDefinitionUnavailable: true,
		});
	});

	it("keeps view as the shortcut for opening the latest run", async () => {
		const runId = "current-run";
		const runDir = createRun(runId, projectDir, writeChart("current"));
		const { ctx, notifications } = commandContext(projectDir);

		await registeredCommand().handler("view", ctx);

		expect(notifications).toContainEqual({ message: `Run ${runId}: ${runDir}`, type: "info" });
	});

	it("returns a runtime-enriched inspector model for concrete run dirs", async () => {
		const runId = "runtime-inspect-run";
		const runDir = createRun(runId, projectDir, writeChart("runtime-inspect"));
		const uid = { chart: "demo", state: "work", action: "agent" };
		writeFileSync(
			join(runDir, "log.jsonl"),
			[
				{ type: "args", args: { topic: "wire runtime" }, parentId: null, seqId: 1, timestamp: 1 },
				{ type: "state_action", kind: "invoke", actionUid: uid, definition: { kind: "agent", uid, name: "worker" }, parentId: 1, seqId: 2, timestamp: 2 },
				{ type: "state_action", kind: "complete", actionUid: uid, event: { type: "FAILED", error: { code: 2, stderr: "nope" } }, parentId: 2, seqId: 3, timestamp: 3 },
			]
				.map((record) => JSON.stringify(record))
				.join("\n") + "\n",
			"utf8",
		);
		patchRunStatus(runDir, { runId, chartId: "demo", state: "failed", exitCode: 1, error: "runner failed", replayWarnings: ["Replay warning: stale provenance"] });
		updateSessionProgress(join(runDir, "sessions"), uid, { actionName: "worker", status: "failed", error: "session failed", lastActivityAt: 4 });
		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);

		const result = await tool.execute("tool-call", { action: "run_inspect", runDir: runId }, new AbortController().signal, () => undefined, ctx);
		const details = result.details as { mode?: string; args?: Record<string, unknown>; issues?: Array<{ kind: string }>; states: Array<{ id: string; issues?: Array<{ kind: string; message: string }> }> };

		expect(details.mode).toBe("run");
		expect(details.args).toEqual({ topic: "wire runtime" });
		expect(details.issues?.map((issue) => issue.kind)).toEqual(["run_failed", "replay_warning"]);
		expect(details.states.find((state) => state.id === "work")?.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "action_failed", message: "Script exited with code 2: nope" }),
				expect.objectContaining({ kind: "session_failed", message: "session failed" }),
			]),
		);
	});

	it("does not import path-like or foreign run specs through the top-level fallback", async () => {
		const importedFlag = join(tempDir, "imported.txt");
		const maliciousChart = writeChart("malicious", importedFlag);
		const pathRunDir = join(tempDir, "crafted-run");
		saveRunMeta(pathRunDir, {
			chartPath: maliciousChart,
			workDir: projectDir,
			chartId: "malicious",
			createdAt: new Date().toISOString(),
		});
		createRun("foreign-run", otherProjectDir, maliciousChart);
		const command = registeredCommand();
		const { ctx } = commandContext(projectDir);

		await command.handler(pathRunDir, ctx);
		await command.handler("foreign-run", ctx);

		expect(existsSync(importedFlag)).toBe(false);
	});

	it("rejects resume of a foreign run before importing its chart", async () => {
		const importedFlag = join(tempDir, "resume-imported.txt");
		const maliciousChart = writeChart("resume-malicious", importedFlag);
		createRun("foreign-resume", otherProjectDir, maliciousChart);
		const command = registeredCommand();
		const { ctx, notifications } = commandContext(projectDir);

		await command.handler("resume foreign-resume", ctx);

		expect(existsSync(importedFlag)).toBe(false);
		expect(notifications).toContainEqual({
			message: `Run 'foreign-resume' belongs to ${otherProjectDir}; open that directory first`,
			type: "error",
		});
	});

	it("rewinds an incompatible modified-chart run to the compatible prefix", async () => {
		const chartPath = writeIncompatibleReplayChart();
		const runDir = createRun("rewind-compatible", projectDir, chartPath);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "log.jsonl"),
			[
				{ type: "args", args: {}, parentId: null, seqId: 1, timestamp: 1 },
				{
					type: "state_action",
					kind: "invoke",
					actionUid: { chart: "demo", state: "first", action: "agent" },
					definition: { kind: "agent", uid: { chart: "demo", state: "first", action: "agent" }, name: "old-worker" },
					parentId: 1,
					seqId: 2,
					timestamp: 2,
				},
				{
					type: "state_action",
					kind: "complete",
					actionUid: { chart: "demo", state: "first", action: "agent" },
					event: { type: "FIRST_DONE" },
					parentId: 2,
					seqId: 3,
					timestamp: 3,
				},
			]
				.map((record) => JSON.stringify(record))
				.join("\n") + "\n",
			"utf8",
		);
		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);

		const result = await tool.execute(
			"tool-call",
			{ action: "rewind", runDir, to: "compatible", cleanupSessions: true, cleanupArtifacts: false },
			new AbortController().signal,
			() => undefined,
			ctx,
		);

		const lines = readFileSync(join(runDir, "log.jsonl"), "utf8").trim().split("\n");
		expect(lines.map((line) => JSON.parse(line) as { seqId: number }).map((record) => record.seqId)).toEqual([1]);
		expect(result.details).toMatchObject({ removedRecords: 2, cutSeqId: 2 });
		expect(existsSync(join(runDir, "rewind-backups"))).toBe(true);
	});
});

function registeredCommand(): HyperchartCommand {
	let command: HyperchartCommand | undefined;
	const pi = {
		registerCommand: (name: string, config: HyperchartCommand) => {
			if (name === "hyperchart") command = config;
		},
		registerTool: () => {},
		on: () => {},
		events: { on: () => {}, emit: () => {} },
	} as unknown as ExtensionAPI;
	register(pi);
	if (command === undefined) throw new Error("hyperchart command was not registered");
	return command;
}

function registeredToolNames(): string[] {
	const tools: HyperchartTool[] = [];
	const pi = {
		registerCommand: () => {},
		registerTool: (tool: HyperchartTool) => tools.push(tool),
		on: () => {},
		events: { on: () => {}, emit: () => {} },
	} as unknown as ExtensionAPI;
	register(pi);
	return tools.map((tool) => tool.name);
}

function registeredTool(name: string): HyperchartTool {
	const tools: HyperchartTool[] = [];
	const pi = {
		registerCommand: () => {},
		registerTool: (tool: HyperchartTool) => tools.push(tool),
		on: () => {},
		events: { on: () => {}, emit: () => {} },
	} as unknown as ExtensionAPI;
	register(pi);
	const tool = tools.find((entry) => entry.name === name);
	if (tool === undefined) throw new Error(`hyperchart tool ${name} was not registered`);
	return tool;
}

function commandContext(cwd: string): { ctx: ExtensionCommandContext; notifications: Notification[] } {
	const notifications: Notification[] = [];
	return {
		notifications,
		ctx: {
			cwd,
			mode: "print",
			model: undefined,
			ui: {
				notify: (message: string, type: "info" | "warning" | "error" | undefined) => {
					notifications.push({ message, type });
				},
				setStatus: () => {},
				setWidget: () => {},
				confirm: async () => false,
				custom: async () => undefined,
			},
		} as unknown as ExtensionCommandContext,
	};
}

function createRun(runId: string, workDir: string, chartPath: string): string {
	const runDir = join(agentDir, "hypercharts", "runs", runId);
	saveRunMeta(runDir, {
		chartPath,
		workDir,
		chartId: "demo",
		createdAt: new Date().toISOString(),
	});
	return runDir;
}

function writeIncompatibleReplayChart(): string {
	const chartPath = join(tempDir, "incompatible-replay.mjs");
	writeFileSync(
		chartPath,
		`export default {
	kind: "chart",
	id: "demo",
	initial: "first",
	states: {
		first: { kind: "state", action: { kind: "agent", name: "first-worker" }, transitions: { OTHER: "done" } },
		done: { kind: "final" }
	}
};
`,
		"utf8",
	);
	return chartPath;
}

function writeChart(name: string, sideEffectPath?: string): string {
	const chartPath = join(tempDir, `${name}.mjs`);
	const sideEffect =
		sideEffectPath === undefined
			? ""
			: `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sideEffectPath)}, "imported");\n`;
	writeFileSync(
		chartPath,
		`${sideEffect}export default {
	kind: "chart",
	id: "demo",
	initial: "work",
	states: {
		work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done", FAILED: "failed" } },
		done: { kind: "final" },
		failed: { kind: "final" }
	}
};
`,
		"utf8",
	);
	return chartPath;
}
