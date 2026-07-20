import { z } from "zod";
import {
	agent,
	artifact,
	chart,
	compound,
	event,
	final,
	input,
	json,
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
import type { DurableLogRecord } from "../../../core/durable_events.js";
import type { HyperchartRuntimeSessionProgressFile } from "../../../host/index.js";
import type { HyperchartRunStatus } from "../../types.js";

export type InspectorPanelRuntime = {
	selectedStateId: StatePath | null;
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

export type InspectorPanelGroupId = "overview" | "agent" | "user" | "script" | "map" | "parallel" | "compound" | "final";

export type InspectorPanelSpecInput = {
	group: InspectorPanelGroupId;
	title: string;
	description: string;
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
const writerReplySchema = z.object({ draft: z.string() });
const renderReplySchema = z.object({
	ok: z.boolean(),
	url: z.string().optional(),
	sections: sectionMapSchema.optional(),
});
const reportDataSchema = z.object({ title: z.string(), sections: z.array(z.string()) });
const scopedPlanSchema = z.object({ next: z.string().optional() });

function panelChart(id: string, initial: string, states: ChartCst["states"]): ChartCst {
	return chart({ kind: "chart", id, initial, states });
}

function reviewerRegion(agentName: string, task: string): ReturnType<typeof compound> {
	return compound({
		initial: "review",
		states: {
			review: { kind: "state", action: agent(agentName, { task }), transitions: { DONE: "done", FAILED: "failed" } },
			done: final(),
			failed: final(),
		},
	});
}

const mapReviewChart = panelChart("inspector-map-review", "script-contracts", {
	"script-contracts": {
		kind: "state",
		action: script("node", ["scripts/render-report.mjs"], { reply: z.object({ sections: sectionMapSchema }) }),
		transitions: { RENDERED: "map-review", FAILED: "failed" },
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
				transitions: { DONE: "done", FAILED: "failed" },
			},
			done: final(),
			failed: final(),
		},
	}),
	"parallel-review": final(),
	failed: final(),
});

type StoryLogBuilder = {
	records: DurableLogRecord[];
	seq: number;
};

export function storyLog(args: Record<string, unknown> = { topic: "visual QA board" }): StoryLogBuilder {
	return { records: [{ type: "args", args, parentId: null, seqId: 1, timestamp: 1 }], seq: 1 };
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
		actionUid,
		definition: storyActionDefinition(ast, statePath),
		parentId: builder.seq,
		seqId: ++builder.seq,
		timestamp: builder.seq,
	});
	return actionUid;
}

function pushComplete(builder: StoryLogBuilder, ast: ChartAst, statePath: StatePath, event: ChartEvent): void {
	builder.records.push({
		type: "state_action",
		kind: "complete",
		actionUid: storyActionUid(ast, statePath),
		event,
		parentId: builder.seq,
		seqId: ++builder.seq,
		timestamp: builder.seq,
	});
}

function pushAction(builder: StoryLogBuilder, ast: ChartAst, statePath: StatePath, event?: ChartEvent): void {
	pushInvoke(builder, ast, statePath);
	if (event !== undefined) pushComplete(builder, ast, statePath, event);
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
		timestamp: builder.seq,
	});
}

