import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agent, artifact, final, json, map, refs, resume, script, t, z } from "@surprisal/hyperchart";

// docs-engine: keeps the canonical documentation (docs/, including
// docs/skills/) truthful against the code, then regenerates the packaged
// views. Modes: `audit` writes a drift report and stops; `fix` also patches
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
const Totals = z.object({ units: z.number(), dirtyUnits: z.number(), findings: z.number() });
const RouteReply = z.object({ items: z.record(z.string(), RewriteUnit).optional(), totals: Totals });
const GuardReply = z.object({ reason: z.string(), instructions: z.array(z.string()) });
const SyncReply = z.object({ unitCount: z.number() });

type Args = { mode: string };
type Results = {
	"inventory": z.infer<typeof InventoryReply>;
	"route": z.infer<typeof RouteReply>;
	"propagate": z.infer<typeof SyncReply>;
};
type Files = {
	"inventory": { units: z.infer<typeof Units>; registry: z.infer<typeof Registry> };
	"audit.review": { findings: z.infer<typeof Findings> };
	"route": { report: unknown };
	"rewrite.patch": { unit: unknown };
};
type Maps = {
	"audit": z.infer<typeof Unit>;
	"rewrite": z.infer<typeof RewriteUnit>;
};
type Inputs = {
	"rewrite": { items: Record<string, z.infer<typeof RewriteUnit>> };
};

const { chart, arg, artifactOf, joinArtifactOf, event, input, item, key, result } = refs<Args, Results, Files, Maps, Inputs>();

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
					transitions: { INVENTORY_READY: "audit" },
				},

				audit: map({
					over: result("inventory", "items"),
					concurrency: 6,
					initial: "review",
					states: {
						review: {
							kind: "state",
							onReenter: resume(
								"Fix the findings artifact so it satisfies the guard's violation list; do not restart the audit from scratch.",
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
					onDone: "route",
					transitions: { FAILED: "failed" },
				}),

				route: {
					kind: "state",
					action: script("node", [file("scripts/route-findings.mjs")], {
						env: {
							MODE: t`${arg("mode")}`,
							UNITS_FILE: artifactOf("inventory", { artifact: "units" }),
							FINDINGS_FILES: joinArtifactOf("audit.review"),
						},
						artifacts: { report: artifact("artifacts/docs-engine/drift-report.json") },
						reply: RouteReply,
					}),
					transitions: {
						DRIFT_REPORTED: "done",
						DOCS_CLEAN: "propagate",
						REWRITE_REQUIRED: { target: "rewrite", input: { items: event("items") } },
					},
				},

				rewrite: map({
					input: { items: z.record(z.string(), RewriteUnit) },
					over: input("items"),
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
					transitions: { DOCS_SYNCED: "done" },
				},

		done: final(),
		failed: final(),
	},
});
