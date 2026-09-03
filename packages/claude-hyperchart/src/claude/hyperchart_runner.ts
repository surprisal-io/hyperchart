import { readRunnerConfig, runHyperchartRunner } from "@surprisal/hyperchart/runner";
import { ClaudeAgentExecutor } from "./claude_agent_executor.js";
import { resolveClaudeSubagentDefinitionDirs } from "./agent_definitions.js";

export type { HyperchartRunnerConfig } from "@surprisal/hyperchart/runner";

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const configPath = argv[0];
	if (configPath === undefined) throw new Error("hyperchart runner requires a config path");
	const config = readRunnerConfig(configPath);
	await runHyperchartRunner(config, ({ config: runnerConfig, schemaRegistry, sessionsDir }) => {
		return new ClaudeAgentExecutor({
			workDir: runnerConfig.workDir,
			projectDir: runnerConfig.projectDir,
			sessionsDir,
			branchId: runnerConfig.branchId,
			definitionDirs: resolveClaudeSubagentDefinitionDirs(runnerConfig.projectDir, runnerConfig.chartPath),
			...(runnerConfig.defaultModel === undefined ? {} : { defaultModel: runnerConfig.defaultModel }),
			...(runnerConfig.modelRoles === undefined ? {} : { modelRoles: runnerConfig.modelRoles }),
			...(runnerConfig.toolsets === undefined ? {} : { toolsets: runnerConfig.toolsets }),
			schemaRegistry,
		});
	});
}

if (process.argv[1]?.endsWith("hyperchart_runner.ts")) {
	void main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
