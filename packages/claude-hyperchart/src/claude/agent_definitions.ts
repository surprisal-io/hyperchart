import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	createAgentDefaultsResolver,
	loadAgentDefinition,
	loadHostSettings,
	uniqueExistingDirs,
	type AgentDefinition,
	type AgentDefinitionResolution,
} from "@surprisal/hyperchart/runtime";
import type { HyperchartInspectAgentDefaults } from "@surprisal/hyperchart";
import { CLAUDE_CONFIG_DIR_NAME, claudeConfigDir, claudeHostPaths, claudeUserChartsDir } from "./paths.js";

/**
 * Definition files use the same markdown + frontmatter format as the Pi host
 * (name, description, tools, model, thinking, systemPromptMode; body = system
 * prompt), so charts that ship their agents next to the chart file are portable
 * between hosts.
 */
export function resolveClaudeSubagentDefinitionDirs(cwd: string, chartPath?: string): string[] {
	const projectRoot = claudeHostPaths().findNearestProjectRoot(cwd);
	return uniqueExistingDirs([
		...(chartPath === undefined ? [] : [join(dirname(resolve(chartPath)), "agents")]),
		...(projectRoot === undefined
			? []
			: [join(projectRoot, CLAUDE_CONFIG_DIR_NAME, "agents"), join(projectRoot, ".agents")]),
		join(homedir(), ".agents"),
		join(claudeConfigDir(), "agents"),
	]);
}

export function loadClaudeAgentDefinition(name: string, dirs: string[]): AgentDefinition {
	return loadAgentDefinition(name, dirs);
}

export function createClaudeAgentDefaultsResolver(
	cwd: string,
	chartPath?: string,
	resolution: AgentDefinitionResolution = {},
): (agentName: string) => HyperchartInspectAgentDefaults {
	const hostPaths = claudeHostPaths();
	const sharedChartsDir = hostPaths.getSharedHyperchartsDir(cwd);
	const settings = loadHostSettings(
		[
			claudeUserChartsDir(),
			...(sharedChartsDir === undefined ? [] : [sharedChartsDir]),
			hostPaths.getProjectHyperchartsDir(cwd),
		],
		"claude",
	);
	return createAgentDefaultsResolver(
		resolveClaudeSubagentDefinitionDirs(cwd, chartPath),
		undefined,
		{
			...(resolution.defaultModel === undefined ? {} : { defaultModel: resolution.defaultModel }),
			modelRoles: resolution.modelRoles ?? settings.modelRoles,
			toolsets: resolution.toolsets ?? settings.toolsets,
		},
	);
}
