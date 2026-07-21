import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SETTINGS_FILE_NAME = "settings.json";

/**
 * Merge role -> model maps from `settings.json` files inside the given charts
 * directories, in scope order: later directories win per role key (pass user
 * scope first, project scope last). A missing file contributes nothing; a
 * malformed one fails loudly so a typo never silently drops the mapping.
 */
export function loadModelRoles(chartsDirs: readonly string[]): Record<string, string> {
	const roles: Record<string, string> = {};
	for (const dir of chartsDirs) {
		Object.assign(roles, readSettingsRoles(join(dir, SETTINGS_FILE_NAME)));
	}
	return roles;
}

function readSettingsRoles(path: string): Record<string, string> {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return {};
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
	if (parsed.roles === undefined) return {};
	if (!isRecord(parsed.roles)) throw new Error(`Invalid hypercharts settings at ${path}: 'roles' must be an object`);
	for (const [role, model] of Object.entries(parsed.roles)) {
		if (typeof model !== "string" || model.trim() === "") {
			throw new Error(`Invalid hypercharts settings at ${path}: role '${role}' must map to a model string`);
		}
	}
	return parsed.roles as Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
