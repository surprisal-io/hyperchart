import { z } from "zod";
import {
	agent,
	artifact,
	artifactOf,
	chart,
	compound,
	event,
	final, failed,
	input,
	joinArtifactOf,
	json,
	key,
	map,
	parallel,
	result,
	resume,
	script,
	t,
	tsImport,
	user,
	visit,
} from "../../../core/dsl.js";
import { templatePath } from "../../../core/paths.js";
import type { ActionUID, ChartAst, ChartCst, ChartEvent, StateAst, StatePath } from "../../../core/types.js";
import type { ArtifactPin, DurableLogRecord } from "../../../core/durable_events.js";
import type { HyperchartRuntimeSessionProgressFile } from "../../../host/index.js";
import type { HyperchartRunStatus } from "../../types.js";
import {
	actorInspectorChart,
	actorInspectorRecords,
	mailboxReentryChart,
	mailboxReentryRecords,
} from "../../fixtures/actor-runtime-fixtures.js";
import { actorPoolChart, actorPoolCrowdedChart, actorPoolCrowdedRecords, actorSelfChart } from "../../fixtures/actor-fixtures.js";

export type InspectorPanelRuntime = {
	selectedStateId: StatePath | null;
	mode?: "static" | "run";
	run?: {
		status?: HyperchartRunStatus;
		args?: Record<string, unknown>;
		statusError?: string;
		exitCode?: number;
		replayWarnings?: string[];
	};
	records?: (ast: ChartAst) => DurableLogRecord[];
	sessionProgress?: (ast: ChartAst) => HyperchartRuntimeSessionProgressFile;
};

export type InspectorPanelGroupId = "overview" | "agent" | "actors" | "user" | "script" | "map" | "parallel" | "compound" | "final";

export type InspectorPanelSpecInput = {
	group: InspectorPanelGroupId;
	title: string;
	description: string;
	/** Include only when the graph node itself is a distinct visual state. */
	graphAtlas?: boolean;
	chart: ChartCst;
	runtime: InspectorPanelRuntime;
};

export type InspectorPanelSpec = InspectorPanelSpecInput;

export const inspectorPanelGroups: Array<{ id: InspectorPanelGroupId; title: string; description: string; storyId: string }> =
	[
		{
			id: "overview",
			title: "Overview",
			description: "No selected node: run-level arguments, activity, metadata, and chart definition.",
			storyId: "hyperchart-visual-tests-inspector-panel--overview",
		},
		{
			id: "agent",
			title: "Agent states",
			description: "Agent nodes: minimal, rich prompt, refs/re-entry, and validation guard variants.",
			storyId: "hyperchart-visual-tests-inspector-panel--agent-states",
		},
		{
			id: "actors",
			title: "Actors",
			description: "Actor declarations, occurrences and mailboxes, protocols, receive states, internal actions, and replies.",
			storyId: "hyperchart-visual-tests-inspector-panel--actor-states",
		},
		{
			id: "user",
			title: "User states",
			description: "User-input states and their prompt/transition details.",
			storyId: "hyperchart-visual-tests-inspector-panel--user-states",
		},
		{
			id: "script",
			title: "Script states",
			description: "Script command arguments, env values, contracts, and skipped state.",
			storyId: "hyperchart-visual-tests-inspector-panel--script-states",
		},
		{
			id: "map",
			title: "Map states",
			description: "Map parent status plus mapped item worker details.",
			storyId: "hyperchart-visual-tests-inspector-panel--map-states",
		},
		{
			id: "parallel",
			title: "Parallel states",
			description: "Parallel fan-out state with branch progress/status.",
			storyId: "hyperchart-visual-tests-inspector-panel--parallel-states",
		},
		{
			id: "compound",
			title: "Compound states",
			description: "Compound scope state with nested agents/contracts, including branch scopes inside parallel.",
			storyId: "hyperchart-visual-tests-inspector-panel--compound-states",
		},
		{
			id: "final",
			title: "Final states",
			description: "Terminal state details.",
			storyId: "hyperchart-visual-tests-inspector-panel--final-states",
		},
	];

const longPrompt = [
	"Write a detailed implementation note for the selected change.",
	"",
	"Cover the user-visible behavior first.",
	"List every touched file with one short reason per file.",
	"Explain how the empty states should behave in the inspector panel.",
	"Call out when a section should not render at all.",
	"Describe when Open full appears for truncated text blocks.",
	"Keep the preview clean by rendering only the bounded excerpt.",
	"Mount the complete text only after Open full is selected.",
	"Finish with the exact verification commands that passed.",
].join("\n");

