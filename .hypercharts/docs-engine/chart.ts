import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agent, artifact, final, failed, json, map, refs, resume, script, t, z } from "@surprisal/hyperchart";

// docs-engine: keeps the canonical documentation and skills (docs/ and
// skills/) truthful against the code. Package resources are staged only by
// prepack. Modes: `audit` writes a drift report and stops; `fix` also patches
// the canonical units and re-syncs the packages.

const chartDir = dirname(fileURLToPath(import.meta.url));
const file = (path: string) => resolve(chartDir, path);

const Unit = z.object({
	id: z.string(),
	path: z.string(),
	hosts: z.enum(["pi", "claude", "both"]),
	title: z.string(),
	bytes: z.number(),
});
const RewriteUnit = Unit.extend({ findingsPath: z.string(), findingsCount: z.number() });
const Units = z.object({ items: z.record(z.string(), Unit) });
const Registry = z.object({ claude: z.array(z.string()), pi: z.array(z.string()) });
const InventoryReply = Units.extend({ unitCount: z.number(), registry: Registry });
const Finding = z.object({
	severity: z.enum(["info", "minor", "major"]),
	kind: z.enum(["tool-name", "api-drift", "stale-behavior", "broken-link", "inconsistency", "missing-doc"]),
	locator: z.string(),
	claim: z.string(),
	evidence: z.array(z.string()).min(1),
	suggestedFix: z.string(),
});
const Findings = z.object({ unitId: z.string(), findings: z.array(Finding) });
const GateFinding = z.object({
	id: z.string(),
	unitId: z.string(),
	unitPath: z.string(),
	findingIndex: z.number().int().nonnegative(),
	finding: Finding,
});
const GateBatch = z.object({ id: z.string(), findings: z.array(GateFinding) });
const GateBatches = z.object({
	items: z.record(z.string(), GateBatch),
	unitIds: z.array(z.string()),
});
const PrepareGateReply = z.object({
	batches: z.record(z.string(), GateBatch),
	unitIds: z.array(z.string()),
	batchCount: z.number(),
	findingCount: z.number(),
});
const BatchDecision = z.object({
	id: z.string(),
	result: z.enum(["pass", "drop", "rework"]),
	comment: z.string().optional(),
});
const BatchVerdict = z.object({ batchId: z.string(), decisions: z.array(BatchDecision) });
const ApprovedUnit = Findings.extend({
	findingsPath: z.string(),
	decisions: z.array(BatchDecision),
});
const GateLedger = z.object({ units: z.record(z.string(), ApprovedUnit) });
const ReworkUnit = z.object({ unit: Unit, instructions: z.array(z.string()) });
const ReworkManifest = z.object({ units: z.record(z.string(), ReworkUnit) });
const GateRouteReply = z.object({
	auditItems: z.record(z.string(), Unit).optional(),
	feedbackCount: z.number(),
	approvedUnits: z.number(),
});
const Totals = z.object({ units: z.number(), dirtyUnits: z.number(), findings: z.number() });
const RouteReply = z.object({ rewriteItems: z.record(z.string(), RewriteUnit).optional(), totals: Totals });
const GuardReply = z.object({ reason: z.string(), instructions: z.array(z.string()) });
const SyncReply = z.object({ unitCount: z.number() });

type Args = { mode: string };
type Results = {
	"inventory": z.infer<typeof InventoryReply>;
	"prepare-gate": z.infer<typeof PrepareGateReply>;
	"gate-route": z.infer<typeof GateRouteReply>;
	"route": z.infer<typeof RouteReply>;
	"propagate": z.infer<typeof SyncReply>;
};
type Files = {
	"inventory": { units: z.infer<typeof Units>; registry: z.infer<typeof Registry> };
	"audit.review": { findings: z.infer<typeof Findings> };
	"prepare-gate": { batches: z.infer<typeof GateBatches> };
	"gate.review": { verdict: z.infer<typeof BatchVerdict> };
	"gate-route": { ledger: z.infer<typeof GateLedger>; rework: z.infer<typeof ReworkManifest> };
	"route": { report: unknown };
	"rewrite.patch": { unit: unknown };
};
type Maps = {
	"audit": z.infer<typeof Unit>;
	"gate": z.infer<typeof GateBatch>;
	"rewrite": z.infer<typeof RewriteUnit>;
};
type Inputs = {
	"audit": { auditItems: Record<string, z.infer<typeof Unit>> };
	"rewrite": { patchItems: Record<string, z.infer<typeof RewriteUnit>> };
};

