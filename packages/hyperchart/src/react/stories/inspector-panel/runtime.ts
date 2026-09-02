import { inspectChartAst } from "../../../core/inspect_ast.js";
import { normalizeChartConfig } from "../../../core/normalize.js";
import { templatePath } from "../../../core/paths.js";
import { explainReplay } from "../../../core/replay_check.js";
import { hyperchartSource as coreHyperchartSource } from "../../../core/source.js";
import type { ChartAst, ChartCst } from "../../../core/types.js";
import type { DurableLogRecord } from "../../../core/durable_events.js";
import { hyperchartRunFromInspectResult, type HyperchartRuntimeSessionProgressFile } from "../../../host/index.js";
import { hyperchartRunFromRuntime, type HyperchartRunFromRuntimeOptions } from "../../../host/adapters.js";
import type { HyperchartRunInfo, HyperchartRunStatus } from "../../types.js";
import type { InspectorPanelTileProps, RuntimeSourceBlock } from "../components/index.js";
import { storyLog, type InspectorPanelSpec } from "./specs.js";

type ChartValidationResult = { ok: true; ast: ChartAst } | { ok: false; message: string };

function validateChartForStory(cst: ChartCst): ChartValidationResult {
	try {
		const parsed = normalizeChartConfig(cst, { path: `storybook:${cst.id}` });
		if (parsed.ok) return { ok: true, ast: parsed.ast };
		return {
			ok: false,
			message: parsed.diagnostics
				.map((diagnostic) => `${diagnostic.path ?? ""} ${diagnostic.code}: ${diagnostic.message}`)
				.join("\n"),
		};
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

type InspectorPanelGeneratedRuntime = {
	records: DurableLogRecord[];
	status: NonNullable<HyperchartRunFromRuntimeOptions["status"]>;
	sessionProgress?: HyperchartRuntimeSessionProgressFile;
};

function generatedRuntimeForInspectorPanelSpec(
	spec: InspectorPanelSpec,
	ast: ChartAst,
	key: string,
): InspectorPanelGeneratedRuntime {
	const args = spec.runtime.run?.args ?? { topic: "visual QA board" };
	const records = spec.runtime.records?.(ast) ?? storyLog(args).records;
	const status = storyRunStatus(spec, ast, key);
	const sessionProgress = spec.runtime.sessionProgress?.(ast);
	return { records, status, ...(sessionProgress === undefined ? {} : { sessionProgress }) };
}

function runFromInspectorPanelSpec(
	spec: InspectorPanelSpec,
	ast: ChartAst,
	key: string,
	generated = generatedRuntimeForInspectorPanelSpec(spec, ast, key),
): HyperchartRunInfo {
	if (spec.runtime.mode === "static") {
		return hyperchartRunFromInspectResult(inspectChartAst(ast, { chartPath: `storybook:${ast.id}` }), {
			runId: `inspect:${key}`,
			cwd: "/Users/demo/Work/pi-hyperchart",
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_060_000,
		});
	}
	const replay = explainReplay(ast, generated.records);
	if (replay.broken !== undefined || replay.prefixEnd !== generated.records.length || replay.stale.length > 0 || replay.skipped.length > 0) {
		throw new Error(`invalid inspector-panel story log for ${key}: ${JSON.stringify(replay)}`);
	}
	return hyperchartRunFromRuntime(inspectChartAst(ast, { chartPath: `storybook:${ast.id}` }), ast, generated.records, {
		runId: `inspector-panel-${key}`,
		status: generated.status,
		...(generated.sessionProgress === undefined ? {} : { sessionProgress: generated.sessionProgress }),
		cwd: "/Users/demo/Work/pi-hyperchart",
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_060_000,
	});
}

function storyRunStatus(
	spec: InspectorPanelSpec,
	ast: ChartAst,
	key: string,
): NonNullable<HyperchartRunFromRuntimeOptions["status"]> {
	const replayWarnings = spec.runtime.run?.replayWarnings;
	const exitCode = spec.runtime.run?.exitCode ?? (spec.runtime.run?.statusError === undefined ? undefined : 1);
	return {
		runId: `inspector-panel-${key}`,
		runDir: `/tmp/pi-hyperchart/storybook/${key}`,
		chartId: ast.id,
		state: storyRuntimeStatus(spec.runtime.run?.status),
		startedAt: 1_700_000_000_000,
		updatedAt: 1_700_000_060_000,
		...(spec.runtime.run?.statusError === undefined ? {} : { error: spec.runtime.run.statusError }),
		...(exitCode === undefined ? {} : { exitCode }),
		...(replayWarnings === undefined || replayWarnings.length === 0 ? {} : { replayWarnings }),
	};
}

function storyRuntimeStatus(status: HyperchartRunStatus | undefined): string {
	if (status === "completed") return "complete";
	if (status === "failed") return "failed";
	if (status === "paused") return "stopped";
	return "running";
}

function formatJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

export function inspectorPanelScenario(spec: InspectorPanelSpec): { run: HyperchartRunInfo; selectedStateId: string | null } | undefined {
	const validation = validateChartForStory(spec.chart);
	if (!validation.ok) return undefined;
	const key = spec.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
	return { run: runFromInspectorPanelSpec(spec, validation.ast, key), selectedStateId: spec.runtime.selectedStateId };
}

export function inspectorPanelTileProps(spec: InspectorPanelSpec): InspectorPanelTileProps {
	const { title, description, runtime, chart } = spec;
	const validation = validateChartForStory(chart);
	if (!validation.ok) return { variant: "validation-error", title, message: validation.message };
	const { ast } = validation;
	const key = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");
	const generated = generatedRuntimeForInspectorPanelSpec(spec, ast, key);
	const run = runFromInspectorPanelSpec(spec, ast, key, generated);
	const state = runtime.selectedStateId
		? run.states.find((candidate) => candidate.id === runtime.selectedStateId)
		: undefined;
	const definitionStateId = state?.actorInternal !== undefined
		? `${state.actorInternal.declarationPath}.${state.actorInternal.localState}`
		: state?.actorDeclaration !== undefined
			? state.actorDeclaration.declarationPath
			: runtime.selectedStateId === null ? null : templatePath(runtime.selectedStateId);
	const definitionSource = state?.definitionSource ?? coreHyperchartSource(ast, definitionStateId);
	return {
		variant: "panel",
		title,
		description,
		run,
		selectedStateId: runtime.selectedStateId,
		definitionSource,
		runtimeSources: generatedRuntimeSources(definitionSource, generated, runtime.mode === "static"),
	};
}

function generatedRuntimeSources(
	definitionSource: string,
	generated: InspectorPanelGeneratedRuntime,
	staticOnly = false,
): RuntimeSourceBlock[] {
	return [
		{ title: "Definition", code: definitionSource, language: "typescript" },
		...(staticOnly
			? []
			: [
					{ title: "log records", code: formatJson(generated.records), language: "json" },
					{ title: "status.json", code: formatJson(generated.status), language: "json" },
					...(generated.sessionProgress === undefined
						? []
						: [{ title: "sessions/progress.json", code: formatJson(generated.sessionProgress), language: "json" }]),
				]),
	];
}