const sectionMapSchema = z.record(z.string(), z.object({ title: z.string(), summary: z.string().optional() }));
const writerReplySchema = z.object({
	draft: z.string(),
	review: z.object({
		risks: z.array(z.string()),
		evidence: z.array(z.object({ file: z.string(), line: z.number().int() })),
		score: z.number(),
	}),
}).strict();
const renderReplySchema = z.object({
	ok: z.boolean(),
	url: z.string().optional(),
	sections: sectionMapSchema.optional(),
});
const reportDataSchema = z.object({ title: z.string(), sections: z.array(z.string()) });
const richAgentContextSchema = z.object({
	title: z.string().describe("Document title."),
	risks: z.array(z.string()).describe("Known implementation risks."),
	testCommands: z.array(z.string()).describe("Commands that verify the change."),
}).describe("Implementation context the writer must read before starting.");
const richAgentConventionsSchema = z.object({
	style: z.enum(["concise", "detailed"]),
	requiredSections: z.array(z.string()),
}).describe("Writing conventions for the implementation note.");
const richAgentNoteSchema = z.object({
	summary: z.string(),
	risks: z.array(z.string()),
	verification: z.array(z.object({ command: z.string(), expected: z.string() })),
}).describe("Structured implementation note produced by the writer.");
const richAgentSourceBriefSchema = z.object({
	source: z.string(),
	findings: z.array(z.string()),
}).describe("One source brief produced by a map instance.");
const scopedPlanSchema = z.object({ next: z.string().optional() });

function panelChart(id: string, initial: string, states: ChartCst["states"]): ChartCst {
	return chart({ kind: "chart", id, initial, states });
}

function reviewerRegion(agentName: string, task: string): ReturnType<typeof compound> {
	return compound({
		initial: "review",
		states: {
			review: { kind: "state", action: agent(agentName, { task }), transitions: { DONE: "done", ERROR: "failed" } },
			done: final(),
			failed: failed(),
		},
	});
}

const mapReviewChart = panelChart("inspector-map-review", "script-contracts", {
	"script-contracts": {
		kind: "state",
		action: script("node", ["scripts/render-report.mjs"], { reply: z.object({ sections: sectionMapSchema }) }),
		transitions: { RENDERED: "map-review", ERROR: "failed" },
	},
	"map-review": map({
		over: result("script-contracts", "sections"),
		concurrency: 3,
		initial: "risk-write",
		onDone: "parallel-review",
		states: {
			"risk-write": {
				kind: "state",
				action: agent("chapter-author", {
					task: t`Rewrite the section for ${input("sectionLabel")} after ${visit("map-review.risk-write")} visits.`,
					artifacts: { draft: "artifacts/risk.md" },
				}),
				input: { sectionLabel: z.string().default("Risk") },
				transitions: { DONE: "done", ERROR: "failed" },
			},
			done: final(),
			failed: failed(),
		},
	}),
	"parallel-review": final(),
	failed: failed(),
});

const parallelReviewChart = panelChart("inspector-parallel-review", "parallel-review", {
	"parallel-review": parallel({
		states: {
			copy: reviewerRegion("copy-reviewer", "Review copy"),
			visual: reviewerRegion("visual-reviewer", "Review visuals"),
			data: reviewerRegion("data-reviewer", "Review data"),
		},
		onDone: "done",
	}),
	done: final(),
});

type StoryLogBuilder = {
	records: DurableLogRecord[];
	seq: number;
};
const STORY_RUNTIME_STARTED_AT = 1_700_000_000_000;
const storyTimestamp = (seqId: number) => STORY_RUNTIME_STARTED_AT + seqId * 1_000;

export function storyLog(args: Record<string, unknown> = { topic: "visual QA board" }): StoryLogBuilder {
	return { records: [{ type: "args", args, parentId: null, seqId: 1, branchId: "main", timestamp: storyTimestamp(1) }], seq: 1 };
}

function storyActionUid(ast: ChartAst, statePath: StatePath): ActionUID {
	const state = ast.states[templatePath(statePath)];
	if (state?.kind !== "state") throw new Error(`Story state ${statePath} is not an action state`);
	return { ...state.action.uid, state: statePath };
}

function storyActionDefinition(ast: ChartAst, statePath: StatePath): Extract<StateAst, { kind: "state" }>["action"] {
	const state = ast.states[templatePath(statePath)];
	if (state?.kind !== "state") throw new Error(`Story state ${statePath} is not an action state`);
	return state.action;
}

function pushInvoke(builder: StoryLogBuilder, ast: ChartAst, statePath: StatePath): ActionUID {
	const actionUid = storyActionUid(ast, statePath);
	builder.records.push({
		type: "state_action",
		kind: "invoke",
			sessionId: "session-id",
		actionUid,
		definition: storyActionDefinition(ast, statePath),
		parentId: builder.seq,
		seqId: ++builder.seq,
		branchId: "main", timestamp: storyTimestamp(builder.seq),
	});
	return actionUid;
}

function pushComplete(builder: StoryLogBuilder, ast: ChartAst, statePath: StatePath, event: ChartEvent, artifacts?: Readonly<Record<string, ArtifactPin>>): void {
	builder.records.push({
		type: "state_action",
		kind: "complete",
		actionUid: storyActionUid(ast, statePath),
		event,
		...(artifacts === undefined ? {} : { artifacts }),
		parentId: builder.seq,
		seqId: ++builder.seq,
		branchId: "main", timestamp: storyTimestamp(builder.seq),
	});
}

