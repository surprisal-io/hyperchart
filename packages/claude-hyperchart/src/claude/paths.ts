import { homedir } from "node:os";
import { join } from "node:path";
import {
	HYPERCHARTS_DIR_NAME,
	RUNS_DIR_NAME,
	createHostPaths,
	type HostPaths,
} from "@surprisal/hyperchart/runtime";

export const CLAUDE_CONFIG_DIR_NAME = ".claude";

export function claudeConfigDir(): string {
	return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), CLAUDE_CONFIG_DIR_NAME);
}

/** Run directories for the Claude host live under the user's Claude config dir. */
export function claudeRunsRoot(): string {
	return process.env.HYPERCHART_RUNS_ROOT ?? join(claudeConfigDir(), HYPERCHARTS_DIR_NAME, RUNS_DIR_NAME);
}

export function claudeUserChartsDir(): string {
	return join(claudeConfigDir(), HYPERCHARTS_DIR_NAME);
}

export const SHARED_HYPERCHARTS_DIR_NAME = ".hypercharts";

export function claudeHostPaths(): HostPaths {
	return createHostPaths({
		configDirName: CLAUDE_CONFIG_DIR_NAME,
		runsRoot: claudeRunsRoot(),
		userChartsDir: claudeUserChartsDir(),
		sharedChartsDirName: SHARED_HYPERCHARTS_DIR_NAME,
		projectMarkers: [".agents"],
	});
}
