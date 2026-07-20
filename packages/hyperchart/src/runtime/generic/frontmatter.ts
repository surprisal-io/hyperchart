export type ParsedFrontmatter = {
	frontmatter: Record<string, unknown>;
	body: string;
};

export type FrontmatterParser = (content: string) => ParsedFrontmatter;

/**
 * Minimal YAML-frontmatter parser covering the agent-definition schema: string
 * scalars, quoted strings, inline arrays, booleans, and numbers. Hosts with a
 * richer parser can inject their own; unknown shapes stay raw strings.
 */
export function parseSimpleFrontmatter(content: string): ParsedFrontmatter {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
	if (match === null) return { frontmatter: {}, body: content };
	const frontmatter: Record<string, unknown> = {};
	for (const line of match[1]?.split(/\r?\n/) ?? []) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
		const separator = trimmed.indexOf(":");
		if (separator <= 0) continue;
		const key = trimmed.slice(0, separator).trim();
		const value = trimmed.slice(separator + 1).trim();
		if (key.length === 0) continue;
		frontmatter[key] = parseScalar(value);
	}
	return { frontmatter, body: content.slice(match[0].length) };
}

function parseScalar(value: string): unknown {
	if (value.length === 0) return "";
	if (value.startsWith("[") && value.endsWith("]")) {
		const inner = value.slice(1, -1).trim();
		if (inner.length === 0) return [];
		return inner.split(",").map((entry) => unquote(entry.trim()));
	}
	if (value === "true") return true;
	if (value === "false") return false;
	if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
	return unquote(value);
}

function unquote(value: string): string {
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
		return value.slice(1, -1);
	}
	return value;
}
