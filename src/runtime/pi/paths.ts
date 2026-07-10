import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";

const CONFIG_DIR_NAME = ".pi";
export const HYPERCHARTS_DIR_NAME = "hypercharts";
export const RUNS_DIR_NAME = "runs";

export function getProjectHyperchartsDir(cwd: string): string {
	return join(findNearestProjectRoot(cwd) ?? cwd, CONFIG_DIR_NAME, HYPERCHARTS_DIR_NAME);
}

function defaultAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), CONFIG_DIR_NAME, "agent");
}

export function getHyperchartRunsRoot(agentDir: string = defaultAgentDir()): string {
	return join(agentDir, HYPERCHARTS_DIR_NAME, RUNS_DIR_NAME);
}

export function resolveHyperchartRunDir(spec: string, cwd: string, agentDir: string = defaultAgentDir()): string {
	if (isPathLike(spec)) return resolve(cwd, spec);
	return join(getHyperchartRunsRoot(agentDir), spec);
}

export function resolveHyperchartPath(spec: string, cwd: string): string {
	const candidates = hyperchartPathCandidates(spec, cwd);
	const found = candidates.find((candidate) => isFile(candidate));
	if (found !== undefined) return found;
	throw new Error(
		`Hyperchart '${spec}' was not found. Looked in ${getProjectHyperchartsDir(cwd)} and cwd. Tried: ${candidates.join(", ")}`,
	);
}

export function listProjectHypercharts(cwd: string): string[] {
	const root = getProjectHyperchartsDir(cwd);
	if (!isDirectory(root)) return [];
	const files: string[] = [];
	walk(root, files);
	return files
		.filter((file) => file.endsWith(".chart.ts") || file.endsWith(".ts"))
		.map((file) => file.slice(root.length + 1))
		.sort();
}

function hyperchartPathCandidates(spec: string, cwd: string): string[] {
	const variants = chartNameVariants(spec);
	const candidates: string[] = [];
	const projectChartsDir = getProjectHyperchartsDir(cwd);
	if (!isAbsolute(spec) && !spec.startsWith(".")) {
		for (const variant of variants) candidates.push(resolve(projectChartsDir, variant));
	}
	for (const variant of variants) candidates.push(resolve(cwd, variant));
	return [...new Set(candidates)];
}

function chartNameVariants(spec: string): string[] {
	if (hasKnownModuleExtension(spec)) return [spec];
	if (extname(spec) !== "") return [spec];
	return [spec, `${spec}.chart.ts`, `${spec}.ts`];
}

function hasKnownModuleExtension(spec: string): boolean {
	return [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"].some((extension) => spec.endsWith(extension));
}

function isPathLike(spec: string): boolean {
	return isAbsolute(spec) || spec.startsWith(".") || spec.includes("/") || spec.includes("\\");
}

function findNearestProjectRoot(cwd: string): string | undefined {
	let current = resolve(cwd);
	while (true) {
		if (isDirectory(join(current, CONFIG_DIR_NAME))) return current;
		const parent = resolve(current, "..");
		if (parent === current) return undefined;
		current = parent;
	}
}

function walk(dir: string, files: string[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === RUNS_DIR_NAME || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			walk(path, files);
		} else if (entry.isFile()) {
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
