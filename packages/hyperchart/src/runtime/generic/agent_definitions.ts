import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { HyperchartInspectAgentDefaults } from "../../core/inspect_ast.js";
import { parseSimpleFrontmatter, type FrontmatterParser } from "./frontmatter.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type AgentDefinition = {
	name: string;
	description?: string;
	systemPrompt: string;
	tools?: string[];
	// A symbolic model tier ("reviewer", "fast") resolved through the host's role->model settings;
	// `model` stays the fallback when the role is not configured.
	role?: string;
	model?: string;
	thinking?: ThinkingLevel;
	systemPromptMode?: "replace" | "append";
};

type AgentFrontmatter = {
	name?: unknown;
	package?: unknown;
	description?: unknown;
	tools?: unknown;
	role?: unknown;
	model?: unknown;
	thinking?: unknown;
	systemPromptMode?: unknown;
	system_prompt_mode?: unknown;
};

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

export function loadAgentDefinition(
	name: string,
	dirs: string[],
	parse: FrontmatterParser = parseSimpleFrontmatter,
): AgentDefinition {
	for (const dir of dirs) {
		const direct = parseAgentFile(join(dir, `${name}.md`), name, parse);
		if (direct !== undefined) return direct;
	}

	for (const dir of dirs) {
		for (const path of listAgentFiles(dir)) {
			const definition = parseAgentFile(path, name, parse);
			if (definition !== undefined) return definition;
		}
	}
	throw new Error(`Agent definition '${name}' not found in ${dirs.join(", ")}`);
}

export function createAgentDefaultsResolver(
	dirs: string[],
	parse: FrontmatterParser = parseSimpleFrontmatter,
): (agentName: string) => HyperchartInspectAgentDefaults {
	const cache = new Map<string, HyperchartInspectAgentDefaults>();
	return (agentName) => {
		const cached = cache.get(agentName);
		if (cached !== undefined) return cached;
		let defaults: HyperchartInspectAgentDefaults;
		try {
			const definition = loadAgentDefinition(agentName, dirs, parse);
			defaults = {
				...(definition.description === undefined ? {} : { description: definition.description }),
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

export function parseAgentFile(
	path: string,
	requestedName: string,
	parse: FrontmatterParser = parseSimpleFrontmatter,
): AgentDefinition | undefined {
	if (!existsSync(path)) return undefined;
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	let parsed: { frontmatter: AgentFrontmatter; body: string };
	try {
		parsed = parse(content);
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
		...(typeof frontmatter.role === "string" && frontmatter.role.trim() !== ""
			? { role: frontmatter.role.trim() }
			: {}),
		...(typeof frontmatter.model === "string" ? { model: frontmatter.model } : {}),
		...(thinking === undefined ? {} : { thinking }),
		systemPromptMode: parsePromptMode(frontmatter.systemPromptMode ?? frontmatter.system_prompt_mode, localName),
	};
}

export function listAgentFiles(dir: string): string[] {
	if (!isDirectory(dir)) return [];
	const files: string[] = [];
	walk(dir, files);
	return files.sort();
}

export function uniqueExistingDirs(dirs: string[]): string[] {
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