const { chart, arg, artifactOf, joinArtifactOf, event, input, item, key, result, visit } = refs<
	Args,
	Results,
	Files,
	Maps,
	Inputs
>();

export default chart({
	kind: "chart",
	id: "docs-engine",
	initial: "inventory",
	states: {
		inventory: {
			kind: "state",
			action: script("node", [file("scripts/inventory.mjs")], {
				artifacts: {
					units: artifact("artifacts/docs-engine/units.json", Units),
					registry: artifact("artifacts/docs-engine/registry.json", Registry),
				},
				reply: InventoryReply,
			}),
			transitions: {
				INVENTORY_READY: { target: "audit", input: { auditItems: event("items") } },
				FAILED: "failed",
			},
		},

		audit: map({
			input: { auditItems: z.record(z.string(), Unit) },
			over: input("auditItems"),
			concurrency: 6,
			initial: "review",
			states: {
				review: {
					kind: "state",
					onReenter: resume(
						t`The semantic gate returned findings in this unit for targeted rework. Read this unit's entry in artifacts/docs-engine/gate-rework.json, preserve supported findings, fix or remove only the challenged findings, update artifacts/docs-engine/findings/${key("audit")}.json, and finish with AUDITED.`,
					),
					action: agent("docs-auditor", {
						task: t`Audit one documentation unit for drift against the code.\n\nUnit: ${json(item("audit"))}\nTool-name registry: ${json(result("inventory", "registry"))}\n\nRead the unit file at its path, verify its checkable claims against the sources, and write the declared findings artifact. An empty findings array is valid. Finish with AUDITED.`,
						reads: [t`${item("audit", "path")}`],
						artifacts: {
							findings: artifact(t`artifacts/docs-engine/findings/${key("audit")}.json`, Findings),
						},
					}),
					validate: script("node", [file("scripts/guard-findings.mjs")], {
						env: {
							FINDINGS_FILE: artifactOf("audit.review"),
							UNIT_JSON: t`${json(item("audit"))}`,
						},
						reply: GuardReply,
					}),
					onReject: "resume",
					retries: 2,
					transitions: { AUDITED: "done" },
				},
				done: final(),
			},
			onDone: "prepare-gate",
			transitions: { FAILED: "failed" },
		}),

		"prepare-gate": {
			kind: "state",
			action: script("node", [file("scripts/prepare-gate-batches.mjs")], {
				env: {
					UNITS_FILE: artifactOf("inventory", { artifact: "units" }),
					FINDINGS_FILES: joinArtifactOf("audit.review"),
					BATCH_COUNT: "3",
					GATE_ROUND: t`${visit("prepare-gate")}`,
				},
				artifacts: {
					batches: artifact(
						t`artifacts/docs-engine/gate-batches-round-${visit("prepare-gate")}.json`,
						GateBatches,
					),
				},
				reply: PrepareGateReply,
			}),
			transitions: { GATE_BATCHES_READY: "gate", FAILED: "failed" },
		},

		gate: map({
			over: result("prepare-gate", "batches"),
			concurrency: 3,
			initial: "review",
			states: {
				review: {
					kind: "state",
					action: agent("docs-findings-gate", {
						task: t`Classify one of three batches after the complete audit.\n\nBatch: ${json(item("gate"))}\nGate round: ${visit("gate.review")} of 3 maximum\n\nFor every finding output only its id, result (pass|drop|rework), and an optional short comment. A rework comment must be a concrete instruction for the original auditor. Do not restate findings or evidence. Write the verdict and finish with CLASSIFIED.`,
						artifacts: {
							verdict: artifact(
								t`artifacts/docs-engine/verdicts/${key("gate")}-visit-${visit("gate.review")}.json`,
								BatchVerdict,
							),
						},
					}),
					validate: script("node", [file("scripts/guard-gate-batch.mjs")], {
						env: {
							BATCH_JSON: t`${json(item("gate"))}`,
							VERDICT_FILE: artifactOf("gate.review", { artifact: "verdict" }),
						},
						reply: GuardReply,
					}),
					onReject: "resume",
					retries: 2,
					transitions: { CLASSIFIED: "done" },
				},
				done: final(),
			},
			onDone: "gate-route",
			transitions: { FAILED: "failed" },
		}),

		"gate-route": {
			kind: "state",
			action: script("node", [file("scripts/route-gate-batches.mjs")], {
				env: {
					UNITS_FILE: artifactOf("inventory", { artifact: "units" }),
					BATCHES_FILE: artifactOf("prepare-gate", { artifact: "batches" }),
					VERDICT_FILES: joinArtifactOf("gate.review", { artifact: "verdict" }),
					GATE_ROUND: t`${visit("gate-route")}`,
					MAX_GATE_ROUNDS: "3",
				},
				artifacts: {
					ledger: artifact("artifacts/docs-engine/gate-ledger.json", GateLedger),
					rework: artifact("artifacts/docs-engine/gate-rework.json", ReworkManifest),
				},
				reply: GateRouteReply,
			}),
			transitions: {
				GATE_APPROVED: "route",
				GATE_REWORK_REQUIRED: { target: "audit", input: { auditItems: event("auditItems") } },
				FAILED: "failed",
			},
		},

		route: {
			kind: "state",
			action: script("node", [file("scripts/route-findings.mjs")], {
				env: {
					MODE: t`${arg("mode")}`,
					UNITS_FILE: artifactOf("inventory", { artifact: "units" }),
					GATE_LEDGER_FILE: artifactOf("gate-route", { artifact: "ledger" }),
				},
				artifacts: { report: artifact("artifacts/docs-engine/drift-report.json") },
				reply: RouteReply,
			}),
			transitions: {
				DRIFT_REPORTED: "done",
				DOCS_CLEAN: "propagate",
				REWRITE_REQUIRED: { target: "rewrite", input: { patchItems: event("rewriteItems") } },
				FAILED: "failed",
			},
		},

		rewrite: map({
			input: { patchItems: z.record(z.string(), RewriteUnit) },
			over: input("patchItems"),
			concurrency: 4,
			initial: "patch",
			states: {
				patch: {
					kind: "state",
					onReenter: resume(
						"Address the guard's violation list with further surgical edits; keep every fix that was already accepted.",
					),
					action: agent("docs-writer", {
						task: t`Apply the audit findings to one canonical documentation unit.\n\nUnit: ${json(item("rewrite"))}\n\nRead the unit file and the findings artifact at findingsPath, apply each correction surgically, and keep the unit's structure and frontmatter intact. Edit only the canonical unit file. Finish with PATCHED.`,
						reads: [t`${item("rewrite", "path")}`, t`${item("rewrite", "findingsPath")}`],
						artifacts: { unit: artifact(t`${item("rewrite", "path")}`) },
					}),
					validate: script("node", [file("scripts/guard-unit.mjs")], {
						env: {
							UNIT_JSON: t`${json(item("rewrite"))}`,
							REGISTRY_FILE: artifactOf("inventory", { artifact: "registry" }),
						},
						reply: GuardReply,
					}),
					onReject: "resume",
					retries: 2,
					transitions: { PATCHED: "done" },
				},
				done: final(),
			},
			onDone: "propagate",
			transitions: { FAILED: "failed" },
		}),

		propagate: {
			kind: "state",
			action: script("node", [file("scripts/propagate.mjs")], {
				env: {
					UNITS_FILE: artifactOf("inventory", { artifact: "units" }),
					REGISTRY_FILE: artifactOf("inventory", { artifact: "registry" }),
				},
				reply: SyncReply,
			}),
			transitions: { DOCS_SYNCED: "done", FAILED: "failed" },
		},

		done: final(),
		failed: failed(),
	},
});
