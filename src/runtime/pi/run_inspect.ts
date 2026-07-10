import { basename, resolve } from "node:path";
import {
	inspectChartAst,
	parseChartModuleSync,
	type HyperchartInspectAgentDefaults,
} from "../../core/inspect.js";
import { hyperchartRunFromRuntime } from "../../host/adapters.js";
import type { HyperchartRunInfo } from "../../host/models.js";
import { JsonlLogStore } from "../generic/log_store.js";
import { loadRunMeta, type RunMeta } from "../generic/run_dir.js";
import { readRunStatus } from "./run_status.js";
import { readSessionProgress } from "./session_progress.js";

export type HyperchartRunFromRunDirOptions = {
	meta?: RunMeta;
	agentDefaults?: (agentName: string) => HyperchartInspectAgentDefaults | undefined;
	now?: number;
};

export async function hyperchartRunFromRunDir(
	runDir: string,
	options: HyperchartRunFromRunDirOptions = {},
): Promise<HyperchartRunInfo> {
	const absoluteRunDir = resolve(runDir);
	const meta = options.meta ?? loadRunMeta(absoluteRunDir);
	const parsed = parseChartModuleSync(
		meta.chartPath,
		meta.exportName === undefined ? {} : { exportName: meta.exportName },
	);
	if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	const inspect = inspectChartAst(parsed.ast, {
		chartPath: meta.chartPath,
		...(meta.exportName === undefined ? {} : { exportName: meta.exportName }),
		...(options.agentDefaults === undefined ? {} : { agentDefaults: options.agentDefaults }),
	});
	const records = await new JsonlLogStore(resolve(absoluteRunDir, "log.jsonl")).readAll();
	const status = readRunStatus(absoluteRunDir);
	const sessionProgress = readSessionProgress(resolve(absoluteRunDir, "sessions"));
	const createdAt = Date.parse(meta.createdAt);
	return hyperchartRunFromRuntime(inspect, parsed.ast, records, {
		runId: status?.runId ?? basename(absoluteRunDir),
		...(status === undefined ? {} : { status }),
		sessionProgress,
		cwd: meta.workDir,
		...(Number.isNaN(createdAt) ? {} : { createdAt }),
		...(options.now === undefined ? {} : { now: options.now }),
	});
}
