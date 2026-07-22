import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { emit, readJson, rejectAll } from "./doc-checks.mjs";

const mode = process.env.MODE ?? "audit";
const units = readJson(process.env.UNITS_FILE ?? "").items ?? {};
const ledger = readJson(process.env.GATE_LEDGER_FILE ?? "").units ?? {};
const missing = Object.keys(units).filter((unitId) => !ledger[unitId]);
if (missing.length > 0) rejectAll([`Gate ledger is missing units: ${missing.join(", ")}`]);

const report = { mode, totals: { units: Object.keys(units).length, dirtyUnits: 0, findings: 0 }, units: {} };
const dirty = {};
for (const [unitId, unit] of Object.entries(units)) {
	const approved = ledger[unitId];
	const findings = approved.findings ?? [];
	report.units[unitId] = { path: unit.path, findings, decisions: approved.decisions ?? [] };
	if (findings.length === 0) continue;
	report.totals.dirtyUnits += 1;
	report.totals.findings += findings.length;
	dirty[unitId] = {
		...unit,
		findingsPath: approved.findingsPath,
		findingsCount: findings.length,
	};
}

const reportPath = "artifacts/docs-engine/drift-report.json";
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (mode !== "fix") emit("DRIFT_REPORTED", { totals: report.totals });
else if (report.totals.dirtyUnits === 0) emit("DOCS_CLEAN", { totals: report.totals });
else emit("REWRITE_REQUIRED", { rewriteItems: dirty, totals: report.totals });
