import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSimpleFrontmatter } from "../packages/hyperchart/src/runtime/generic/frontmatter.js";
import { loadAgentDefinition } from "../packages/hyperchart/src/runtime/generic/agent_definitions.js";
import { loadAgentDefinition as loadPiAgentDefinition } from "../packages/pi-hyperchart/src/runtime/pi/agent_definitions.js";
import {
	claudeHostPaths,
	claudeRunsRoot,
} from "../packages/claude-hyperchart/src/claude/paths.js";
import { resolveClaudeSubagentDefinitionDirs } from "../packages/claude-hyperchart/src/claude/agent_definitions.js";
import { createNeutralTranscriptWriter } from "../packages/claude-hyperchart/src/claude/transcript_writer.js";
import { readNeutralSessionTranscript } from "../packages/hyperchart/src/inspect/session_transcript.js";

const roots: string[] = [];
const savedEnv = { runsRoot: process.env.HYPERCHART_RUNS_ROOT, configDir: process.env.CLAUDE_CONFIG_DIR };

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	if (savedEnv.runsRoot === undefined) delete process.env.HYPERCHART_RUNS_ROOT;
	else process.env.HYPERCHART_RUNS_ROOT = savedEnv.runsRoot;
	if (savedEnv.configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = savedEnv.configDir;
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "claude-hyperchart-"));
	roots.push(root);
	return root;
}

const AGENT_FIXTURE = `---
name: scout
description: Research scout
model: claude-sonnet-5
thinking: medium
tools: read, bash
---
Investigate the assigned topic and report findings.
`;

describe("claude host scaffold", () => {
	it("resolves the runs root from CLAUDE_CONFIG_DIR and HYPERCHART_RUNS_ROOT", () => {
		const root = tempRoot();
		process.env.CLAUDE_CONFIG_DIR = join(root, ".claude-config");
		delete process.env.HYPERCHART_RUNS_ROOT;
		expect(claudeRunsRoot()).toBe(join(root, ".claude-config", "hypercharts", "runs"));
		process.env.HYPERCHART_RUNS_ROOT = join(root, "custom-runs");
		expect(claudeRunsRoot()).toBe(join(root, "custom-runs"));
	});

	it("treats .claude and .agents directories as project markers", () => {
		const root = tempRoot();
		const project = join(root, "project");
		mkdirSync(join(project, ".claude", "hypercharts"), { recursive: true });
		const nested = join(project, "src", "deep");
		mkdirSync(nested, { recursive: true });
		expect(claudeHostPaths().findNearestProjectRoot(nested)).toBe(project);
		expect(claudeHostPaths().getProjectHyperchartsDir(nested)).toBe(join(project, ".claude", "hypercharts"));
	});

	it("resolves definition dirs in chart, project, and user order", () => {
		const root = tempRoot();
		process.env.CLAUDE_CONFIG_DIR = join(root, "user-claude");
		const project = join(root, "project");
		const chartDir = join(project, ".claude", "hypercharts", "research");
		for (const dir of [
			join(chartDir, "agents"),
			join(project, ".claude", "agents"),
			join(project, ".agents"),
			join(root, "user-claude", "agents"),
		]) {
			mkdirSync(dir, { recursive: true });
		}
		const dirs = resolveClaudeSubagentDefinitionDirs(project, join(chartDir, "chart.ts"));
		expect(dirs.slice(0, 3)).toEqual([
			join(chartDir, "agents"),
			join(project, ".claude", "agents"),
			join(project, ".agents"),
		]);
		expect(dirs).toContain(join(root, "user-claude", "agents"));
	});

	it("parses the same definition file identically through the core and Pi loaders", () => {
		const root = tempRoot();
		const dir = join(root, "agents");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "scout.md"), AGENT_FIXTURE);
		const fromCore = loadAgentDefinition("scout", [dir]);
		const fromPi = loadPiAgentDefinition("scout", [dir]);
		expect(fromCore).toEqual(fromPi);
		expect(fromCore).toMatchObject({
			name: "scout",
			model: "claude-sonnet-5",
			thinking: "medium",
			tools: ["read", "bash"],
			systemPromptMode: "replace",
		});
		expect(fromCore.systemPrompt).toContain("Investigate the assigned topic");
	});

	it("parses frontmatter scalars, arrays, and quoted strings", () => {
		const parsed = parseSimpleFrontmatter('---\nname: "worker"\ntools: [read, "write"]\ncount: 3\nflag: true\n---\nBody text\n');
		expect(parsed.frontmatter).toEqual({ name: "worker", tools: ["read", "write"], count: 3, flag: true });
		expect(parsed.body.trim()).toBe("Body text");
	});

	it("roundtrips the neutral transcript through writer and reader", () => {
		const root = tempRoot();
		const sessionsDir = join(root, "sessions");
		const file = join(sessionsDir, "abc", "session.jsonl");
		const writer = createNeutralTranscriptWriter(file, "sdk-session-1");
		writer.append({ id: "u1", role: "user", text: "start" });
		writer.append({ id: "t1", role: "tool", toolName: "bash", toolCallId: "c1", toolInput: "ls", toolStatus: "running" });
		writer.append({ id: "t2", role: "tool", toolName: "bash", toolCallId: "c1", toolOutput: "ok", toolStatus: "completed" });

		expect(readNeutralSessionTranscript(sessionsDir, file)).toEqual([
			{ id: "u1", role: "user", text: "start" },
			{ id: "t1", role: "tool", toolName: "bash", toolCallId: "c1", toolInput: "ls", toolStatus: "completed", toolOutput: "ok" },
		]);
	});
});
