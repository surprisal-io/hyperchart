import { checkUnit, emit, readJson, rejectAll } from "./doc-checks.mjs";

// Validates one rewritten canonical unit: exists, tool names match the host
// registries, relative links resolve, skill files keep frontmatter and budget.

const unit = JSON.parse(process.env.UNIT_JSON ?? "{}");
const registry = readJson(process.env.REGISTRY_FILE ?? "");
const violations = checkUnit(unit, registry);
if (violations.length > 0) rejectAll(violations);
emit("UNIT_VALID", { reason: "", instructions: [] });
