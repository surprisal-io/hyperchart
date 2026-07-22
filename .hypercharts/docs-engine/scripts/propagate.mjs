import { spawnSync } from "node:child_process";
import { checkUnit, emit, readJson, rejectAll } from "./doc-checks.mjs";

// Final sweep across every unit (a rewrite may have edited a file another unit
// links to), then regenerate the packaged views from the canon.

const units = readJson(process.env.UNITS_FILE ?? "").items;
const registry = readJson(process.env.REGISTRY_FILE ?? "");
const violations = Object.values(units).flatMap((unit) => checkUnit(unit, registry));
if (violations.length > 0) rejectAll(violations);

const sync = spawnSync("node", ["scripts/sync-pi-docs.mjs"], { stdio: ["ignore", "inherit", "inherit"] });
if (sync.status !== 0) rejectAll([`sync-pi-docs failed with exit code ${sync.status}`]);
emit("DOCS_SYNCED", { unitCount: Object.keys(units).length });
