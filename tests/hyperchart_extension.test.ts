import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import register from "../extensions/hyperchart.js";
import { saveRunMeta } from "../src/runtime/generic/run_dir.js";

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
	it("offers documented top-level commands and run ids with an empty prefix", () => {
		const runId = "demo-run";
		createRun(runId, projectDir, writeChart("demo"));

		const values = registeredCommand()
			.getArgumentCompletions("")
			?.map((item) => item.value);

		expect(values).toContain("view");
		expect(values).toContain(runId);
	});

	it("keeps view as the shortcut for opening the latest run", async () => {
		const runId = "current-run";
		const runDir = createRun(runId, projectDir, writeChart("current"));
		const { ctx, notifications } = commandContext(projectDir);

		await registeredCommand().handler("view", ctx);

		expect(notifications).toContainEqual({ message: `Run ${runId}: ${runDir}`, type: "info" });
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
		const tool = registeredTool("hyperchart_rewind");
		const { ctx } = commandContext(projectDir);

		const result = await tool.execute(
			"tool-call",
			{ runDir, to: "compatible", cleanupSessions: true, cleanupArtifacts: false },
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
	} as unknown as ExtensionAPI;
	register(pi);
	if (command === undefined) throw new Error("hyperchart command was not registered");
	return command;
}

function registeredTool(name: string): HyperchartTool {
	const tools: HyperchartTool[] = [];
	const pi = {
		registerCommand: () => {},
		registerTool: (tool: HyperchartTool) => tools.push(tool),
		on: () => {},
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
