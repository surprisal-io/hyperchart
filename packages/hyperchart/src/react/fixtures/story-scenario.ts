import type { DurableLogRecord } from "../../core/durable_events.js";
import { inspectChartAst } from "../../core/inspect_ast.js";
import { normalizeChartConfig } from "../../core/normalize.js";
import { explainReplay } from "../../core/replay_check.js";
import type { ChartAst, ChartCst } from "../../core/types.js";
import {
	hyperchartRunFromInspectResult,
	hyperchartRunFromRuntime,
	type HyperchartRunFromRuntimeOptions,
} from "../../host/adapters.js";
import type { HyperchartRunInfo } from "../../host/models.js";

export type StoryScenario = Readonly<{
	ast: ChartAst;
	inspect: ReturnType<typeof inspectChartAst>;
	staticRun(options?: Parameters<typeof hyperchartRunFromInspectResult>[1]): HyperchartRunInfo;
	runtimeRun(records: readonly DurableLogRecord[], options?: HyperchartRunFromRuntimeOptions): HyperchartRunInfo;
}>;

/** Production-boundary fixture: chart normalization + inspection + replay-checked runtime projection. */
export function storyScenario(chart: ChartCst, path = `storybook:${chart.id}`): StoryScenario {
	const parsed = normalizeChartConfig(chart, { path });
	if (!parsed.ok) throw new Error(parsed.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join("\n"));
	const ast = parsed.ast;
	const inspect = inspectChartAst(ast, { chartPath: path });
	return {
		ast,
		inspect,
		staticRun: (options = {}) => hyperchartRunFromInspectResult(inspect, options),
		runtimeRun: (records, options = {}) => {
			const replay = explainReplay(ast, records);
			if (replay.broken !== undefined || replay.prefixEnd !== records.length || replay.stale.length > 0 || replay.skipped.length > 0) {
				throw new Error(`invalid Storybook durable log for ${ast.id}: ${JSON.stringify(replay)}`);
			}
			return hyperchartRunFromRuntime(inspect, ast, records, options);
		},
	};
}

export function actionAt(ast: ChartAst, statePath: string) {
	const state = ast.states[statePath];
	if (state?.kind !== "state") throw new Error(`expected action state at ${statePath}`);
	return state.action;
}

export function storyArgs(args: Record<string, unknown>, seqId = 1, timestamp = seqId): DurableLogRecord {
	return { type: "args", args, parentId: null, branchId: "main", seqId, timestamp };
}

export function storyInvoke(ast: ChartAst, statePath: string, seqId: number, timestamp = seqId): DurableLogRecord {
	const action = actionAt(ast, statePath);
	return { type: "state_action", kind: "invoke", actionUid: action.uid, definition: action, parentId: seqId - 1, branchId: "main", seqId, timestamp };
}

export function storyComplete(ast: ChartAst, statePath: string, event: string, seqId: number, timestamp = seqId): DurableLogRecord {
	const action = actionAt(ast, statePath);
	return { type: "state_action", kind: "complete", actionUid: action.uid, event: { type: event }, parentId: seqId - 1, branchId: "main", seqId, timestamp };
}
