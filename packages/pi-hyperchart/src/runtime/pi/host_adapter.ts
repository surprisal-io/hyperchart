import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import * as ts from "typescript";
import { inspectChartModuleSync, type HyperchartInspectAgentDefaults } from "@surprisal/hyperchart/internal/core/inspect";
import type {
	HyperchartHostAdapter,
	HyperchartSessionSnapshot,
	HyperchartSnapshotOptions,
} from "@surprisal/hyperchart/host";
import { hyperchartRunFromInspectResult } from "@surprisal/hyperchart/host";
import type { HyperchartInfo, HyperchartRunInfo, HyperchartRunSummaryInfo, HyperchartSummaryInfo } from "@surprisal/hyperchart/host";
import { loadRunMeta } from "@surprisal/hyperchart/runtime";
import { getHyperchartRunsRoot, getProjectHyperchartsDir, getSharedHyperchartsDir, listProjectHypercharts } from "./paths.js";
import { createAgentDefaultsResolver } from "./agent_definitions.js";
import {
	createPiFileTranscriptReader,
	hyperchartRunFromRunDir,
	type SessionTranscriptReader,
} from "./run_inspect.js";
import { isRunLive, readRunStatus, type HyperchartRunStatus } from "@surprisal/hyperchart/sessions";

type SessionTranscriptReaderFactory = (runDir: string) => SessionTranscriptReader;

export interface PiHyperchartHostOptions {
	agentDir?: string;
	agentDefaults?: (agentName: string) => HyperchartInspectAgentDefaults | undefined;
}

export function createPiHyperchartHost(options: PiHyperchartHostOptions = {}): HyperchartHostAdapter {
	const failedRunMetaFingerprints = new Map<string, string>();
	const failedRunInspectionFingerprints = new Map<string, string>();
	const agentDir = resolve(options.agentDir ?? defaultAgentDir());

	return {
		readSessionSnapshot: (cwd, snapshotOptions = {}) =>
			readSessionSnapshot(resolve(cwd), agentDir, snapshotOptions, failedRunMetaFingerprints),
		readChartSnapshot: async (cwd, chartName) => {
			const resolvedCwd = resolve(cwd);
			const chart = (await discoverHypercharts(resolvedCwd, agentDir)).find((candidate) => candidate.name === chartName);
			if (chart === undefined) return undefined;
			return readChart(chart.source, chart.root, chart.scope, resolvedCwd, agentDir, options.agentDefaults);
		},
		readRunSnapshot: async (cwd, runId) => {
			if (basename(runId) !== runId) return undefined;
			return readRun(
				join(getHyperchartRunsRoot(agentDir), runId),
				resolve(cwd),
				agentDir,
				true,
				options.agentDefaults,
				createPiFileTranscriptReader,
				failedRunMetaFingerprints,
				failedRunInspectionFingerprints,
			);
		},
	};
}

export const piHyperchartHost: HyperchartHostAdapter = createPiHyperchartHost();

function defaultAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

async function readSessionSnapshot(
	cwd: string,
	agentDir: string,
	options: HyperchartSnapshotOptions,
	failedRunMetaFingerprints: Map<string, string>,
): Promise<HyperchartSessionSnapshot> {
	const [hypercharts, runs] = await Promise.all([
		readHypercharts(cwd, agentDir),
		readRuns(cwd, agentDir, options.runLimit ?? 50, failedRunMetaFingerprints),
	]);
	return { hypercharts, runs };
}

async function readHypercharts(cwd: string, agentDir: string): Promise<HyperchartSummaryInfo[]> {
	return (await discoverHypercharts(cwd, agentDir)).map(({ root: _root, ...summary }) => summary);
}

type DiscoveredHyperchart = HyperchartSummaryInfo & {
	source: string;
	root: string;
};

