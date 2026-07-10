import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { inspectChartModuleSync, type HyperchartInspectAgentDefaults } from "../../core/inspect.js";
import type {
	HyperchartHostAdapter,
	HyperchartSessionSnapshot,
	HyperchartSnapshotOptions,
} from "../../host/adapter.js";
import { hyperchartRunFromInspectResult } from "../../host/adapters.js";
import type { HyperchartInfo, HyperchartRunInfo } from "../../host/models.js";
import { loadRunMeta } from "../generic/run_dir.js";
import { getHyperchartRunsRoot, getProjectHyperchartsDir, listProjectHypercharts } from "./paths.js";
import { hyperchartRunFromRunDir } from "./run_inspect.js";

export interface PiHyperchartHostOptions {
	agentDir?: string;
	agentDefaults?: (agentName: string) => HyperchartInspectAgentDefaults | undefined;
}

export function createPiHyperchartHost(options: PiHyperchartHostOptions = {}): HyperchartHostAdapter {
	const failedRunMetaFingerprints = new Map<string, string>();
	const agentDir = resolve(options.agentDir ?? defaultAgentDir());

	return {
		readSessionSnapshot: (cwd, snapshotOptions = {}) =>
			readSessionSnapshot(resolve(cwd), agentDir, snapshotOptions, options.agentDefaults, failedRunMetaFingerprints),
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
	agentDefaults: PiHyperchartHostOptions["agentDefaults"],
	failedRunMetaFingerprints: Map<string, string>,
): Promise<HyperchartSessionSnapshot> {
	const [hypercharts, runs] = await Promise.all([
		readHypercharts(cwd, agentDir, agentDefaults),
		readRuns(cwd, agentDir, options.runLimit ?? 50, agentDefaults, failedRunMetaFingerprints),
	]);
	return { hypercharts, runs };
}

async function readHypercharts(
	cwd: string,
	agentDir: string,
	agentDefaults: PiHyperchartHostOptions["agentDefaults"],
): Promise<HyperchartInfo[]> {
	const projectRoot = getProjectHyperchartsDir(cwd);
	const userRoot = join(agentDir, "hypercharts");
	const projectFiles = listProjectHypercharts(cwd).map((path) => join(projectRoot, path));
	const userFiles = await listChartFiles(userRoot);
	const byName = new Map<string, HyperchartInfo>();

	for (const [scope, files, root] of [
		["user", userFiles, userRoot],
		["project", projectFiles, projectRoot],
	] as const) {
		for (const source of files) {
			const info = await readChart(source, root, scope, cwd, agentDefaults);
			if (info) byName.set(info.name, info);
		}
	}

	return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function readChart(
	source: string,
	root: string,
	scope: HyperchartInfo["scope"],
	cwd: string,
	agentDefaults: PiHyperchartHostOptions["agentDefaults"],
): Promise<HyperchartInfo | undefined> {
	try {
		const file = await stat(source);
		const inspect = inspectChartModuleSync(source, agentDefaults === undefined ? {} : { agentDefaults });
		const run = hyperchartRunFromInspectResult(inspect, { cwd, updatedAt: file.mtimeMs });
		const rel = relative(root, source).replaceAll("\\", "/");
		return {
			name: run.chartName,
			description: rel,
			scope,
			source: resolve(source),
			...(run.definitionSource === undefined ? {} : { definitionSource: run.definitionSource }),
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
	agentDefaults: PiHyperchartHostOptions["agentDefaults"],
	failedRunMetaFingerprints: Map<string, string>,
): Promise<HyperchartRunInfo[]> {
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
			.map((entry) => readRun(join(root, entry.name), cwd, agentDefaults, failedRunMetaFingerprints)),
	);
	return runs
		.filter((run): run is HyperchartRunInfo => run !== undefined)
		.sort((left, right) => right.updatedAt - left.updatedAt)
		.slice(0, Math.max(0, limit));
}

async function readRun(
	runDir: string,
	cwd: string,
	agentDefaults: PiHyperchartHostOptions["agentDefaults"],
	failedRunMetaFingerprints: Map<string, string>,
): Promise<HyperchartRunInfo | undefined> {
	const metaFingerprint = await fileFingerprint(join(runDir, "meta.json"));
	if (failedRunMetaFingerprints.get(runDir) === metaFingerprint) return undefined;
	let meta;
	try {
		meta = loadRunMeta(runDir);
		failedRunMetaFingerprints.delete(runDir);
	} catch (error) {
		failedRunMetaFingerprints.set(runDir, metaFingerprint);
		console.warn(`[pi-hyperchart] Failed to inspect run ${runDir}:`, error);
		return undefined;
	}
	try {
		if (resolve(meta.workDir) !== cwd) return undefined;
		return await hyperchartRunFromRunDir(runDir, {
			meta,
			...(agentDefaults === undefined ? {} : { agentDefaults }),
		});
	} catch (error) {
		console.warn(`[pi-hyperchart] Failed to inspect run ${runDir}:`, error);
		return undefined;
	}
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
	await walk(root, files);
	return files.sort();
}

async function walk(dir: string, files: string[]): Promise<void> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	await Promise.all(
		entries.map(async (entry) => {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "runs" || entry.name === "node_modules" || entry.name.startsWith(".")) return;
				await walk(path, files);
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
