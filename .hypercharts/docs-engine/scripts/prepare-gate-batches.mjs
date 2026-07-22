import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { emit, readJson, rejectAll } from "./doc-checks.mjs";

const batchCount = Number.parseInt(process.env.BATCH_COUNT ?? "3", 10);
const gateRound = Number.parseInt(process.env.GATE_ROUND ?? "1", 10);
if (!Number.isInteger(batchCount) || batchCount < 1) rejectAll(["BATCH_COUNT must be a positive integer"]);

let findingFiles;
try {
	findingFiles = JSON.parse(process.env.FINDINGS_FILES ?? "[]");
} catch (error) {
	rejectAll([`FINDINGS_FILES must be a JSON array: ${error.message}`]);
}
if (!Array.isArray(findingFiles) || findingFiles.some((value) => typeof value !== "string")) {
	rejectAll(["FINDINGS_FILES must be a JSON array of paths"]);
}

const units = readJson(process.env.UNITS_FILE ?? "").items ?? {};
const groups = findingFiles.map((path) => {
	const artifact = readJson(path);
	const unit = units[artifact.unitId];
	if (!unit) rejectAll([`Unknown unitId '${artifact.unitId}' in ${path}`]);
	if (!Array.isArray(artifact.findings)) rejectAll([`${path} findings must be an array`]);
	return {
		unitId: artifact.unitId,
		entries: artifact.findings.map((finding, findingIndex) => ({
			id: `${artifact.unitId}:${findingIndex}`,
			unitId: artifact.unitId,
			unitPath: unit.path,
			findingIndex,
			finding,
		})),
	};
});

const buckets = Array.from({ length: batchCount }, (_, index) => ({
	id: `batch-${index + 1}`,
	findings: [],
}));
for (const group of [...groups].sort((left, right) => right.entries.length - left.entries.length)) {
	const bucket = buckets.reduce((best, candidate) =>
		candidate.findings.length < best.findings.length ? candidate : best,
	);
	bucket.findings.push(...group.entries);
}

const items = Object.fromEntries(buckets.map((batch) => [batch.id, batch]));
const output = { items, unitIds: groups.map((group) => group.unitId) };
const outputPath = `artifacts/docs-engine/gate-batches-round-${gateRound}.json`;
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
emit("GATE_BATCHES_READY", {
	batches: items,
	unitIds: output.unitIds,
	batchCount,
	findingCount: groups.reduce((total, group) => total + group.entries.length, 0),
});