async function discoverHypercharts(cwd: string, agentDir: string): Promise<DiscoveredHyperchart[]> {
	const projectRoot = getProjectHyperchartsDir(cwd);
	const sharedRoot = getSharedHyperchartsDir(cwd);
	const userRoot = join(agentDir, "hypercharts");
	const projectFiles = listProjectHypercharts(cwd).map((path) => join(projectRoot, path));
	const sharedFiles = sharedRoot === undefined ? [] : await listChartFiles(sharedRoot);
	const userFiles = await listChartFiles(userRoot);
	const byName = new Map<string, DiscoveredHyperchart>();

	// Weakest scope first: shared shadows user and host-specific project shadows both.
	for (const [scope, files, root] of [
		["user", userFiles, userRoot],
		["project", sharedFiles, sharedRoot ?? projectRoot],
		["project", projectFiles, projectRoot],
	] as const) {
		for (const source of files) {
			const summary = await discoverChart(source, root, scope);
			if (summary !== undefined) byName.set(summary.name, summary);
		}
	}

	return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function discoverChart(
	source: string,
	root: string,
	scope: HyperchartInfo["scope"],
): Promise<DiscoveredHyperchart | undefined> {
	try {
		const [file, text] = await Promise.all([stat(source), readFile(source, "utf8")]);
		const literal = inspectLiteralChartModule(text, source);
		return {
			name: literal?.name ?? chartNameFor(source, root),
			description: relative(root, source).replaceAll("\\", "/"),
			scope,
			source: resolve(source),
			root,
			...(literal?.stateCount === undefined ? {} : { stateCount: literal.stateCount }),
			updatedAt: file.mtimeMs,
		};
	} catch {
		return undefined;
	}
}

function inspectLiteralChartModule(text: string, source: string): { name?: string; stateCount?: number } | undefined {
	const sourceFile = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const exported = sourceFile.statements.find(
		(statement): statement is ts.ExportAssignment => ts.isExportAssignment(statement) && !statement.isExportEquals,
	);
	if (exported === undefined) return undefined;
	const definition = literalObject(exported.expression, sourceFile);
	if (definition === undefined) return undefined;
	const id = propertyInitializer(definition, "id");
	const states = propertyInitializer(definition, "states");
	const name = id !== undefined && (ts.isStringLiteral(id) || ts.isNoSubstitutionTemplateLiteral(id)) ? id.text : undefined;
	const stateCount = states === undefined ? undefined : countLiteralStates(states, sourceFile);
	return {
		...(name === undefined ? {} : { name }),
		...(stateCount === undefined ? {} : { stateCount }),
	};
}

function literalObject(expression: ts.Expression, sourceFile: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
	const unwrapped = unwrapExpression(expression);
	if (ts.isObjectLiteralExpression(unwrapped)) return unwrapped;
	if (ts.isCallExpression(unwrapped)) {
		const argument = unwrapped.arguments[0];
		return argument === undefined ? undefined : literalObject(argument, sourceFile);
	}
	if (ts.isIdentifier(unwrapped)) {
		for (const statement of sourceFile.statements) {
			if (!ts.isVariableStatement(statement)) continue;
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name) && declaration.name.text === unwrapped.text && declaration.initializer !== undefined) {
					return literalObject(declaration.initializer, sourceFile);
				}
			}
		}
	}
	return undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isNonNullExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function propertyInitializer(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
	let initializer: ts.Expression | undefined;
	for (const property of object.properties) {
		if (ts.isSpreadAssignment(property)) {
			// A later spread may replace an earlier literal field, so it is no longer statically known.
			initializer = undefined;
			continue;
		}
		if (!ts.isPropertyAssignment(property)) continue;
		const propertyName = property.name;
		if (
			(ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName) || ts.isNumericLiteral(propertyName)) &&
			propertyName.text === name
		) initializer = unwrapExpression(property.initializer);
	}
	return initializer;
}

function countLiteralStates(expression: ts.Expression, sourceFile: ts.SourceFile): number | undefined {
	const states = literalObject(expression, sourceFile);
	if (states === undefined || states.properties.some((property) => !ts.isPropertyAssignment(property))) return undefined;
	let count = states.properties.length;
	for (const property of states.properties) {
		if (!ts.isPropertyAssignment(property)) return undefined;
		const state = literalObject(property.initializer, sourceFile);
		if (state === undefined) continue;
		const children = propertyInitializer(state, "states");
		if (children === undefined) continue;
		const childCount = countLiteralStates(children, sourceFile);
		if (childCount === undefined) return undefined;
		count += childCount;
	}
	return count;
}

function chartNameFor(source: string, root: string): string {
	const rel = relative(root, source).replaceAll("\\", "/");
	if (rel !== "chart.ts" && rel.endsWith("/chart.ts")) return rel.slice(0, -"/chart.ts".length);
	return rel.replace(/(?:\.chart)?\.ts$/, "");
}

