import { basename, resolve } from "node:path";
import {
	inspectChartAst,
	parseChartModuleSync,
	type HyperchartInspectAgentDefaults,
} from "@surprisal/hyperchart/internal/core/inspect";
import type { ChartAst } from "@surprisal/hyperchart/internal/core/types";
import type { DurableLogRecord } from "@surprisal/hyperchart/internal/core/durable_events";
import { hyperchartRunFromRuntime } from "@surprisal/hyperchart/host";
import type { HyperchartRunInfo } from "@surprisal/hyperchart/host";
import { JsonlLogStore } from "@surprisal/hyperchart/runtime";
import { loadRunMeta, type RunMeta } from "@surprisal/hyperchart/runtime";
import { readRunStatus } from "./run_status.js";
import { readSessionProgress } from "./session_progress.js";

export type HyperchartRunFromRunDirOptions = {
	meta?: RunMeta;
	ast?: ChartAst;
	records?: readonly DurableLogRecord[];
	agentDefaults?: (agentName: string) => HyperchartInspectAgentDefaults | undefined;
	now?: number;
};

export async function hyperchartRunFromRunDir(
	runDir: string,
	options: HyperchartRunFromRunDirOptions = {},
): Promise<HyperchartRunInfo> {
	const absoluteRunDir = resolve(runDir);
	const meta = options.meta ?? loadRunMeta(absoluteRunDir);
	const ast = options.ast ?? parsedRunAst(meta);
	const inspect = inspectChartAst(ast, {
		chartPath: meta.chartPath,
		...(meta.exportName === undefined ? {} : { exportName: meta.exportName }),
		...(options.agentDefaults === undefined ? {} : { agentDefaults: options.agentDefaults }),
	});
	const records = options.records ?? await new JsonlLogStore(resolve(absoluteRunDir, "log.jsonl")).readAll();
	const status = readRunStatus(absoluteRunDir);
	const sessionProgress = readSessionProgress(resolve(absoluteRunDir, "sessions"));
	const createdAt = Date.parse(meta.createdAt);
	return hyperchartRunFromRuntime(inspect, ast, records, {
		runId: status?.runId ?? basename(absoluteRunDir),
		...(status === undefined ? {} : { status }),
		sessionProgress,
		cwd: meta.workDir,
		...(Number.isNaN(createdAt) ? {} : { createdAt }),
		...(options.now === undefined ? {} : { now: options.now }),
	});
}

function parsedRunAst(meta: RunMeta): ChartAst {
	const parsed = parseChartModuleSync(
		meta.chartPath,
		meta.exportName === undefined ? {} : { exportName: meta.exportName },
	);
	if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	return parsed.ast;
}
