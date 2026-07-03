// The pi-taskflow "deck-director" flow (interactive HTML report generation) expressed as a
// hyperchart. Same semantics: plan → bucketed research → coverage gate → claims → narrative
// (+design gate) → chapters → interactions (+consistency gate) → assemble (+quarto gate) →
// render.
//
// Agent actions mirror the pi-subagents invocation surface: the name points at the markdown
// definition (identity, description, system prompt, default model/tools/thinking — NOT repeated
// here; the chart only overrides what differs). `task` is this call's assignment; artifacts flow
// through the typed file channel: the producer declares `output: file(path, shape)`, consumers
// read it as `artifactOf(producer)` — path and content shape come from the declaration and cannot
// drift. The step's RESULT is the completion event's payload (`reply`) — small routing data.
//
// Fan-out is a map: instances spawn from run data pinned by a spawned fact (`research#press`),
// key()/item() are the instance's args, and joinArtifactOf() fans the instances' artifacts back
// in — one file per instance for agents, a JSON array of paths for scripts.

import { agent, artifact, final, json, map, refs, script, t, z } from "../src/index.js";

// TS-first, one source, one file: shapes are zod values (z re-exported by the library — charts
// need no extra dependency) passed DIRECTLY into reply/artifact declarations. The TS types are
// inferred from the same values; normalize converts them to plain JSON Schema in the AST, so the
// chart stays serializable data while the agent gets an exact description of what to produce.
type Args = { topic: string; audience: string; goal: string; style: string; constraints: string };

// plan's event payload: the small routing data every later step builds its paths from.
const Plan = z.object({
	artifacts_dir: z.string(),
	buckets: z.record(
		z.string(),
		z.object({ queries: z.array(z.string()), purpose: z.string(), required_sources: z.number() }),
	),
	coverage_thresholds: z.record(z.string(), z.number()),
});
type Plan = z.infer<typeof Plan>;

// File contents of every artifact in the flow — fully specified, no unknowns: the same values
// type the registry below, instruct the producing agent and validate the written files.
const Research = z.object({
	records: z.array(z.object({ url: z.string(), title: z.string(), summary: z.string(), facts: z.array(z.string()) })),
});
type Research = z.infer<typeof Research>;

const Evidence = z.object({
	facts: z.array(z.object({ id: z.string(), fact: z.string(), source: z.string() })),
});
type Evidence = z.infer<typeof Evidence>;

const Claims = z.object({
	claims: z.array(z.object({ id: z.string(), claim: z.string(), evidence_ids: z.array(z.string()) })),
});
type Claims = z.infer<typeof Claims>;

const Narrative = z.object({
	title: z.string(),
	thesis: z.string(),
	sections: z.array(z.object({ id: z.string(), title: z.string(), role: z.string() })),
});
type Narrative = z.infer<typeof Narrative>;

// narrative's event payload: the chapter WORK ITEMS the authoring map fans out over.
const Chapters = z.object({
	chapters: z.array(z.object({ chapter_id: z.string(), title: z.string(), summary: z.string() })),
});
type Chapters = z.infer<typeof Chapters>;

// One authored chapter package — the per-instance artifact of the chapters map.
const Chapter = z.object({ chapter_id: z.string(), title: z.string(), prose: z.string() });
type Chapter = z.infer<typeof Chapter>;

const Interactions = z.object({
	interactions: z.array(z.object({ id: z.string(), type: z.string(), behavior: z.string() })),
});
type Interactions = z.infer<typeof Interactions>;

// The Quarto source is text, and that is its honest shape.
const ReportSource = z.string();

const { arg, result, artifactOf, joinArtifactOf, key, item, chart } = refs<
	Args,
	{ plan: Plan; narrative: Chapters },
	{
		// state → artifact name → content type, computed-checked against the chart below.
		// Map instances are registered by their TEMPLATE path: one entry covers every instance.
		"research.scout": { research: Research };
		normalize: { evidence: Evidence };
		claims: { claims: Claims };
		narrative: { plan: Narrative };
		"chapters.author": { chapter: Chapter };
		interactions: { interactions: Interactions };
		assemble: { report: string };
	},
	{
		// map → item type, verified against each map's `over`: key()/item() are the instance's
		// typed args.
		research: Plan["buckets"][string];
		chapters: Chapters["chapters"][number];
	}
>();

