import { homedir } from "node:os";
import { join } from "node:path";
import {
	HYPERCHARTS_DIR_NAME,
	RUNS_DIR_NAME,
	createHostPaths,
	listHyperchartFiles,
	type HostPaths,
} from "@surprisal/hyperchart/runtime";

const CONFIG_DIR_NAME = ".pi";

export { HYPERCHARTS_DIR_NAME, RUNS_DIR_NAME, listHyperchartFiles };

function defaultAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), CONFIG_DIR_NAME, "agent");
}

export const SHARED_HYPERCHARTS_DIR_NAME = ".hypercharts";

function piHostPaths(agentDir: string): HostPaths {
	return createHostPaths({
		configDirName: CONFIG_DIR_NAME,
		runsRoot: join(agentDir, HYPERCHARTS_DIR_NAME, RUNS_DIR_NAME),
		userChartsDir: join(agentDir, HYPERCHARTS_DIR_NAME),
		sharedChartsDirName: SHARED_HYPERCHARTS_DIR_NAME,
	});
}

export function getProjectHyperchartsDir(cwd: string): string {
	return piHostPaths(defaultAgentDir()).getProjectHyperchartsDir(cwd);
}

export function getSharedHyperchartsDir(cwd: string): string | undefined {
	return piHostPaths(defaultAgentDir()).getSharedHyperchartsDir(cwd);
}

export function getHyperchartRunsRoot(agentDir: string = defaultAgentDir()): string {
	return piHostPaths(agentDir).getRunsRoot();
}

export function resolveHyperchartRunDir(spec: string, cwd: string, agentDir: string = defaultAgentDir()): string {
	return piHostPaths(agentDir).resolveRunDir(spec, cwd);
}

export function resolveHyperchartPath(spec: string, cwd: string, agentDir: string = defaultAgentDir()): string {
	return piHostPaths(agentDir).resolveChartPath(spec, cwd);
}

export function listProjectHypercharts(cwd: string): string[] {
	return piHostPaths(defaultAgentDir()).listProjectHypercharts(cwd);
}
