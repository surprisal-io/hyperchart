import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SETTINGS_FILE_NAME = "settings.json";

export type HyperchartHostSettings = {
	/** Role name -> model ref in the host's model format. */
	modelRoles: Record<string, string>;
	/** Toolset name -> tool names in the host's tool vocabulary. */
	toolsets: Record<string, string[]>;
};

/**
 * Merge `settings.json` files inside the given charts directories, in scope
 * order: later directories win per key (pass user scope first, project scope
 * last). A missing file contributes nothing; a malformed one fails loudly so
 * a typo never silently drops a mapping.
 */
export function loadHostSettings(chartsDirs: readonly string[]): HyperchartHostSettings {
	const settings: HyperchartHostSettings = { modelRoles: {}, toolsets: {} };
	for (const dir of chartsDirs) {
		const parsed = readSettingsFile(join(dir, SETTINGS_FILE_NAME));
		Object.assign(settings.modelRoles, parsed.modelRoles);
		Object.assign(settings.toolsets, parsed.toolsets);
	}
	return settings;
}

function readSettingsFile(path: string): HyperchartHostSettings {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return { modelRoles: {}, toolsets: {} };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new Error(
			`Invalid hypercharts settings at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isRecord(parsed)) throw new Error(`Invalid hypercharts settings at ${path}: expected a JSON object`);
	return { modelRoles: parseRoles(parsed.roles, path), toolsets: parseToolsets(parsed.toolsets, path) };
}

function parseRoles(value: unknown, path: string): Record<string, string> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error(`Invalid hypercharts settings at ${path}: 'roles' must be an object`);
	for (const [role, model] of Object.entries(value)) {
		if (typeof model !== "string" || model.trim() === "") {
			throw new Error(`Invalid hypercharts settings at ${path}: role '${role}' must map to a model string`);
		}
	}
	return value as Record<string, string>;
}

function parseToolsets(value: unknown, path: string): Record<string, string[]> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error(`Invalid hypercharts settings at ${path}: 'toolsets' must be an object`);
	for (const [name, tools] of Object.entries(value)) {
		if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string" || tool.trim() === "")) {
			throw new Error(
				`Invalid hypercharts settings at ${path}: toolset '${name}' must map to an array of tool names`,
			);
		}
	}
	return value as Record<string, string[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
