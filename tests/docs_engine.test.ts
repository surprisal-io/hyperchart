import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import docsEngineChart from "../.hypercharts/docs-engine/chart.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runDocsScript(name: string, cwd: string, env: Record<string, string>): SpawnSyncReturns<string> {
	return spawnSync(process.execPath, [resolve(`.hypercharts/docs-engine/scripts/${name}`)], {
		cwd,
		env: { ...process.env, ...env },
		encoding: "utf8",
	});
}

function finding(claim: string) {
	return {
		severity: "minor",
		kind: "api-drift",
		locator: claim,
		claim,
		evidence: ["source.ts:1"],
		suggestedFix: `fix ${claim}`,
	};
}

describe("docs-engine batched semantic gate", () => {
	it("keeps the chart's typed reply registry synchronized", () => {
		expect(docsEngineChart.id).toBe("docs-engine");
	});

	it("packs all audit artifacts into exactly three balanced batches", () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-docs-batches-"));
		roots.push(root);
		const artifacts = join(root, "artifacts", "docs-engine");
		mkdirSync(join(artifacts, "findings"), { recursive: true });
		const units = Object.fromEntries(
			["a", "b", "c", "d"].map((id) => [id, { id, path: `docs/${id}.md`, hosts: "both", title: id, bytes: 1 }]),
		);
		const unitsFile = join(artifacts, "units.json");
		writeFileSync(unitsFile, JSON.stringify({ items: units }));
		const files = Object.keys(units).map((id, index) => {
			const path = join(artifacts, "findings", `${id}.json`);
			writeFileSync(path, JSON.stringify({ unitId: id, findings: Array.from({ length: index }, (_, i) => finding(`${id}-${i}`)) }));
			return path;
		});

		const result = runDocsScript("prepare-gate-batches.mjs", root, {
			UNITS_FILE: unitsFile,
			FINDINGS_FILES: JSON.stringify(files),
			BATCH_COUNT: "3",
			GATE_ROUND: "1",
		});
		expect(result.status).toBe(0);
		const event = JSON.parse(result.stdout);
		expect(event.type).toBe("GATE_BATCHES_READY");
		expect(Object.keys(event.output.batches)).toEqual(["batch-1", "batch-2", "batch-3"]);
		expect(event.output.findingCount).toBe(6);
		expect(Object.values(event.output.batches).flatMap((batch: any) => batch.findings).map((entry: any) => entry.id).sort()).toEqual([
			"b:0",
			"c:0",
			"c:1",
			"d:0",
			"d:1",
			"d:2",
		]);
	});

	it("accepts only compact, complete pass/drop/rework decisions", () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-docs-verdict-"));
		roots.push(root);
		const batch = {
			id: "batch-1",
			findings: ["a:0", "b:0", "c:0"].map((id) => ({
				id,
				unitId: id[0],
				unitPath: `docs/${id[0]}.md`,
				findingIndex: 0,
				finding: finding(id),
			})),
		};
		const verdictFile = join(root, "verdict.json");
		writeFileSync(
			verdictFile,
			JSON.stringify({
				batchId: "batch-1",
				decisions: [
					{ id: "a:0", result: "pass" },
					{ id: "b:0", result: "drop" },
					{ id: "c:0", result: "rework", comment: "Cite the exported type." },
				],
			}),
		);
		const valid = runDocsScript("guard-gate-batch.mjs", root, {
			BATCH_JSON: JSON.stringify(batch),
			VERDICT_FILE: verdictFile,
		});
		expect(valid.status).toBe(0);
		expect(JSON.parse(valid.stdout).type).toBe("VERDICT_VALID");

		writeFileSync(
			verdictFile,
			JSON.stringify({ batchId: "batch-1", decisions: [{ id: "a:0", result: "pass" }, { id: "c:0", result: "rework" }] }),
		);
		const invalid = runDocsScript("guard-gate-batch.mjs", root, {
			BATCH_JSON: JSON.stringify(batch),
			VERDICT_FILE: verdictFile,
		});
		expect(invalid.status).toBe(1);
		expect(invalid.stderr).toContain("comment is required for rework");
		expect(invalid.stderr).toContain("finding 'b:0' was not classified");
	});

	it("passes only approved findings to rewrite and routes rework to the owning unit", () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-docs-route-"));
		roots.push(root);
		const artifacts = join(root, "artifacts", "docs-engine");
		mkdirSync(artifacts, { recursive: true });
		const units = {
			a: { id: "a", path: "docs/a.md", hosts: "both", title: "A", bytes: 1 },
			b: { id: "b", path: "docs/b.md", hosts: "both", title: "B", bytes: 1 },
		};
		const unitsFile = join(artifacts, "units.json");
		const batchesFile = join(artifacts, "batches.json");
		const verdictFile = join(artifacts, "verdict.json");
		writeFileSync(unitsFile, JSON.stringify({ items: units }));
		writeFileSync(
			batchesFile,
			JSON.stringify({
				unitIds: ["a", "b"],
				items: {
					"batch-1": {
						id: "batch-1",
						findings: [
							{ id: "a:0", unitId: "a", unitPath: "docs/a.md", findingIndex: 0, finding: finding("keep") },
							{ id: "a:1", unitId: "a", unitPath: "docs/a.md", findingIndex: 1, finding: finding("drop") },
						],
					},
				},
			}),
		);
		writeFileSync(
			verdictFile,
			JSON.stringify({
				batchId: "batch-1",
				decisions: [{ id: "a:0", result: "pass" }, { id: "a:1", result: "drop" }],
			}),
		);

		const approved = runDocsScript("route-gate-batches.mjs", root, {
			UNITS_FILE: unitsFile,
			BATCHES_FILE: batchesFile,
			VERDICT_FILES: JSON.stringify([verdictFile]),
			GATE_ROUND: "1",
			MAX_GATE_ROUNDS: "3",
		});
		expect(JSON.parse(approved.stdout).type).toBe("GATE_APPROVED");

		const routed = runDocsScript("route-findings.mjs", root, {
			MODE: "fix",
			UNITS_FILE: unitsFile,
			GATE_LEDGER_FILE: join(artifacts, "gate-ledger.json"),
		});
		expect(JSON.parse(routed.stdout)).toMatchObject({
			type: "REWRITE_REQUIRED",
			output: { rewriteItems: { a: { findingsCount: 1 } }, totals: { units: 2, dirtyUnits: 1, findings: 1 } },
		});

		writeFileSync(
			verdictFile,
			JSON.stringify({ batchId: "batch-1", decisions: [{ id: "a:0", result: "rework", comment: "Use the exact symbol." }, { id: "a:1", result: "drop" }] }),
		);
		const rework = runDocsScript("route-gate-batches.mjs", root, {
			UNITS_FILE: unitsFile,
			BATCHES_FILE: batchesFile,
			VERDICT_FILES: JSON.stringify([verdictFile]),
			GATE_ROUND: "1",
			MAX_GATE_ROUNDS: "3",
		});
		expect(JSON.parse(rework.stdout)).toMatchObject({
			type: "GATE_REWORK_REQUIRED",
			output: { auditItems: { a: units.a }, feedbackCount: 1 },
		});
		expect(JSON.parse(readFileSync(join(artifacts, "gate-rework.json"), "utf8"))).toMatchObject({
			units: { a: { instructions: ["a:0: Use the exact symbol."] } },
		});
	});
});
