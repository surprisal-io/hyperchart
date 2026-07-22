import { writeFileSync } from "node:fs";
import { emit, readJson } from "./doc-checks.mjs";

// Merges per-unit findings into the drift report and decides whether the run
// stops at the report (audit mode / clean tree) or continues into rewrites.

const mode = process.env.MODE === "fix" ? "fix" : "audit";
const units = readJson(process.env.UNITS_FILE ?? "").items;
const findingsFiles = (process.env.FINDINGS_FILES ?? "").split("\n").filter((line) => line.trim() !== "");

const report = { mode, units: {}, totals: { units: Object.keys(units).length, dirtyUnits: 0, findings: 0 } };
const rewriteItems = {};
for (const file of findingsFiles) {
	const { unitId, findings } = readJson(file);
	report.units[unitId] = { path: units[unitId]?.path, findings };
	if (findings.length === 0) continue;
	report.totals.dirtyUnits += 1;
	report.totals.findings += findings.length;
	const unit = units[unitId];
	rewriteItems[unitId] = { ...unit, findingsPath: file, findingsCount: findings.length };
}

writeFileSync("artifacts/docs-engine/drift-report.json", `${JSON.stringify(report, null, 2)}\n`);

if (mode === "fix" && report.totals.findings > 0) {
	emit("REWRITE_REQUIRED", { items: rewriteItems, totals: report.totals });
} else if (mode === "fix") {
	emit("DOCS_CLEAN", { totals: report.totals });
} else {
	emit("DRIFT_REPORTED", { totals: report.totals });
}
