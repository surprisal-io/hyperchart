import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	createAgentDefaultsResolver,
	loadAgentDefinition,
	uniqueExistingDirs,
	type AgentDefinition,
} from "@surprisal/hyperchart/runtime";
import type { HyperchartInspectAgentDefaults } from "@surprisal/hyperchart";
import { CLAUDE_CONFIG_DIR_NAME, claudeConfigDir, claudeHostPaths } from "./paths.js";

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
): (agentName: string) => HyperchartInspectAgentDefaults {
	return createAgentDefaultsResolver(resolveClaudeSubagentDefinitionDirs(cwd, chartPath));
}