async function readChart(
	source: string,
	root: string,
	scope: HyperchartInfo["scope"],
	cwd: string,
	agentDir: string,
	agentDefaults: PiHyperchartHostOptions["agentDefaults"],
): Promise<HyperchartInfo | undefined> {
	try {
		const file = await stat(source);
		const resolvedAgentDefaults = agentDefaults ?? createAgentDefaultsResolver(cwd, agentDir, source);
		const inspect = inspectChartModuleSync(source, { agentDefaults: resolvedAgentDefaults });
		const run = hyperchartRunFromInspectResult(inspect, { cwd, updatedAt: file.mtimeMs });
		const rel = relative(root, source).replaceAll("\\", "/");
		return {
			name: run.chartName,
			description: rel,
			scope,
			source: resolve(source),
			...(inspect.definitionSource === undefined ? {} : { definitionSource: inspect.definitionSource }),
			...(inspect.args === undefined ? {} : { args: inspect.args }),
			states: run.states,
			stateCount: run.stateCount,
			updatedAt: file.mtimeMs,
		};
	} catch {
		return undefined;
	}
}

async function readRuns(
	cwd: string,
	agentDir: string,
	limit: number,
	failedRunMetaFingerprints: Map<string, string>,
): Promise<HyperchartRunSummaryInfo[]> {
	const root = getHyperchartRunsRoot(agentDir);
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}

	const runs = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => readRunSummary(join(root, entry.name), cwd, failedRunMetaFingerprints)),
	);
	return runs
		.filter((run): run is HyperchartRunSummaryInfo => run !== undefined)
		.sort((left, right) => right.updatedAt - left.updatedAt)
		.slice(0, Math.max(0, limit));
}

async function readRunSummary(
	runDir: string,
	cwd: string,
	failedRunMetaFingerprints: Map<string, string>,
): Promise<HyperchartRunSummaryInfo | undefined> {
	const metaFingerprint = process.env.HYPERCHART_PG_DSN ? undefined : await fileFingerprint(join(runDir, "meta.json"));
	if (metaFingerprint !== undefined && failedRunMetaFingerprints.get(runDir) === metaFingerprint) return undefined;
	let meta;
	try {
		meta = await loadRunMeta(runDir);
		failedRunMetaFingerprints.delete(runDir);
	} catch (error) {
		if (metaFingerprint !== undefined) failedRunMetaFingerprints.set(runDir, metaFingerprint);
		console.warn(`[pi-hyperchart] Failed to inspect run ${runDir}:`, error);
		return undefined;
	}
	if (resolve(meta.workDir) !== cwd) return undefined;
	const persistedStatus = readRunStatus(runDir);
	const metaCreatedAt = Date.parse(meta.createdAt);
	const createdAt = persistedStatus?.startedAt ?? (Number.isFinite(metaCreatedAt) ? metaCreatedAt : 0);
	const updatedAt = persistedStatus?.updatedAt ?? await runUpdatedAt(runDir, createdAt);
	return {
		runId: persistedStatus?.runId ?? basename(runDir),
		chartName: persistedStatus?.chartId ?? meta.chartId,
		branchId: "main",
		...(persistedStatus === undefined ? {} : { runnerBranchIds: persistedStatus.branchIds }),
		...(meta.originSessionId === undefined ? {} : { originSessionId: meta.originSessionId }),
		status: summaryRunStatus(persistedStatus),
		cwd: resolve(meta.workDir),
		createdAt: createdAt || updatedAt,
		updatedAt,
		...(persistedStatus?.pid === undefined ? {} : { pid: persistedStatus.pid }),
		...(persistedStatus?.state === "stopped" ? { detached: true } : {}),
	};
}