function pushSpawned(builder: StoryLogBuilder, path: StatePath, instances: Record<string, unknown>): void {
	builder.records.push({
		type: "spawned",
		path,
		instances,
		parentId: builder.seq,
		seqId: ++builder.seq,
		timestamp: builder.seq,
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

function storySessionFailure(
	ast: ChartAst,
	statePath: StatePath,
	message: string,
): HyperchartRuntimeSessionProgressFile {
	const actionUid = storyActionUid(ast, statePath);
	return {
		updatedAt: 1_700_000_060_000,
		sessions: {
			[JSON.stringify(actionUid)]: {
				actionUid,
				status: "failed",
				lastActivityAt: 1_700_000_040_000,
				error: message,
			},
		},
	};
}

function mapReviewRecords(ast: ChartAst, opts: { failRisk?: boolean } = {}): DurableLogRecord[] {
	const b = storyLog();
	const sections =
		opts.failRisk === true
			? { risk: { title: "Risk", summary: "Citation gap" } }
			: {
					intro: { title: "Intro", summary: "Done" },
					risk: { title: "Risk", summary: "Running" },
					market: { title: "Market", summary: "Failed" },
				};
	pushAction(b, ast, "script-contracts", { type: "RENDERED", output: { sections } });
	pushSpawned(b, "map-review", sections);
	if (opts.failRisk === true) {
		pushAction(b, ast, "map-review#risk.risk-write", {
			type: "FAILED",
			error: "Could not write artifacts/risk.md because the citation source is missing.",
		});
		return b.records;
	}
	pushAction(b, ast, "map-review#intro.risk-write", { type: "DONE" });
	pushInvoke(b, ast, "map-review#risk.risk-write");
	pushAction(b, ast, "map-review#market.risk-write", { type: "FAILED", error: "Missing revenue split" });
	return b.records;
}

function parallelReviewRecords(ast: ChartAst): DurableLogRecord[] {
	const b = storyLog();
	pushAction(b, ast, "parallel-review.copy.review", { type: "DONE" });
	pushAction(b, ast, "parallel-review.visual.review", { type: "FAILED", error: "Screenshot diff exceeded threshold." });
	pushInvoke(b, ast, "parallel-review.data.review");
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
				transitions: { DONE: "done", FAILED: "failed" },
			},
			done: final(),
			failed: final(),
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
		runtime: { selectedStateId: "minimal-pending" },
	},
	{
		group: "agent",
		title: "Rich agent",
		description: "Agent card, short prompt that fits without Open full, runtime facts, transitions, and visits.",
		chart: panelChart("inspector-rich-agent", "rich-agent", {
			"rich-agent": {
				kind: "state",
				action: agent("writer", {
					task: "Write a compact implementation note.\n\nInclude risks, test commands, and exact file paths.",
					model: "claude-sonnet",
					thinking: "medium",
					tools: ["read", "edit", "bash"],
					reads: ["src/react/HyperchartInspectorDialog.tsx"],
					reply: writerReplySchema,
				}),
				transitions: { DONE: { target: "long-prompt", input: { draft: event("draft") } } },
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
				pushInvoke(b, ast, "rich-agent");
				return b.records;
			},
			sessionProgress: (ast) => storyLiveSession(ast, "rich-agent"),
		},
	},
	{
		group: "agent",
		title: "Failed action issue",
		description: "FAILED transition with a readable action failure issue from a durable event.",
		chart: panelChart("inspector-failed-action-issue", "worker", {
			worker: {
				kind: "state",
				action: agent("worker", { task: "Attempt the risky operation." }),
				transitions: { DONE: "done", FAILED: "failed" },
			},
			done: final(),
			failed: final(),
		}),
		runtime: {
			selectedStateId: "worker",
			run: { status: "failed" },
			records: (ast) => {
				const b = storyLog();
				pushAction(b, ast, "worker", { type: "FAILED", error: "Agent process exited before calling finish." });
				return b.records;
			},
		},
	},
	{
		group: "agent",
		title: "Session failure issue",
		description: "Agent session progress failure linked to the matching state.",
		chart: panelChart("inspector-session-failure", "session-worker", {
			"session-worker": {
				kind: "state",
				action: agent("worker", { task: "Continue a long-running session." }),
				transitions: { DONE: "done", FAILED: "failed" },
			},
			done: final(),
			failed: final(),
		}),
		runtime: {
			selectedStateId: "session-worker",
			run: { status: "failed" },
			records: (ast) => {
				const b = storyLog();
				pushInvoke(b, ast, "session-worker");
				return b.records;
			},
			sessionProgress: (ast) =>
				storySessionFailure(
					ast,
					"session-worker",
					"Subagent session ended unexpectedly after tool budget was exceeded.",
				),
		},
	},
	{
		group: "agent",
		title: "Long prompt",
		description: "Prompt exceeds its preview, shows Open full, and does not mount the complete text initially.",
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
				transitions: { RENDERED: "done", FAILED: "failed" },
			},
			done: final(),
			failed: final(),
		}),
		runtime: {
			selectedStateId: "render",
			run: { status: "failed" },
			records: (ast) => {
				const b = storyLog();
				pushAction(b, ast, "render", {
					type: "FAILED",
					error: { code: 2, signal: null, stderr: "Error: missing report template" },
				});
				return b.records;
			},
		},
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
		title: "Map item worker",
		description: "Mapped item label, item artifact, and runtime item status.",
		chart: mapReviewChart,
		runtime: {
			selectedStateId: "map-review#risk.risk-write",
			run: { status: "failed" },
			records: (ast) => mapReviewRecords(ast, { failRisk: true }),
		},
	},
	{
		group: "parallel",
		title: "Parallel fan-out",
		description: "Parallel branches, branch chips, and progress.",
		chart: panelChart("inspector-parallel-review", "parallel-review", {
			"parallel-review": parallel({
				states: {
					copy: reviewerRegion("copy-reviewer", "Review copy"),
					visual: reviewerRegion("visual-reviewer", "Review visuals"),
					data: reviewerRegion("data-reviewer", "Review data"),
				},
				onDone: "compound-scope",
			}),
			"compound-scope": final(),
		}),
		runtime: {
			selectedStateId: "parallel-review",
			records: parallelReviewRecords,
		},
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
				transitions: { PASS: "done", FAILED: "failed" },
			},
			done: final(),
			failed: final(),
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
		chart: panelChart("inspector-imported-guard", "coverage-review", {
			"coverage-review": {
				kind: "state",
				action: agent("coverage-reviewer", { task: "Review source coverage before rendering." }),
				validate: tsImport("./guards/coverage.ts", "coverageGuard"),
				onReject: "restart",
				retries: 1,
				transitions: { PASS: "done", FAILED: "failed" },
			},
			done: final(),
			failed: final(),
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
		title: "Final",
		description: "Terminal final state with no fake flow concepts.",
		chart: panelChart("inspector-final", "final", { final: final() }),
		runtime: { selectedStateId: "final", run: { status: "completed" } },
	},
];

export const inspectorPanelSpecs: InspectorPanelSpec[] = inspectorPanelSpecInputs;
