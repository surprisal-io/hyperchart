import { readdirSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";

export const HYPERCHARTS_DIR_NAME = "hypercharts";
export const RUNS_DIR_NAME = "runs";

export type HostPathsConfig = {
	/** Host config dir name used as the project-root marker and project charts prefix, e.g. ".pi" or ".claude". */
	configDirName: string;
	/** Absolute directory that stores run directories for this host. */
	runsRoot: string;
	/** Optional user-level charts directory searched after project charts. */
	userChartsDir?: string;
	/** Extra directory names that mark a project root in addition to configDirName. */
	projectMarkers?: readonly string[];
};

export type HostPaths = {
	getProjectHyperchartsDir(cwd: string): string;
	getRunsRoot(): string;
	resolveRunDir(spec: string, cwd: string): string;
	resolveChartPath(spec: string, cwd: string): string;
	listProjectHypercharts(cwd: string): string[];
	findNearestProjectRoot(cwd: string): string | undefined;
};

export function createHostPaths(config: HostPathsConfig): HostPaths {
	const markers = [config.configDirName, ...(config.projectMarkers ?? [])];
	const findProjectRoot = (cwd: string): string | undefined => findNearestProjectRoot(cwd, markers);
	const getProjectHyperchartsDir = (cwd: string): string =>
		join(findProjectRoot(cwd) ?? cwd, config.configDirName, HYPERCHARTS_DIR_NAME);
	return {
		getProjectHyperchartsDir,
		getRunsRoot: () => config.runsRoot,
		resolveRunDir(spec, cwd) {
			if (isPathLike(spec)) return resolve(cwd, spec);
			return join(config.runsRoot, spec);
		},
		resolveChartPath(spec, cwd) {
			const candidates = chartPathCandidates(spec, cwd, getProjectHyperchartsDir(cwd), config.userChartsDir);
			const found = candidates.find((candidate) => isFile(candidate));
			if (found !== undefined) return found;
			throw new Error(
				`Hyperchart '${spec}' was not found. Looked in project, user, and cwd locations. Tried: ${candidates.join(", ")}`,
			);
		},
		listProjectHypercharts(cwd) {
			const root = getProjectHyperchartsDir(cwd);
			return listHyperchartFiles(root).map((file) => file.slice(root.length + 1));
		},
		findNearestProjectRoot: findProjectRoot,
	};
}

export function listHyperchartFiles(root: string): string[] {
	if (!isDirectory(root)) return [];
	const files: string[] = [];
	walk(root, files, root, new Set());
	return files
		.filter((file) => file.endsWith(".chart.ts") || file.endsWith(".ts"))
		.sort();
}

function chartPathCandidates(spec: string, cwd: string, projectChartsDir: string, userChartsDir?: string): string[] {
	const variants = chartNameVariants(spec);
	const candidates: string[] = [];
	if (!isAbsolute(spec) && !spec.startsWith(".")) {
		for (const variant of variants) candidates.push(resolve(projectChartsDir, variant));
		if (userChartsDir !== undefined) {
			for (const variant of variants) candidates.push(resolve(userChartsDir, variant));
		}
	}
	for (const variant of variants) candidates.push(resolve(cwd, variant));
	return [...new Set(candidates)];
}

function chartNameVariants(spec: string): string[] {
	if (hasKnownModuleExtension(spec)) return [spec];
	if (extname(spec) !== "") return [spec];
	return [`${spec}/chart.ts`, spec, `${spec}.chart.ts`, `${spec}.ts`];
}

function hasKnownModuleExtension(spec: string): boolean {
	return [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"].some((extension) => spec.endsWith(extension));
}

function isPathLike(spec: string): boolean {
	return isAbsolute(spec) || spec.startsWith(".") || spec.includes("/") || spec.includes("\\");
}

function findNearestProjectRoot(cwd: string, markers: readonly string[]): string | undefined {
	let current = resolve(cwd);
	while (true) {
		if (markers.some((marker) => isDirectory(join(current, marker)))) return current;
		const parent = resolve(current, "..");
		if (parent === current) return undefined;
		current = parent;
	}
}

function walk(dir: string, files: string[], root: string, visitedDirectories: Set<string>): void {
	let realDirectory: string;
	try {
		realDirectory = realpathSync(dir);
	} catch {
		return;
	}
	if (visitedDirectories.has(realDirectory)) return;
	visitedDirectories.add(realDirectory);
	const bundleEntry = join(dir, "chart.ts");
	if (dir !== root && isFile(bundleEntry)) {
		files.push(bundleEntry);
		return;
	}
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === RUNS_DIR_NAME || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(path))) {
			walk(path, files, root, visitedDirectories);
		} else if (entry.isFile() || (entry.isSymbolicLink() && isFile(path))) {
			files.push(path);
		}
	}
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