// chart came from refs<...>(): the literal below is CHECKED against the registry above — a
// renamed state, a dropped reply or a mismatched artifact name is a compile error right here.
export default chart({
	kind: "chart",
	id: "deck-director",
	initial: "plan",
	states: {
		// taskflow: report-plan — decides buckets, thresholds, angles.
		plan: {
			kind: "state",
			action: agent("deck-html-planner", {
				task: t`Plan an article-first interactive analytical HTML report.
Request: ${arg("topic")}
Audience: ${arg("audience")}
Goal: ${arg("goal")}
Style: ${arg("style")}
Constraints: ${arg("constraints")}`,
				reply: Plan,
			}),
			transitions: { PLAN_READY: "research", FAILED: "failed" },
		},

		// taskflow: source-scout map over research_buckets. One instance per bucket the PLANNER
		// decided on — the spawned fact pins the bucket set, key()/item() are this instance's args.
		research: map({
			over: result("plan", "buckets"),
			initial: "scout",
			onDone: "normalize",
			states: {
				scout: {
					kind: "state",
					action: agent("deck-source-scout", {
						task: t`Bucketed research pass for the report on ${arg("topic")}.
Your bucket (${key("research")}): ${json(item("research"))}`,
						artifacts: {
							research: artifact(t`${result("plan", "artifacts_dir")}/research-${key("research")}.json`, Research),
						},
					}),
					transitions: { SCOUTED: "done" },
				},
				done: final(),
			},
			transitions: { FAILED: "failed" },
		}),

		// taskflow: normalize-evidence + cluster-dedupe + evidence-coverage-gate — an honest
		// command step: same channels as an agent, parameters through rendered env vars.
		normalize: {
			kind: "state",
			action: script("python3", ["bin/normalize_evidence.py"], {
				env: {
					ARTIFACTS_DIR: t`${result("plan", "artifacts_dir")}`,
					COVERAGE_THRESHOLDS: t`${json(result("plan", "coverage_thresholds"))}`,
					// the fan-in: every scout instance's file, a JSON array of paths in spawn order
					RESEARCH_FILES: joinArtifactOf("research.scout"),
				},
				artifacts: { evidence: artifact(t`${result("plan", "artifacts_dir")}/evidence.json`, Evidence) },
			}),
			// The coverage gate: verdict is stored in the log as a validated fact; onReject=restart
			// is taskflow's onBlock:retry, retries: 2 its retry.max — the third rejection is FAILED.
			validate: script("python3", ["bin/check_coverage.py"]),
			onReject: "restart",
			retries: 2,
			transitions: { NORMALIZED: "claims", FAILED: "failed" },
		},

		// taskflow: build-context-claims + claim-builder + build-evidence-map.
		claims: {
			kind: "state",
			action: agent("deck-claim-builder", {
				task: t`Build internal narrative claims — the argument skeleton, not reader-facing cards.`,
				// not the whole evidence file — just its facts, typed against Evidence via Files
				reads: [artifactOf("normalize", { select: "facts" })],
				artifacts: { claims: artifact(t`${result("plan", "artifacts_dir")}/claims.json`, Claims) },
			}),
			transitions: { CLAIMS_READY: "narrative", FAILED: "failed" },
		},

		// taskflow: narrative-synthesizer + materialize-outline + narrative-design-gate. The reply
		// is the chapter work-item list — routing data the chapters map fans out over; the full
		// narrative plan stays in the artifact.
		narrative: {
			kind: "state",
			action: agent("deck-narrative-synthesizer", {
				task: t`Synthesize the claims into an argument-led narrative plan for ${arg("audience")}.`,
				reads: [artifactOf("claims")],
				artifacts: { plan: artifact(t`${result("plan", "artifacts_dir")}/narrative-plan.json`, Narrative) },
				reply: Chapters,
				// the one frontmatter override in this chart: synthesis wants deeper thinking
				thinking: "xhigh",
			}),
			validate: script("python3", ["bin/check_narrative_design.py"]),
			onReject: "restart",
			retries: 2,
			transitions: { NARRATIVE_READY: "chapters", FAILED: "failed" },
		},

		// taskflow: chapter-authoring map over work items. Items come from narrative's reply (an
		// array → instance keys are its indexes); at most two authors run at once.
		chapters: map({
			over: result("narrative", "chapters"),
			concurrency: 2,
			initial: "author",
			onDone: "interactions",
			states: {
				author: {
					kind: "state",
					action: agent("deck-chapter-author", {
						task: t`Author one chapter package: narrative-first prose with inline [source:<id>] citations.
Your work item: ${json(item("chapters"))}`,
						reads: [artifactOf("narrative"), artifactOf("claims")],
						artifacts: {
							chapter: artifact(t`${result("plan", "artifacts_dir")}/chapter-${key("chapters")}.json`, Chapter),
						},
					}),
					transitions: { AUTHORED: "written" },
				},
				written: final(),
			},
			transitions: { FAILED: "failed" },
		}),

		// taskflow: interaction-designer + validate-draft + final-consistency-gate.
		interactions: {
			kind: "state",
			action: agent("deck-interaction-designer", {
				task: t`Specify reader-friendly interactive components that clarify the argument.`,
				// the agent-side fan-in: one chapter file per map instance
				reads: [joinArtifactOf("chapters.author")],
				artifacts: { interactions: artifact(t`${result("plan", "artifacts_dir")}/interactions.json`, Interactions) },
			}),
			validate: script("python3", ["bin/validate_report_data.py"]),
			onReject: "restart",
			retries: 2,
			transitions: { INTERACTIONS_READY: "assemble", FAILED: "failed" },
		},

		// taskflow: assemble-report-data + emit-quarto-source + check + quarto-source-gate.
		assemble: {
			kind: "state",
			action: script("python3", ["bin/assemble_report_data.py"], {
				env: {
					ARTIFACTS_DIR: t`${result("plan", "artifacts_dir")}`,
					REPORT_TOPIC: t`${arg("topic")}`,
					REPORT_GOAL: t`${arg("goal")}`,
					CHAPTER_FILES: joinArtifactOf("chapters.author"),
					INTERACTIONS_JSON: artifactOf("interactions"),
				},
				artifacts: { report: artifact(t`${result("plan", "artifacts_dir")}/report.qmd`, ReportSource) },
			}),
			validate: script("python3", ["bin/check_quarto_source.py"]),
			onReject: "restart",
			retries: 2,
			transitions: { ASSEMBLED: "render", FAILED: "failed" },
		},

		// taskflow: render-html (quarto in docker), timeoutMs → after-deadline.
		render: {
			kind: "state",
			action: script("python3", ["bin/render_quarto_report.py"], {
				env: { REPORT_QMD: artifactOf("assemble") },
			}),
			after: { delayMs: 120_000, target: "failed" },
			transitions: { RENDERED: "done", FAILED: "failed" },
		},

		done: final(),
		failed: final(),
	},
});