function pushAction(builder: StoryLogBuilder, ast: ChartAst, statePath: StatePath, event?: ChartEvent, artifacts?: Readonly<Record<string, ArtifactPin>>): void {
	pushInvoke(builder, ast, statePath);
	if (event !== undefined) pushComplete(builder, ast, statePath, event, artifacts);
}

function pushFailure(builder: StoryLogBuilder, ast: ChartAst, statePath: StatePath, error: unknown): void {
	pushInvoke(builder, ast, statePath);
	builder.records.push({ type: "failure_intent", origin: statePath, error, parentId: builder.seq, seqId: ++builder.seq, branchId: "main", timestamp: storyTimestamp(builder.seq) });
}

function pushValidated(
	builder: StoryLogBuilder,
	ast: ChartAst,
	statePath: StatePath,
	event: ChartEvent,
	reason: string,
): void {
	const state = ast.states[templatePath(statePath)];
	if (state?.kind !== "state" || state.validate === undefined)
		throw new Error(`Story state ${statePath} has no validation guard`);
	builder.records.push({
		type: "state_action",
		kind: "validated",
		actionUid: storyActionUid(ast, statePath),
		event,
		guard: state.validate,
		outcome: { ok: false, reason },
		parentId: builder.seq,
		seqId: ++builder.seq,
		branchId: "main", timestamp: storyTimestamp(builder.seq),
	});
}

function pushSpawned(builder: StoryLogBuilder, path: StatePath, instances: Record<string, unknown>): void {
	builder.records.push({
		type: "spawned",
		path,
		instances,
		parentId: builder.seq,
		seqId: ++builder.seq,
		branchId: "main", timestamp: storyTimestamp(builder.seq),
	});
}

function storyLiveSession(ast: ChartAst, statePath: StatePath): HyperchartRuntimeSessionProgressFile {
	const actionUid = storyActionUid(ast, statePath);
	return {
		updatedAt: 1_700_000_060_000,
		sessions: {
			[JSON.stringify(actionUid)]: {
				actionUid,
				status: "running",
				startedAt: 1_700_000_000_000,
				lastActivityAt: 1_700_000_060_000,
				model: "claude-sonnet",
				thinking: "medium",
				turnCount: 3,
				toolCount: 4,
				tokenCount: 8_412,
				currentTool: "edit",
				currentToolArgs: '{\n  "path": "src/react/session.tsx"\n}',
				lastMessage: "I found the existing inspector styles and am wiring the live session view.",
				messages: [
					{ id: "m1", role: "user", text: "Add the live agent session view and keep it consistent with the inspector.", timestamp: 1_700_000_000_000 },
					{ id: "m2", role: "assistant", text: "I’ll inspect the existing card and modal patterns first.", timestamp: 1_700_000_010_000 },
					{ id: "m3", role: "tool", toolName: "read", text: "AgentInfoCard.tsx\nHyperchartInspectorDialogInner.tsx", timestamp: 1_700_000_020_000 },
					{ id: "m4", role: "assistant", text: "The inspector already has the right portal and theme primitives. I’m reusing those and adding a compact transcript renderer.", timestamp: 1_700_000_040_000 },
				],
			},
		},
	};
}

function mapReviewRecords(ast: ChartAst, opts: { failRisk?: boolean; overflow?: boolean; complete?: boolean } = {}): DurableLogRecord[] {
	const b = storyLog();
	const sections = opts.overflow === true
		? Object.fromEntries(Array.from({ length: 14 }, (_, index) => [
				`section-${index + 1}`,
				{
					title: `A deliberately long section title ${index + 1} that must remain bounded inside the resolved map input card`,
					summary: `Verified evidence summary ${index + 1}. `.repeat(12),
				},
			]))
		: opts.failRisk === true
			? { risk: { title: "Risk", summary: "Citation gap" } }
			: {
					intro: { title: "Intro", summary: "Done" },
					risk: { title: "Risk", summary: "Running" },
					market: { title: "Market", summary: "Failed" },
				};
	pushAction(b, ast, "script-contracts", { type: "RENDERED", output: { sections } });
	pushSpawned(b, "map-review", sections);
	if (opts.failRisk === true) {
		pushAction(b, ast, "map-review#risk.risk-write", { type: "ERROR" });
		return b.records;
	}
	if (opts.complete === true) {
		for (const key of Object.keys(sections)) pushAction(b, ast, `map-review#${key}.risk-write`, { type: "DONE" });
		return b.records;
	}
	if (opts.overflow === true) {
		pushInvoke(b, ast, "map-review#section-1.risk-write");
		return b.records;
	}
	pushAction(b, ast, "map-review#intro.risk-write", { type: "DONE" });
	pushInvoke(b, ast, "map-review#risk.risk-write");
	pushAction(b, ast, "map-review#market.risk-write", { type: "ERROR" });
	return b.records;
}

