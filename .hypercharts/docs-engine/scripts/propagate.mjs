import { checkUnit, emit, readJson, rejectAll } from "./doc-checks.mjs";

// Final sweep across every canonical unit (a rewrite may have edited a file
// another unit links to). Package resources are staged only during prepack.

const units = readJson(process.env.UNITS_FILE ?? "").items;
const registry = readJson(process.env.REGISTRY_FILE ?? "");
const violations = Object.values(units).flatMap((unit) => checkUnit(unit, registry));
if (violations.length > 0) rejectAll(violations);

emit("DOCS_SYNCED", { unitCount: Object.keys(units).length });
