import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { HyperchartInspectAgentDefaults } from "@surprisal/hyperchart/internal/core/inspect_ast";
import {
	createAgentDefaultsResolver as createDefaultsResolverForDirs,
	loadAgentDefinition as loadAgentDefinitionGeneric,
	uniqueExistingDirs,
	type AgentDefinition,
	type ThinkingLevel,
} from "@surprisal/hyperchart/runtime";

export type { AgentDefinition, ThinkingLevel };

// Pi's own frontmatter parser keeps definition parsing byte-compatible with the
// rest of the Pi agent ecosystem.
const parsePiFrontmatter = (content: string) => parseFrontmatter<Record<string, unknown>>(content);

export function loadAgentDefinition(name: string, dirs: string[]): AgentDefinition {
	return loadAgentDefinitionGeneric(name, dirs, parsePiFrontmatter);
}

export function resolvePiSubagentDefinitionDirs(cwd: string, agentDir: string = getAgentDir(), chartPath?: string): string[] {
	return uniqueExistingDirs([
		...(chartPath === undefined ? [] : [join(dirname(resolve(chartPath)), "agents")]),
		...projectAgentDirs(cwd),
		join(homedir(), ".agents"),
		join(agentDir, "agents"),
		...packageAgentDirs(cwd, agentDir),
	]);
}

export function createAgentDefaultsResolver(
	cwd: string,
	agentDir: string = getAgentDir(),
	chartPath?: string,
): (agentName: string) => HyperchartInspectAgentDefaults {
	return createDefaultsResolverForDirs(resolvePiSubagentDefinitionDirs(cwd, agentDir, chartPath), parsePiFrontmatter);
}

function projectAgentDirs(cwd: string): string[] {
	const root = findNearestProjectRoot(cwd);
	if (root === undefined) return [];
	return [join(root, CONFIG_DIR_NAME, "agents"), join(root, ".agents")];
}

function packageAgentDirs(cwd: string, agentDir: string): string[] {
	const dirs: string[] = [];
	for (const [settingsPath, baseDir] of settingsFiles(cwd, agentDir)) {
		const settings = readJsonObject(settingsPath);
		const packages = Array.isArray(settings?.packages) ? settings.packages : [];
		for (const source of packages) {
			if (typeof source !== "string") continue;
			const root = resolvePackageRoot(source, baseDir);
			if (root === undefined) continue;
			dirs.push(...agentDirsFromPackageRoot(root));
		}
	}
	return dirs;
}

function settingsFiles(cwd: string, agentDir: string): [settingsPath: string, baseDir: string][] {
	const files: [string, string][] = [[join(agentDir, "settings.json"), agentDir]];
	const projectRoot = findNearestProjectRoot(cwd);
	if (projectRoot !== undefined) {
		const projectConfigDir = join(projectRoot, CONFIG_DIR_NAME);
		files.push([join(projectConfigDir, "settings.json"), projectConfigDir]);
	}
	return files;
}

function resolvePackageRoot(source: string, baseDir: string): string | undefined {
	const trimmed = source.trim();
	if (trimmed.length === 0) return undefined;
	if (trimmed.startsWith("npm:")) {
		const packageName = parseNpmPackageName(trimmed.slice(4));
		return packageName === undefined ? undefined : join(baseDir, "npm", "node_modules", packageName);
	}
	const normalized = trimmed.startsWith("file:") ? trimmed.slice(5) : trimmed;
	if (normalized === "~") return homedir();
	if (normalized.startsWith("~/")) return join(homedir(), normalized.slice(2));
	if (resolve(normalized) === normalized) return normalized;
	if (normalized.startsWith(".") || normalized.startsWith("..")) return resolve(baseDir, normalized);
	return undefined;
}

function parseNpmPackageName(spec: string): string | undefined {
	const match = spec.trim().match(/^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/);
	const packageName = match?.[1];
	if (packageName === undefined || packageName.includes("..")) return undefined;
	return packageName;
}

function agentDirsFromPackageRoot(root: string): string[] {
	const dirs: string[] = [];
	const pkg = readJsonObject(join(root, "package.json"));
	for (const config of packageSubagentConfigs(pkg)) {
		if (Array.isArray(config.agents)) {
			for (const entry of config.agents) {
				if (typeof entry === "string" && isSafeRelativePath(entry)) dirs.push(resolve(root, entry));
			}
		}
	}
	// pi-subagents ships its built-ins in packageRoot/agents without declaring them in package.json.
	dirs.push(join(root, "agents"));
	return dirs;
}

function packageSubagentConfigs(pkg: Record<string, unknown> | undefined): Record<string, unknown>[] {
	if (pkg === undefined) return [];
	const configs: Record<string, unknown>[] = [];
	const direct = pkg["pi-subagents"];
	if (isRecord(direct)) configs.push(direct);
	const pi = pkg.pi;
	if (isRecord(pi) && isRecord(pi.subagents)) configs.push(pi.subagents);
	return configs;
}

function isSafeRelativePath(value: string): boolean {
	return value.length > 0 && !isAbsolute(value) && !value.split(/[\\/]/).some((part) => part === ".." || part === "");
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findNearestProjectRoot(cwd: string): string | undefined {
	let current = resolve(cwd);
	while (true) {
		if (isDirectory(join(current, CONFIG_DIR_NAME)) || isDirectory(join(current, ".agents"))) return current;
		const parent = resolve(current, "..");
		if (parent === current) return undefined;
		current = parent;
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
