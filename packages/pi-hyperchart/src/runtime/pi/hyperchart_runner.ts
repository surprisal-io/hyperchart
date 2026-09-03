import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	readRunnerConfig,
	runHyperchartRunner,
	type HyperchartRunnerConfig as GenericRunnerConfig,
} from "@surprisal/hyperchart/runner";
import { resolvePiSubagentDefinitionDirs } from "./agent_definitions.js";
import { PiAgentExecutor } from "./pi_agent_executor.js";

export type PiRunnerModules = {
	codingAgent: string;
	typebox: string;
};

export type HyperchartRunnerConfig = GenericRunnerConfig & {
	agentDir: string;
	/** Exact modules supplied by the active Pi host for the detached runner bootstrap. */
	piModules: PiRunnerModules;
};

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const configPath = argv[0];
	if (configPath === undefined) throw new Error("hyperchart runner requires a config path");
	const config = readRunnerConfig(configPath);
	const agentDir = config.agentDir;
	if (agentDir === undefined) throw new Error(`Invalid hyperchart runner config: ${configPath} (agentDir is required)`);
	await runHyperchartRunner(config, async ({ config: runnerConfig, schemaRegistry, sessionsDir }) => {
		const modelRuntime = await createModelRuntime(agentDir);
		return new PiAgentExecutor({
			workDir: runnerConfig.workDir,
			projectDir: runnerConfig.projectDir,
			agentDir,
			definitionDirs: resolvePiSubagentDefinitionDirs(runnerConfig.projectDir, agentDir, runnerConfig.chartPath),
			modelRuntime,
			sessionsDir,
			branchId: runnerConfig.branchId,
			...(runnerConfig.defaultModel === undefined ? {} : { defaultModel: runnerConfig.defaultModel }),
			...(runnerConfig.modelRoles === undefined ? {} : { modelRoles: runnerConfig.modelRoles }),
			...(runnerConfig.toolsets === undefined ? {} : { toolsets: runnerConfig.toolsets }),
			schemaRegistry,
		});
	});
}

async function createModelRuntime(agentDir: string): Promise<ModelRuntime> {
	return ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
}

if (process.argv[1]?.endsWith("hyperchart_runner.ts")) {
	void main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
