import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { emit, readJson, rejectAll } from "./doc-checks.mjs";

function parsePathArray(name) {
	try {
		const value = JSON.parse(process.env[name] ?? "[]");
		if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error("not an array of paths");
		return value;
	} catch (error) {
		rejectAll([`${name} must be a JSON array of paths: ${error.message}`]);
	}
}

const units = readJson(process.env.UNITS_FILE ?? "").items ?? {};
const batches = readJson(process.env.BATCHES_FILE ?? "");
const verdictFiles = parsePathArray("VERDICT_FILES");
const gateRound = Number.parseInt(process.env.GATE_ROUND ?? "1", 10);
const maxGateRounds = Number.parseInt(process.env.MAX_GATE_ROUNDS ?? "3", 10);
const ledgerPath = "artifacts/docs-engine/gate-ledger.json";
const reworkPath = "artifacts/docs-engine/gate-rework.json";

const ledger = gateRound === 1 || !existsSync(ledgerPath) ? { units: {} } : readJson(ledgerPath);
const refs = Object.values(batches.items ?? {}).flatMap((batch) => batch.findings ?? []);
const decisionById = new Map();
for (const file of verdictFiles) {
	const verdict = readJson(file);
	for (const decision of verdict.decisions ?? []) decisionById.set(decision.id, decision);
}

const rework = { units: {} };
for (const unitId of batches.unitIds ?? []) {
	const unit = units[unitId];
	if (!unit) rejectAll([`Unknown unit '${unitId}' in gate batches`]);
	const unitRefs = refs.filter((ref) => ref.unitId === unitId);
	const decisions = unitRefs.map((ref) => decisionById.get(ref.id));
	if (decisions.some((decision) => !decision)) rejectAll([`Gate decisions are incomplete for unit '${unitId}'`]);
	const reworkDecisions = decisions.filter((decision) => decision.result === "rework");
	if (reworkDecisions.length > 0) {
		delete ledger.units[unitId];
		rework.units[unitId] = {
			unit,
			instructions: reworkDecisions.map((decision) => `${decision.id}: ${decision.comment}`),
		};
		continue;
	}

	const accepted = unitRefs
		.filter((ref) => decisionById.get(ref.id)?.result === "pass")
		.map((ref) => ref.finding);
	const findingsPath = `artifacts/docs-engine/approved-findings/${unitId}.json`;
	mkdirSync(dirname(findingsPath), { recursive: true });
	writeFileSync(findingsPath, `${JSON.stringify({ unitId, findings: accepted }, null, 2)}\n`);
	ledger.units[unitId] = { unitId, findings: accepted, findingsPath, decisions };
}

mkdirSync(dirname(ledgerPath), { recursive: true });
writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
writeFileSync(reworkPath, `${JSON.stringify(rework, null, 2)}\n`);
const feedbackCount = Object.values(rework.units).reduce((total, entry) => total + entry.instructions.length, 0);
const output = {
	auditItems: Object.fromEntries(Object.entries(rework.units).map(([unitId, entry]) => [unitId, entry.unit])),
	feedbackCount,
	approvedUnits: Object.keys(ledger.units).length,
};

if (feedbackCount > 0) {
	if (gateRound >= maxGateRounds) emit("FAILED", output);
	else emit("GATE_REWORK_REQUIRED", output);
} else {
	const missing = Object.keys(units).filter((unitId) => !ledger.units[unitId]);
	if (missing.length > 0) rejectAll([`Gate ledger is missing finalized units: ${missing.join(", ")}`]);
	emit("GATE_APPROVED", output);
}
