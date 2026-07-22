import { emit, readJson, rejectAll } from "./doc-checks.mjs";

// Validates one audit findings artifact: shape, identity, and that every
// finding is anchored to the unit with concrete evidence. Reports every
// violation at once so the auditor can fix the artifact in one pass.

const SEVERITIES = new Set(["info", "minor", "major"]);
const KINDS = new Set(["tool-name", "api-drift", "stale-behavior", "broken-link", "inconsistency", "missing-doc"]);

const unit = JSON.parse(process.env.UNIT_JSON ?? "{}");
let findings;
try {
	findings = readJson(process.env.FINDINGS_FILE ?? "");
} catch (error) {
	rejectAll([`Cannot read findings artifact: ${error.message}`]);
}

const violations = [];
if (findings.unitId !== unit.id) violations.push(`unitId must be '${unit.id}' (was '${findings.unitId}')`);
if (!Array.isArray(findings.findings)) violations.push("findings must be an array (use [] when the unit is clean)");
for (const [index, finding] of (findings.findings ?? []).entries()) {
	const at = `findings[${index}]`;
	if (!SEVERITIES.has(finding.severity)) violations.push(`${at}.severity must be one of ${[...SEVERITIES].join("|")}`);
	if (!KINDS.has(finding.kind)) violations.push(`${at}.kind must be one of ${[...KINDS].join("|")}`);
	if (typeof finding.locator !== "string" || finding.locator.trim() === "")
		violations.push(`${at}.locator must quote the drifted heading or sentence from the unit`);
	if (typeof finding.claim !== "string" || finding.claim.trim() === "")
		violations.push(`${at}.claim must state what the doc says`);
	if (!Array.isArray(finding.evidence) || finding.evidence.length === 0)
		violations.push(`${at}.evidence must list the source files that contradict the claim`);
	if (typeof finding.suggestedFix !== "string" || finding.suggestedFix.trim() === "")
		violations.push(`${at}.suggestedFix must describe the correction`);
}
if (violations.length > 0) rejectAll(violations);
emit("FINDINGS_VALID", { reason: "", instructions: [] });
