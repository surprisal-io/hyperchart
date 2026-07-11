import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { HyperchartInspectAgentDefaults } from "@surprisal/hyperchart/internal/core/inspect_ast";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type AgentDefinition = {
	name: string;
	description?: string;
	systemPrompt: string;
	tools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	systemPromptMode?: "replace" | "append";
};

type AgentFrontmatter = {
	name?: unknown;
	package?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
	systemPromptMode?: unknown;
	system_prompt_mode?: unknown;
};

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

export function loadAgentDefinition(name: string, dirs: string[]): AgentDefinition {
	for (const dir of dirs) {
		const direct = parseAgentFile(join(dir, `${name}.md`), name);
		if (direct !== undefined) return direct;
	}

	for (const dir of dirs) {
		for (const path of listAgentFiles(dir)) {
			const definition = parseAgentFile(path, name);
			if (definition !== undefined) return definition;
		}
	}
	throw new Error(`Agent definition '${name}' not found in ${dirs.join(", ")}`);
}

export function resolvePiSubagentDefinitionDirs(cwd: string, agentDir: string = getAgentDir()): string[] {
	return uniqueExistingDirs([
		...projectAgentDirs(cwd),
		join(homedir(), ".agents"),
		join(agentDir, "agents"),
		...packageAgentDirs(cwd, agentDir),
	]);
}

export function createAgentDefaultsResolver(
	cwd: string,
	agentDir: string = getAgentDir(),
): (agentName: string) => HyperchartInspectAgentDefaults {
	const dirs = resolvePiSubagentDefinitionDirs(cwd, agentDir);
	const cache = new Map<string, HyperchartInspectAgentDefaults>();
	return (agentName) => {
		const cached = cache.get(agentName);
		if (cached !== undefined) return cached;
		let defaults: HyperchartInspectAgentDefaults;
		try {
			const definition = loadAgentDefinition(agentName, dirs);
			defaults = {
				...(definition.model === undefined ? {} : { model: definition.model }),
				...(definition.thinking === undefined ? {} : { thinking: definition.thinking }),
				...(definition.tools === undefined ? {} : { tools: definition.tools }),
			};
		} catch {
			defaults = { agentDefinitionUnavailable: true };
		}
		cache.set(agentName, defaults);
		return defaults;
	};
}

function parseAgentFile(path: string, requestedName: string): AgentDefinition | undefined {
	if (!existsSync(path)) return undefined;
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	let parsed: { frontmatter: AgentFrontmatter; body: string };
	try {
		parsed = parseFrontmatter<AgentFrontmatter>(content);
	} catch {
		return undefined;
	}
	const { frontmatter, body } = parsed;
	const localName =
		typeof frontmatter.name === "string" && frontmatter.name.trim() !== "" ? frontmatter.name.trim() : fileStem(path);
	const packageName = parsePackageName(frontmatter.package);
	const runtimeName = packageName === undefined ? localName : `${packageName}.${localName}`;
	if (requestedName !== runtimeName && requestedName !== localName && requestedName !== fileStem(path))
		return undefined;

	const tools = parseTools(frontmatter.tools);
	const thinking = parseThinking(frontmatter.thinking);
	return {
		name: runtimeName,
		...(typeof frontmatter.description === "string" ? { description: frontmatter.description } : {}),
		systemPrompt: body.trim(),
		...(tools === undefined ? {} : { tools }),
		...(typeof frontmatter.model === "string" ? { model: frontmatter.model } : {}),
		...(thinking === undefined ? {} : { thinking }),
		systemPromptMode: parsePromptMode(frontmatter.systemPromptMode ?? frontmatter.system_prompt_mode, localName),
	};
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

function listAgentFiles(dir: string): string[] {
	if (!isDirectory(dir)) return [];
	const files: string[] = [];
	walk(dir, files);
	return files.sort();
}

function walk(dir: string, files: string[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			walk(path, files);
		} else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.endsWith(".chain.md")) {
			if (!isLegacyAgentSkillPath(path)) files.push(path);
		}
	}
}

function isLegacyAgentSkillPath(path: string): boolean {
	return path.split(/[\\/]/).some((part, index, parts) => part === ".agents" && parts[index + 1] === "skills");
}

function uniqueExistingDirs(dirs: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const dir of dirs) {
		const resolved = resolve(dir);
		if (seen.has(resolved) || !isDirectory(resolved)) continue;
		seen.add(resolved);
		out.push(resolved);
	}
	return out;
}

function parsePackageName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9.-]/g, "")
		.replace(/-+/g, "-")
		.replace(/\.+/g, ".")
		.replace(/(?:^[-.]+|[-.]+$)/g, "");
	return normalized.length === 0 ? undefined : normalized;
}

function parseTools(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const tools = value
			.filter((entry): entry is string => typeof entry === "string")
			.map((entry) => entry.trim())
			.filter(Boolean);
		return tools.length === 0 ? undefined : tools;
	}
	if (typeof value === "string") {
		const tools = value
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean);
		return tools.length === 0 ? undefined : tools;
	}
	return undefined;
}

function parseThinking(value: unknown): ThinkingLevel | undefined {
	return typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel)
		? (value as ThinkingLevel)
		: undefined;
}

function parsePromptMode(value: unknown, localName: string): "replace" | "append" {
	if (value === "replace" || value === "append") return value;
	return localName === "delegate" ? "append" : "replace";
}

function fileStem(path: string): string {
	return basename(path, ".md");
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
