import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const SKILL_SIZE_LIMIT = 16000;

// Deterministic per-unit checks shared by the rewrite guard and the final
// sweep. Returns every violation, never just the first one.
export function checkUnit(unit, registry) {
	const violations = [];
	if (!existsSync(unit.path)) return [`${unit.path} does not exist`];
	const text = readFileSync(unit.path, "utf8");
	if (text.trim().length === 0) violations.push(`${unit.path} is empty`);

	const allowed = allowedToolNames(unit.hosts, registry);
	// Match concrete tool names only (hyperchart_run, ...); the bare project
	// word, the hypercharts directory, and hyperchart_* globs are not tools.
	for (const name of new Set(text.match(/hyperchart_[a-z][a-z_]*/g) ?? [])) {
		if (!allowed.has(name)) {
			violations.push(
				`${unit.path} mentions tool '${name}' which does not exist for hosts '${unit.hosts}' (known: ${[...allowed].sort().join(", ")})`,
			);
		}
	}

	for (const match of text.matchAll(/\]\((\.\.?\/[^)#\s]+)(?:#[^)\s]*)?\)/g)) {
		const target = resolve(dirname(unit.path), match[1]);
		if (!existsSync(target)) violations.push(`${unit.path} has a broken relative link: ${match[1]}`);
	}

	if (unit.path.includes("docs/skills/")) {
		if (!text.startsWith("---\n")) violations.push(`${unit.path} must start with YAML frontmatter`);
		if (text.length > SKILL_SIZE_LIMIT)
			violations.push(`${unit.path} exceeds the skill size budget: ${text.length} > ${SKILL_SIZE_LIMIT} chars`);
	}
	return violations;
}

// Tool tokens are prefixes of each other (`hyperchart` vs `hyperchart_run`),
// so the regex above already captures maximal tokens; membership is exact.
export function allowedToolNames(hosts, registry) {
	if (hosts === "pi") return new Set(registry.pi);
	if (hosts === "claude") return new Set(registry.claude);
	return new Set([...registry.pi, ...registry.claude]);
}

export function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

export function emit(type, output) {
	process.stdout.write(`${JSON.stringify({ type, output })}\n`);
}

export function rejectAll(violations) {
	process.stderr.write(`${violations.join("\n")}\n`);
	process.exit(1);
}