function parallelReviewRecords(ast: ChartAst, complete = false): DurableLogRecord[] {
	const b = storyLog();
	pushAction(b, ast, "parallel-review.copy.review", { type: "DONE" });
	pushAction(b, ast, "parallel-review.visual.review", { type: complete ? "DONE" : "ERROR" });
	if (complete) pushAction(b, ast, "parallel-review.data.review", { type: "DONE" });
	else pushInvoke(b, ast, "parallel-review.data.review");
	return b.records;
}

const inspectorPanelSpecInputs: InspectorPanelSpecInput[] = [
	{
		group: "overview",
		title: "Run overview",
		description: "Right panel before a node is selected.",
		chart: panelChart("inspector-overview", "plan", {
			plan: {
				kind: "state",
				action: agent("planner", { task: "Plan report sections.", reply: z.object({ sections: sectionMapSchema }) }),
				transitions: { DONE: "write" },
			},
			write: {
				kind: "state",
				action: agent("writer", { task: "Write the first report draft." }),
				transitions: { DONE: "review-map" },
			},
			"review-map": map({
				over: result("plan", "sections"),
				initial: "review",
				onDone: "final",
				states: {
					review: {
						kind: "state",
						action: agent("reviewer", { task: "Review one planned section." }),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
			final: final(),
		}),
		runtime: {
			selectedStateId: null,
			run: { status: "running", args: { topic: "visual QA board" } },
			records: (ast) => {
				const b = storyLog({ topic: "visual QA board" });
				pushAction(b, ast, "plan", {
					type: "DONE",
					output: {
						sections: {
							intro: { title: "Intro" },
							platform: { title: "Platform" },
							risk: { title: "Risk" },
							next: { title: "Next" },
						},
					},
				});
				pushAction(b, ast, "write", { type: "DONE" });
				pushSpawned(b, "review-map", {
					intro: { title: "Intro" },
					platform: { title: "Platform" },
					risk: { title: "Risk" },
					next: { title: "Next" },
				});
				pushAction(b, ast, "review-map#intro.review", { type: "DONE" });
				pushAction(b, ast, "review-map#platform.review", { type: "DONE" });
				pushInvoke(b, ast, "review-map#risk.review");
				return b.records;
			},
		},
	},
	{
		group: "overview",
		title: "Run issues",
		description: "Run-level failure and replay warning issues from status.json.",
		chart: panelChart("inspector-run-issues", "work", {
			work: {
				kind: "state",
				action: agent("worker", { task: "Resume a run with replay warnings." }),
				transitions: { DONE: "done", ERROR: "failed" },
			},
			done: final(),
			failed: failed(),
		}),
		runtime: {
			selectedStateId: null,
			run: {
				status: "failed",
				args: { topic: "runtime issue board" },
				statusError: "Replay over the current chart produced warning-level compatibility issues.",
				exitCode: 1,
				replayWarnings: ["Replay warning: 2 durable record(s) have stale provenance under the current chart (work)."],
			},
		},
	},
	{
		group: "agent",
		title: "Minimal pending node",
		description: "Empty Status stays hidden; placeholders cover empty arguments and logs.",
		chart: panelChart("inspector-minimal-pending", "minimal-pending", {
			"minimal-pending": { kind: "state", action: agent("worker") },
		}),
		runtime: { selectedStateId: "minimal-pending", mode: "static" },
	},
	{
		group: "agent",
		title: "Rich agent",
		description: "Definition-only agent card, short prompt, and run-specific live session inside Runtime alongside visits.",
		chart: panelChart("inspector-rich-agent", "prepare-context", {
			"prepare-context": {
				kind: "state",
				action: script("node", ["scripts/prepare-context.mjs"], {
					artifacts: {
						context: artifact("artifacts/implementation-context.json", richAgentContextSchema),
						conventions: artifact("artifacts/writing-conventions.json", richAgentConventionsSchema),
					},
					reply: z.object({ sources: z.record(z.string(), z.object({ title: z.string() })) }),
				}),
				transitions: { DONE: "source-map" },
			},
			"source-map": map({
				over: result("prepare-context", "sources"),
				initial: "collect",
				onDone: "rich-agent",
				states: {
					collect: {
						kind: "state",
						action: agent("source-reader", {
							task: "Summarize the assigned implementation source.",
							artifacts: {
								brief: artifact(t`artifacts/source-${key()}.json`, richAgentSourceBriefSchema),
							},
						}),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
			"rich-agent": {
				kind: "state",
				action: agent("writer", {
					task: "Write a compact implementation note.\n\nInclude risks, test commands, and exact file paths.",
					artifacts: {
						note: artifact(t`artifacts/implementation-note-${visit("rich-agent")}.json`, richAgentNoteSchema),
						appendix: t`artifacts/implementation-note-${visit("rich-agent")}.md`,
					},
					model: "claude-sonnet",
					thinking: "medium",
					tools: ["read", "edit", "bash"],
					reads: [
						artifactOf("prepare-context", { artifact: "context" }),
						artifactOf("prepare-context", { artifact: "conventions" }),
						joinArtifactOf("source-map.collect", { artifact: "brief" }),
						t`notes/rich-agent-visit-${visit("rich-agent")}.md`,
					],
					reply: writerReplySchema,
				}),
				transitions: {
					REVISE: "rich-agent",
					DONE: { target: "long-prompt", input: { draft: event("draft") } },
					REVIEW_REQUIRED: {
						target: "review-follow-up",
						input: {
							draft: event("draft"),
							primaryRisk: event("review.risks.0"),
							evidence: event("review.evidence"),
							score: event("review.score"),
						},
					},
				},
			},
			"review-follow-up": {
				kind: "state",
				input: {
					draft: z.string(),
					primaryRisk: z.string(),
					evidence: z.array(z.object({ file: z.string(), line: z.number().int() })),
					score: z.number(),
				},
				action: agent("reviewer", {
					task: t`Review ${input("draft")} for risk ${input("primaryRisk")} with evidence ${json(input("evidence"))} at score ${input("score")}.`,
				}),
				transitions: { DONE: "done" },
			},
			"long-prompt": {
				kind: "state",
				input: { draft: z.string() },
				action: agent("writer", { task: t`Expand this draft: ${input("draft")}` }),
				transitions: { DONE: "done" },
			},
			done: final(),
		}),
		runtime: {
			selectedStateId: "rich-agent",
			records: (ast) => {
				const b = storyLog();
				const sources = {
					api: { title: "Core API" },
					runtime: { title: "Runtime semantics" },
				};
				pushAction(b, ast, "prepare-context", { type: "DONE", output: { sources } });
				pushSpawned(b, "source-map", sources);
				pushAction(b, ast, "source-map#api.collect", { type: "DONE" });
				pushAction(b, ast, "source-map#runtime.collect", { type: "DONE" });
				pushAction(b, ast, "rich-agent", {
					type: "REVISE",
					output: {
						draft: "First implementation note draft.",
						review: {
							risks: ["The replay contract may drift."],
							evidence: [{ file: "packages/hyperchart/src/core/replay_check.ts", line: 184 }],
							score: 0.72,
						},
					},
				});
				pushInvoke(b, ast, "rich-agent");
				return b.records;
			},
			sessionProgress: (ast) => storyLiveSession(ast, "rich-agent"),
		},
	},
	{
		group: "agent",
		title: "Pinned deliverables",
		description: "Completed visit showing the immutable content revisions (path, sha256, size) accepted with the completion.",
		chart: panelChart("inspector-pinned-artifacts", "report-writer", {
			"report-writer": {
				kind: "state",
				action: agent("writer", {
					task: "Write the findings report and its machine-readable summary.",
					artifacts: {
						report: artifact("artifacts/findings-report.md"),
						summary: artifact("artifacts/findings-summary.json", z.object({ findings: z.number() })),
					},
				}),
				transitions: { DONE: "done" },
			},
			done: final(),
		}),
		runtime: {
			selectedStateId: "report-writer",
			records: (ast) => {
				const b = storyLog();
				pushAction(b, ast, "report-writer", { type: "DONE" }, {
					"artifacts/findings-report.md": { hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", size: 18_324 },
					"artifacts/findings-summary.json": { hash: "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae", size: 96 },
				});
				return b.records;
			},
		},
	},
	{
		group: "agent",
		title: "Failed action issue",
		description: "Global failure intent with a readable action failure issue from a durable event.",
		chart: panelChart("inspector-failed-action-issue", "worker", {
			worker: {
				kind: "state",
				action: agent("worker", { task: longPrompt }),
				transitions: { DONE: "done" },
			},
			done: final(),
		}),
		runtime: {
			selectedStateId: "worker",
			run: { status: "failed" },
			records: (ast) => {
				const b = storyLog();
				pushFailure(b, ast, "worker", "Agent process exited before calling finish.");
				return b.records;
			},
		},
	},
	{
		group: "agent",
		title: "Long prompt",
		description: "Prompt exceeds its preview, shows Open full, and does not mount the complete text initially.",
		graphAtlas: false,
		chart: panelChart("inspector-long-prompt", "long-prompt", {
			"long-prompt": { kind: "state", action: agent("writer", { task: longPrompt }), transitions: { DONE: "done" } },
			done: final(),
		}),
		runtime: { selectedStateId: "long-prompt" },
	},
	{
		group: "agent",
		title: "Inputs, refs, re-entry",
		description: "Declared inputs, typed refs, and onReenter resume copy.",
		graphAtlas: false,
		chart: panelChart("inspector-inputs-and-refs", "rich-agent", {
			"rich-agent": {
				kind: "state",
				action: agent("writer", {
					task: "Produce feedback for the next state.",
					reply: z.object({ output: z.string() }),
				}),
				transitions: { DONE: { target: "inputs-and-refs", input: { feedback: event("output") } } },
			},
			"inputs-and-refs": {
				kind: "state",
				input: { feedback: z.string(), mode: z.enum(["fast", "strict"]).default("strict") },
				action: agent("reader", {
					task: t`Use ${input("feedback")} in ${input("mode")} mode with prior ${result("rich-agent", "output")}. Visit ${visit("inputs-and-refs")}.`,
				}),
				onReenter: resume(
					t`Resume with the latest ${input("feedback")} and preserve ${result("rich-agent", "output")}.`,
				),
				transitions: { SUBMIT: "script-contracts" },
			},
			"script-contracts": {
				kind: "state",
				action: script("node", ["scripts/render-report.mjs"]),
				transitions: { DONE: "done" },
			},
			done: final(),
		}),
		runtime: { selectedStateId: "inputs-and-refs" },
	},
	{
		group: "actors",
		title: "Actor definition-only",
		description: "Static actor placement input, initial receive state, and complete protocol.",
		chart: actorInspectorChart,
		runtime: { selectedStateId: "@editor" },
	},
	{
		group: "actors",
		title: "Actor runtime and mailbox",
		description: "A materialized actor with immutable input, accepted current message, and FIFO queued message.",
		chart: actorInspectorChart,
		runtime: { selectedStateId: "@editor", records: actorInspectorRecords },
	},
	{
		group: "actors",
		title: "Mailbox across re-entry",
		description: "A simple actor with two generations: processed messages in the first instance and a current plus queued message in the second.",
		chart: mailboxReentryChart,
		runtime: { selectedStateId: "phase.@worker", records: mailboxReentryRecords },
	},
	{
		group: "actors",
		title: "Actor pool definition-only",
		description: "A fixed-concurrency pool endpoint with one canonical persistent worker workflow.",
		chart: actorPoolChart,
		runtime: { selectedStateId: "@workers" },
	},
	{
		group: "actors",
		title: "Actor pool workers and backlog",
		description: "Ten batch messages: four queued at the endpoint while each persistent worker shows two processed messages and one current assignment.",
		chart: actorPoolCrowdedChart,
		runtime: { selectedStateId: "@workers", records: () => actorPoolCrowdedRecords },
	},
	{
		group: "actors",
		title: "Send state",
		description: "Completed fire-and-forget REVIEW send with its resolved message payload and actor destination.",
		chart: actorInspectorChart,
		runtime: { selectedStateId: "queue-review", records: actorInspectorRecords },
	},
	{
		group: "actors",
		title: "Send batch state",
		description: "Completed sendBatch with its ordered APPLY inputs and projected durable messages.",
		chart: actorInspectorChart,
		runtime: { selectedStateId: "queue", records: actorInspectorRecords },
	},
	{
		group: "actors",
		title: "Self-send state",
		description: "Actor-local sendBatch targets self(), resolves to the shared pool endpoint, and retains the typed CRAWL contract.",
		chart: actorSelfChart,
		runtime: { selectedStateId: "@workers.$worker.fanout" },
	},
	{
		group: "actors",
		title: "Call state",
		description: "Blocked APPLY call with its pending caller, typed reply transitions, and queued runtime message.",
		chart: actorInspectorChart,
		runtime: { selectedStateId: "apply-call", records: actorInspectorRecords },
	},
	{
		group: "actors",
		title: "Call batch state",
		description: "Running callBatch against a two-worker pool with ordered inputs, per-message assignments, replies, and backlog.",
		chart: actorPoolCrowdedChart,
		runtime: { selectedStateId: "batch", records: () => actorPoolCrowdedRecords },
	},
	{
		group: "actors",
		title: "Receive state",
		description: "Materialized receive node with its protocol transition and actor-internal identity.",
		chart: actorInspectorChart,
		runtime: { selectedStateId: "@editor.idle", records: actorInspectorRecords },
	},
	{
		group: "actors",
		title: "Receive state across re-entry",
		description: "Receive state inside a two-generation actor, with accepted messages from both durable instances.",
		chart: mailboxReentryChart,
		runtime: { selectedStateId: "phase.@worker.idle", records: mailboxReentryRecords },
	},
	{
		group: "actors",
		title: "Reply state",
		description: "Materialized named reply node and its return transition to receive.",
		chart: actorInspectorChart,
		runtime: { selectedStateId: "@editor.settle", records: actorInspectorRecords },
	},
	{
		group: "actors",
		title: "Reply state across re-entry",
		description: "Reply state inside a two-generation actor, with settled replies retained from the first instance.",
		chart: mailboxReentryChart,
		runtime: { selectedStateId: "phase.@worker.settle", records: mailboxReentryRecords },
	},
	{
		group: "user",
		title: "User state",
		description: "Real user state kind with prompt and transition.",
		chart: panelChart("inspector-user-feedback", "user-feedback", {
			"user-feedback": {
				kind: "state",
				action: user({ prompt: "Ask the user to approve the generated report outline." }),
				transitions: { APPROVED: "script-contracts" },
			},
			"script-contracts": {
				kind: "state",
				action: script("node", ["scripts/render-report.mjs"]),
				transitions: { DONE: "done" },
			},
			done: final(),
		}),
		runtime: { selectedStateId: "user-feedback" },
	},
	{
		group: "user",
		title: "Completed user decision",
		description: "Completed user state with two possible transitions; APPROVED was selected and execution advanced to publish.",
		chart: panelChart("inspector-user-decision-complete", "user-decision", {
			"user-decision": {
				kind: "state",
				action: user({ prompt: "Approve the report for publication or return it for revision." }),
				transitions: { APPROVED: "publish", REVISE: "revise" },
			},
			publish: { kind: "state", action: agent("publisher", { task: "Publish the approved report." }) },
			revise: { kind: "state", action: agent("editor", { task: "Revise the rejected report." }) },
		}),
		runtime: {
			selectedStateId: "user-decision",
			records: (ast) => {
				const builder = storyLog();
				pushAction(builder, ast, "user-decision", { type: "APPROVED" });
				pushInvoke(builder, ast, "publish");
				return builder.records;
			},
		},
	},
	{
		group: "script",
		title: "Script contracts",
		description: "Artifacts, reply schema, command, and env value types.",
		chart: panelChart("inspector-script-contracts", "prepare-data", {
			"prepare-data": {
				kind: "state",
				action: agent("planner", { task: "Prepare structured report data for renderer.", reply: reportDataSchema }),
				transitions: { DONE: "script-contracts" },
			},
			"script-contracts": {
				kind: "state",
				action: script("node", ["scripts/render-report.mjs", "--format", "html", "--out", "dist/report.html"], {
					env: { RUN_DIR: "runs/current", REPORT_DATA: t`${json(result("prepare-data"))}` },
					artifacts: { html: "dist/report.html", data: artifact("dist/report.json", reportDataSchema) },
					reply: renderReplySchema,
				}),
				transitions: { RENDERED: "done" },
			},
			done: final(),
		}),
		runtime: {
			selectedStateId: "script-contracts",
			run: { status: "completed" },
			records: (ast) => {
				const b = storyLog();
				pushAction(b, ast, "prepare-data", { type: "DONE", output: { title: "Report", sections: ["intro", "risk"] } });
				pushAction(b, ast, "script-contracts", { type: "RENDERED", output: { ok: true, url: "dist/report.html" } });
				return b.records;
			},
		},
	},
	{
		group: "script",
		title: "Structured script failure",
		description: "Structured FAILED payload keeps a short summary plus expandable JSON.",
		chart: panelChart("inspector-structured-script-failure", "render", {
			render: {
				kind: "state",
				action: script("node", ["scripts/render-report.mjs"], { reply: renderReplySchema }),
				transitions: { RENDERED: "done", ERROR: "failed" },
			},
			done: final(),
			failed: failed(),
		}),
		runtime: {
			selectedStateId: "render",
			run: { status: "failed" },
			records: (ast) => {
				const b = storyLog();
				pushFailure(b, ast, "render", { code: 2, signal: null, stderr: "Error: missing report template" });
				return b.records;
			},
		},
	},
	{
		group: "map",
		title: "Empty pending map",
		description: "Pending map before input resolution and item spawning.",
		chart: mapReviewChart,
		runtime: { selectedStateId: "map-review", mode: "static" },
	},
	{
		group: "map",
		title: "Map parent",
		description: "map over input, resolved input items, progress, Open map button, and child contracts in scope.",
		chart: mapReviewChart,
		runtime: {
			selectedStateId: "map-review",
			records: mapReviewRecords,
		},
	},
	{
		group: "map",
		title: "Completed map",
		description: "Map after every spawned item reached its final state.",
		chart: mapReviewChart,
		runtime: { selectedStateId: "map-review", records: (ast) => mapReviewRecords(ast, { complete: true }) },
	},
	{
		group: "map",
		title: "Map parent overflow",
		description: "Long adapter-derived map values exercise bounded resolved-input previews.",
		graphAtlas: false,
		chart: mapReviewChart,
		runtime: {
			selectedStateId: "map-review",
			records: (ast) => mapReviewRecords(ast, { overflow: true }),
		},
	},
	{
		group: "map",
		title: "Map item worker",
		description: "Mapped item label, item artifact, and runtime item status.",
		graphAtlas: false,
		chart: mapReviewChart,
		runtime: {
			selectedStateId: "map-review#risk.risk-write",
			run: { status: "failed" },
			records: (ast) => mapReviewRecords(ast, { failRisk: true }),
		},
	},
	{
		group: "parallel",
		title: "Empty pending parallel",
		description: "Pending parallel before any branch starts.",
		chart: parallelReviewChart,
		runtime: { selectedStateId: "parallel-review", mode: "static" },
	},
	{
		group: "parallel",
		title: "Parallel fan-out",
		description: "Parallel branches, branch chips, and progress.",
		chart: parallelReviewChart,
		runtime: { selectedStateId: "parallel-review", records: parallelReviewRecords },
	},
	{
		group: "parallel",
		title: "Completed parallel",
		description: "Parallel after every branch reached its final state.",
		chart: parallelReviewChart,
		runtime: { selectedStateId: "parallel-review", records: (ast) => parallelReviewRecords(ast, true) },
	},
	{
		group: "compound",
		title: "Compound scope",
		description: "Scope kind, Open scope button, agents/contracts in nested children.",
		chart: panelChart("inspector-compound-scope", "compound-scope", {
			"compound-scope": compound({
				initial: "plan",
				onDone: "final",
				states: {
					plan: {
						kind: "state",
						action: agent("scoped-planner", {
							task: "Plan scoped follow-up",
							artifacts: { plan: artifact("artifacts/scoped-plan.json", scopedPlanSchema) },
						}),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
			final: final(),
		}),
		runtime: { selectedStateId: "compound-scope" },
	},
	{
		group: "compound",
		title: "Parallel branch scope",
		description: "A parallel branch is shown with the same compound scope UI, not as a separate product type.",
		graphAtlas: false,
		chart: panelChart("inspector-branch-scope", "parallel-review", {
			"parallel-review": parallel({
				states: { branch: reviewerRegion("branch-reviewer", "Review one branch") },
				onDone: "final",
			}),
			final: final(),
		}),
		runtime: { selectedStateId: "parallel-review.branch" },
	},
	{
		group: "agent",
		title: "Validation failure",
		description: "Validation retry status and failed transition highlighting.",
		chart: panelChart("inspector-validation-rejected", "validation-rejected", {
			"validation-rejected": {
				kind: "state",
				action: agent("reviewer", { tools: [] }),
				validate: script("node", ["scripts/validate-review.mjs"]),
				retries: 2,
				transitions: { PASS: "done", ERROR: "failed" },
			},
			done: final(),
			failed: failed(),
		}),
		runtime: {
			selectedStateId: "validation-rejected",
			records: (ast) => {
				const b = storyLog();
				const event = { type: "PASS" };
				pushAction(b, ast, "validation-rejected", event);
				pushValidated(
					b,
					ast,
					"validation-rejected",
					event,
					"Review coverage is below threshold: missing source citations.",
				);
				return b.records;
			},
		},
	},
	{
		group: "agent",
		title: "Imported validation guard",
		description: "A TypeScript import guard with restart-on-reject and a bounded retry budget.",
		graphAtlas: false,
		chart: panelChart("inspector-imported-guard", "coverage-review", {
			"coverage-review": {
				kind: "state",
				action: agent("coverage-reviewer", { task: "Review source coverage before rendering." }),
				validate: tsImport("./guards/coverage.ts", "coverageGuard"),
				onReject: "restart",
				retries: 1,
				transitions: { PASS: "done", ERROR: "failed" },
			},
			done: final(),
			failed: failed(),
		}),
		runtime: {
			selectedStateId: "coverage-review",
			records: (ast) => {
				const b = storyLog();
				const event = { type: "PASS" };
				pushAction(b, ast, "coverage-review", event);
				pushValidated(b, ast, "coverage-review", event, "Imported guard asked for a fresh source pass.");
				return b.records;
			},
		},
	},
	{
		group: "script",
		title: "Pending script",
		description: "Pending script state with command definition.",
		chart: panelChart("inspector-skipped-cleanup", "skipped-cleanup", {
			"skipped-cleanup": { kind: "state", action: script("rm", ["-rf", "tmp/report-work"]) },
		}),
		runtime: { selectedStateId: "skipped-cleanup" },
	},
	{
		group: "final",
		title: "Final notification",
		description: "Reached successful terminal with a typed notification prompt, artifact attachment, and explicit render scope.",
		chart: panelChart("inspector-final-notification", "prepare", {
			prepare: {
				kind: "state",
				action: agent("reporter", {
					task: "Prepare the final report and summary.",
					reply: z.object({ summary: z.string() }).strict(),
					artifacts: { report: artifact("artifacts/final-report.json", reportDataSchema) },
				}),
				transitions: { DONE: "final" },
			},
			final: final({
				notify: {
					prompt: t`Report completed: ${result("prepare", "summary")}`,
					artifacts: [artifactOf("prepare", { artifact: "report" })],
					scope: "prepare",
				},
			}),
		}),
		runtime: {
			selectedStateId: "final",
			run: { status: "completed" },
			records: (ast) => {
				const builder = storyLog();
				pushAction(builder, ast, "prepare", { type: "DONE", output: { summary: "The final report is ready." } });
				return builder.records;
			},
		},
	},
	{
		group: "final",
		title: "Failed final",
		description: "Reached failed terminal with an explicit failed outcome and no notification override.",
		chart: panelChart("inspector-failed-final", "failed", { failed: failed() }),
		runtime: { selectedStateId: "failed", run: { status: "failed" } },
	},
];

export const inspectorPanelSpecs: InspectorPanelSpec[] = inspectorPanelSpecInputs;
