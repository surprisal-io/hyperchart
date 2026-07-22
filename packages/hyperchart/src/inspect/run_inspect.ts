import { existsSync } from "node:fs";
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
import { resolveAgentDefaults } from "../runtime/generic/agent_definitions.js";
import { JsonlLogStore } from "../runtime/generic/log_store.js";
import { loadRunMeta, type RunMeta } from "../runtime/generic/run_dir.js";
import { readRunStatus } from "../runtime/generic/run_status.js";
import { readRunnerConfig } from "../runtime/generic/runner_main.js";
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
	const agentDefaults = runAgentDefaults(absoluteRunDir, options.agentDefaults);
	const inspect = inspectChartAst(ast, {
		chartPath: meta.chartPath,
		...(meta.exportName === undefined ? {} : { exportName: meta.exportName }),
		...(agentDefaults === undefined ? {} : { agentDefaults }),
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

function runAgentDefaults(
	runDir: string,
	resolver: HyperchartRunFromRunDirOptions["agentDefaults"],
): HyperchartRunFromRunDirOptions["agentDefaults"] {
	if (resolver === undefined) return undefined;
	const configPath = resolve(runDir, "runner.config.json");
	if (!existsSync(configPath)) return resolver;
	try {
		const config = readRunnerConfig(configPath);
		return (agentName) => {
			const defaults = resolver(agentName);
			return defaults === undefined
				? undefined
				: resolveAgentDefaults(defaults, {
						...(config.defaultModel === undefined ? {} : { defaultModel: config.defaultModel }),
						...(config.modelRoles === undefined ? {} : { modelRoles: config.modelRoles }),
						...(config.toolsets === undefined ? {} : { toolsets: config.toolsets }),
					});
		};
	} catch {
		return (agentName) => {
			const defaults = resolver(agentName);
			if (defaults === undefined) return undefined;
			const declared = { ...defaults };
			delete declared.resolvedModel;
			delete declared.resolvedTools;
			return declared;
		};
	}
}

function parsedRunAst(meta: RunMeta): ChartAst {
	const parsed = parseChartModuleSync(
		meta.chartPath,
		meta.exportName === undefined ? {} : { exportName: meta.exportName },
	);
	if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	return parsed.ast;
}
