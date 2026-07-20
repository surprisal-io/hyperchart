import { basename, resolve } from "node:path";
import {
	inspectChartAst,
	parseChartModuleSync,
	type HyperchartInspectAgentDefaults,
} from "../core/inspect.js";
import type { ChartAst } from "../core/types.js";
import type { DurableLogRecord } from "../core/durable_events.js";
import { hyperchartRunFromRuntime } from "../host/index.js";
import type { HyperchartRunInfo } from "../host/index.js";
import { JsonlLogStore } from "../runtime/generic/log_store.js";
import { loadRunMeta, type RunMeta } from "../runtime/generic/run_dir.js";
import { readRunStatus } from "../runtime/generic/run_status.js";
import { readSessionProgress } from "../runtime/generic/session_progress.js";
import { readNeutralSessionTranscript, type SessionTranscriptReader } from "./session_transcript.js";

export type HyperchartRunFromRunDirOptions = {
	meta?: RunMeta;
	ast?: ChartAst;
	records?: readonly DurableLogRecord[];
	agentDefaults?: (agentName: string) => HyperchartInspectAgentDefaults | undefined;
	now?: number;
	/** Host-specific session transcript reader; defaults to the neutral JSONL format. */
	readTranscript?: SessionTranscriptReader;
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
	const sessionsDir = resolve(absoluteRunDir, "sessions");
	const readTranscript = options.readTranscript ?? readNeutralSessionTranscript;
	const rawSessionProgress = readSessionProgress(sessionsDir);
	const sessionProgress = {
		...rawSessionProgress,
		sessions: Object.fromEntries(
			Object.entries(rawSessionProgress.sessions).map(([key, session]) => {
				const messages = readTranscript(sessionsDir, session.sessionFile);
				return [key, { ...session, ...(messages === undefined ? {} : { messages }) }];
			}),
		),
	};
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
