import { emit, readJson, rejectAll } from "./doc-checks.mjs";

const batch = JSON.parse(process.env.BATCH_JSON ?? "{}");
let verdict;
try {
	verdict = readJson(process.env.VERDICT_FILE ?? "");
} catch (error) {
	rejectAll([`Cannot read gate verdict: ${error.message}`]);
}

const violations = [];
const findings = Array.isArray(batch.findings) ? batch.findings : [];
const expectedIds = new Set(findings.map((finding) => finding.id));
const decisions = Array.isArray(verdict.decisions) ? verdict.decisions : [];
if (verdict.batchId !== batch.id) violations.push(`batchId must be '${batch.id}'`);
if (!Array.isArray(verdict.decisions)) violations.push("decisions must be an array");

const seen = new Set();
for (const [index, decision] of decisions.entries()) {
	const at = `decisions[${index}]`;
	if (!expectedIds.has(decision.id)) violations.push(`${at}.id '${decision.id}' is not in this batch`);
	if (seen.has(decision.id)) violations.push(`${at}.id '${decision.id}' is duplicated`);
	seen.add(decision.id);
	if (!["pass", "drop", "rework"].includes(decision.result))
		violations.push(`${at}.result must be pass|drop|rework`);
	if (decision.result === "rework" && (typeof decision.comment !== "string" || decision.comment.trim() === ""))
		violations.push(`${at}.comment is required for rework`);
}
for (const id of expectedIds) {
	if (!seen.has(id)) violations.push(`finding '${id}' was not classified`);
}
if (violations.length > 0) rejectAll(violations);
emit("VERDICT_VALID", { reason: "", instructions: [] });