async function readRun(
	runDir: string,
	cwd: string,
	agentDir: string,
	includeTranscripts: boolean,
	agentDefaults: PiHyperchartHostOptions["agentDefaults"],
	transcriptReader: SessionTranscriptReaderFactory,
	failedRunMetaFingerprints: Map<string, string>,
	failedRunInspectionFingerprints: Map<string, string>,
): Promise<HyperchartRunInfo | undefined> {
	const metaFingerprint = process.env.HYPERCHART_PG_DSN ? undefined : await fileFingerprint(join(runDir, "meta.json"));
	if (metaFingerprint !== undefined && failedRunMetaFingerprints.get(runDir) === metaFingerprint) return undefined;
	let meta;
	try {
		meta = await loadRunMeta(runDir);
		failedRunMetaFingerprints.delete(runDir);
	} catch (error) {
		if (metaFingerprint !== undefined) failedRunMetaFingerprints.set(runDir, metaFingerprint);
		console.warn(`[pi-hyperchart] Failed to inspect run ${runDir}:`, error);
		return undefined;
	}
	const inspectionFingerprint = metaFingerprint ?? JSON.stringify(meta);
	try {
		if (resolve(meta.workDir) !== cwd) return undefined;
		const resolvedAgentDefaults = agentDefaults ?? createAgentDefaultsResolver(cwd, agentDir, meta.chartPath);
		const run = await hyperchartRunFromRunDir(runDir, includeTranscripts
			? {
					meta,
					includeTranscripts: true,
					readTranscript: transcriptReader(runDir),
					agentDefaults: resolvedAgentDefaults,
			  }
			: {
					meta,
					includeTranscripts: false,
					agentDefaults: resolvedAgentDefaults,
			  });
		failedRunInspectionFingerprints.delete(runDir);
		return {
			...run,
			...(meta.originSessionId === undefined ? {} : { originSessionId: meta.originSessionId }),
		};
	} catch (error) {
		if (failedRunInspectionFingerprints.get(runDir) !== inspectionFingerprint) {
			failedRunInspectionFingerprints.set(runDir, inspectionFingerprint);
			console.warn(`[pi-hyperchart] Failed to inspect run ${runDir}:`, error);
		}
		const persistedStatus = readRunStatus(runDir);
		const metaCreatedAt = Date.parse(meta.createdAt);
		const createdAt = persistedStatus?.startedAt ?? (Number.isFinite(metaCreatedAt) ? metaCreatedAt : 0);
		const updatedAt = persistedStatus?.updatedAt ?? await runUpdatedAt(runDir, createdAt);
		return {
			runId: persistedStatus?.runId ?? basename(runDir),
			chartName: persistedStatus?.chartId ?? meta.chartId,
			branchId: "main",
			...(persistedStatus === undefined ? {} : { runnerBranchIds: persistedStatus.branchIds }),
			...(meta.originSessionId === undefined ? {} : { originSessionId: meta.originSessionId }),
			description: meta.chartPath,
			status: metadataOnlyStatus(persistedStatus),
			cwd: resolve(meta.workDir),
			createdAt: createdAt || updatedAt,
			updatedAt,
			args: {},
			states: [],
			stateCount: 0,
			issues: [{
				severity: "error",
				kind: "run_failed",
				message: `Run inspection failed: ${error instanceof Error ? error.message : String(error)}`,
				source: "status",
			}],
		};
	}
}

function summaryRunStatus(status: HyperchartRunStatus | undefined): HyperchartRunInfo["status"] {
	switch (status?.state) {
		case "complete": return "completed";
		case "failed": return "failed";
		case "stopped":
		case "stopping": return "paused";
		case "starting":
		case "running": return "running";
		default: return "blocked";
	}
}

function metadataOnlyStatus(status: HyperchartRunStatus | undefined): HyperchartRunInfo["status"] {
	switch (status?.state) {
		case "complete": return "completed";
		case "failed": return "failed";
		case "stopped": return "paused";
		case "starting":
		case "running":
		case "stopping": return isRunLive(status) ? "running" : "blocked";
		default: return "blocked";
	}
}

async function runUpdatedAt(runDir: string, fallback: number): Promise<number> {
	const timestamps = await Promise.all(
		["meta.json", "status.json", "log.jsonl"].map(async (name) => {
			try {
				return (await stat(join(runDir, name))).mtimeMs;
			} catch {
				return 0;
			}
		}),
	);
	return Math.max(fallback, ...timestamps);
}

async function fileFingerprint(path: string): Promise<string> {
	try {
		const value = await stat(path);
		return `${value.mtimeMs}:${value.size}`;
	} catch {
		return "-";
	}
}

async function listChartFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	await walk(root, files, root);
	return files.sort();
}

async function walk(dir: string, files: string[], root: string): Promise<void> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	if (dir !== root && entries.some((entry) => entry.isFile() && entry.name === "chart.ts")) {
		files.push(join(dir, "chart.ts"));
		return;
	}
	await Promise.all(
		entries.map(async (entry) => {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "runs" || entry.name === "node_modules" || entry.name.startsWith(".")) return;
				await walk(path, files, root);
			} else if (
				entry.isFile() &&
				(entry.name.endsWith(".chart.ts") || entry.name.endsWith(".ts")) &&
				!entry.name.endsWith(".d.ts")
			) {
				files.push(path);
			}
		}),
	);
}
