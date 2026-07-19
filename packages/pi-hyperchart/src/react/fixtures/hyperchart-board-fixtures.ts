import type { HyperchartInfo, HyperchartStateInfo, HyperchartRunInfo, HyperchartRunStatus } from "../types.js";

const FIXTURE_NOW = Date.UTC(2026, 6, 7, 22, 45, 0);
const now = FIXTURE_NOW;

export const boardCharts: HyperchartInfo[] = [
	{
		name: "simple-agent",
		description: "Single action state",
		scope: "project",
		stateCount: 3,
		updatedAt: now - 10_000,
	},
	{
		name: "parallel-fanout",
		description: "Parallel branches and joins",
		scope: "project",
		stateCount: 5,
		updatedAt: now - 20_000,
	},
	{
		name: "map-workers",
		description: "Map state with item workers",
		scope: "user",
		stateCount: 8,
		updatedAt: now - 30_000,
	},
	{
		name: "validation-retry",
		description: "Action validation retry metadata",
		scope: "user",
		stateCount: 4,
		updatedAt: now - 40_000,
	},
];

function state(
	id: string,
	status: HyperchartStateInfo["status"],
	type: NonNullable<HyperchartStateInfo["type"]>,
	extra: Omit<HyperchartStateInfo, "id" | "status" | "type"> = {},
): HyperchartStateInfo {
	const started = status === "running" || status === "done" || status === "failed";
	const timing =
		extra.startedAt !== undefined || extra.endedAt !== undefined || !started
			? {}
			: {
					startedAt: now - 210_000,
					...(status === "running" ? {} : { endedAt: now - 30_000 }),
				};
	return { id, status, type, ...timing, ...extra };
}

function run(
	runId: string,
	status: HyperchartRunStatus,
	states: HyperchartStateInfo[],
	extra: Partial<
		Omit<
			HyperchartRunInfo,
			"runId" | "status" | "states" | "stateCount" | "chartName" | "cwd" | "createdAt" | "updatedAt" | "args"
		>
	> = {},
): HyperchartRunInfo {
	return {
		runId,
		chartName: runId.split("-").slice(0, -1).join("-") || runId,
		status,
		cwd: "/Users/demo/Work/pi-hyperchart",
		createdAt: now - 900_000,
		updatedAt: now - 5_000,
		args: { topic: "visual QA board" },
		states,
		stateCount: states.length,
		...extra,
	};
}

export const runStripRuns: HyperchartRunInfo[] = [
	run("simple-agent-running", "running", [
		state("plan", "done", "agent", {
			agent: "planner",
			taskPreview: "Plan the work",
			transitions: [{ event: "READY", target: "write" }],
		}),
		state("write", "running", "agent", {
			agent: "writer",
			taskPreview: "Write implementation",
			transitions: [{ event: "DONE", target: "done" }],
		}),
		state("done", "pending", "final", { final: true }),
	]),
	run("parallel-branches-completed", "completed", [
		state("parallel", "done", "parallel", {
			parallelConfig: { count: 3, branches: [{ id: "branch-a" }, { id: "branch-b" }, { id: "branch-c" }] },
			transitions: [{ event: "onDone", target: "done" }],
		}),
		state("done", "done", "final", { final: true }),
	]),
	run("map-workers-blocked", "blocked", [
		state("chapters", "running", "map", {
			concurrency: 3,
			subProgress: { done: 2, running: 1, failed: 1, total: 5 },
			mapConfig: {
				over: "plan.chapters",
				as: "chapter",
				items: [
					{ key: "intro", label: "Intro", status: "done" },
					{ key: "platform", label: "Platform", status: "running" },
					{ key: "risk", label: "Risk", status: "failed" },
					{ key: "next", label: "Next", status: "pending" },
				],
			},
		}),
	]),
	run("validation-retry-failed", "failed", [
		state("review", "failed", "agent", { agent: "reviewer", retry: { max: 2 }, attempts: 2, validationAttempts: 2 }),
	]),
	run("paused-inspect-paused", "paused", [
		state("inspect-only", "pending", "agent", { agent: "static", taskPreview: "Static inspect preview" }),
	]),
];

export const statusMatrixRun = run("status-matrix-running", "running", [
	state("prepare-brief", "pending", "agent", {
		agent: "worker",
		taskPreview: "Prepare source brief",
		transitions: [{ event: "START", target: "draft-summary" }],
	}),
	state("draft-summary", "running", "agent", {
		agent: "worker",
		taskPreview: "Draft report summary",
		transitions: [{ event: "DONE", target: "review-coverage" }],
	}),
	state("review-coverage", "done", "agent", {
		agent: "worker",
		taskPreview: "Review source coverage",
		transitions: [{ event: "NEXT", target: "superseded-draft" }],
	}),
	state("superseded-draft", "stale", "agent", {
		agent: "worker",
		taskPreview: "Completed during the previous traversal",
		transitions: [{ event: "NEXT", target: "repair-citations" }],
	}),
	state("repair-citations", "failed", "agent", {
		agent: "worker",
		taskPreview: "Repair citation gaps",
		transitions: [{ event: "SKIP", target: "archive-notes" }],
	}),
	state("archive-notes", "skipped", "agent", { agent: "worker", taskPreview: "Archive review notes" }),
]);

export const stateKindsRun = run("state-kinds-running", "running", [
	state("agent", "pending", "agent", {
		agent: "writer",
		model: "agent-default",
		thinking: "medium",
		tools: ["read", "grep"],
		taskPreview: "Agent action state",
		transitions: [{ event: "DONE", target: "user" }],
	}),
	state("user", "pending", "user", {
		taskPreview: "User input action",
		transitions: [{ event: "SUBMIT", target: "script" }],
	}),
	state("script", "running", "script", {
		commandPreview: "python3 scripts/build.py --json",
		env: [
			{ name: "CI", type: "string", value: "true" },
			{ name: "RUN_DIR", type: "string", value: "runs/current" },
		],
		transitions: [{ event: "OK", target: "map" }],
	}),
	state("map", "running", "map", {
		concurrency: 2,
		subProgress: { done: 2, running: 1, failed: 1, total: 5 },
		mapConfig: {
			over: "plan.sections",
			as: "section",
			items: [
				{ key: "a", label: "A", summary: "finished", status: "done", state: "map#a" },
				{ key: "b", label: "B", summary: "active", status: "running", state: "map#b" },
				{ key: "c", label: "C", summary: "failed", status: "failed", state: "map#c" },
				{ key: "d", label: "D", summary: "waiting", status: "pending", state: "map#d" },
			],
		},
		transitions: [{ event: "MAP_DONE", target: "parallel" }],
	}),
	state("parallel", "running", "parallel", {
		concurrency: 3,
		parallelConfig: {
			count: 3,
			branches: [
				{ id: "research", agent: "scout", taskPreview: "Research" },
				{ id: "write", agent: "writer", taskPreview: "Write" },
				{ id: "review", agent: "reviewer", taskPreview: "Review" },
			],
		},
		transitions: [{ event: "onDone", target: "compound" }],
	}),
	state("compound", "pending", "compound", { transitions: [{ event: "ENTER", target: "final" }] }),
	state("final", "pending", "final", { final: true }),
]);

export const richCardsRun = run("rich-cards-running", "running", [
	state("inputs-and-refs", "pending", "agent", {
		agent: "reader",
		taskPrompt: "Use input + event + result + artifact refs to build a response.",
		inputs: [
			{
				name: "feedback",
				required: true,
				schema: { schemaName: "Feedback", schema: { type: "string", description: "Human feedback" } },
			},
			{
				name: "mode",
				required: false,
				defaulted: true,
				preview: "strict",
				schema: { schema: { type: "string", enum: ["fast", "strict"] } },
			},
		],
		refs: {
			arg: ["arg.topic"],
			result: ["plan.output"],
			artifact: ["research.sources"],
			input: ["input.feedback"],
			event: ["event.payload"],
			visit: ["visit()"],
			key: ["key()"],
			item: ["item()"],
		},
		reads: ["plan", "research"],
		onReenter: {
			mode: "resume",
			messagePreview: "Resume previous context with latest feedback",
			refs: { input: ["input.feedback"] },
		},
		transitions: [{ event: "DONE", target: "artifacts" }],
	}),
	state("artifacts", "done", "script", {
		commandPreview: "node scripts/render.mjs",
		artifacts: [
			{ name: "html", path: "dist/report.html" },
			{
				name: "data",
				path: "dist/data.json",
				schema: { schemaName: "ReportData", schema: { type: "object", properties: { title: { type: "string" } } } },
			},
		],
		replySchema: {
			schemaName: "RenderReply",
			schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
		},
		transitions: [{ event: "OK", target: "cache-policy" }],
	}),
	state("cache-policy", "running", "agent", {
		agent: "cached-worker",
		visits: 2,
		visitHistory: [
			{
				visit: 1,
				invokeSeqId: 14,
				startedAt: now - 190_000,
				endedAt: now - 130_000,
				status: "done",
				completedEvent: "BLOCK",
				inputs: { feedback: { instructions: ["Tighten the evidence chain", "Remove unsupported copy"] } },
				invocation: {
					kind: "agent",
					task: "Review the complete report against the evidence map and return a structured gate decision. This intentionally long resolved task demonstrates truncation and full-text inspection for a previous visit.",
				},
			},
			{
				visit: 2,
				invokeSeqId: 18,
				startedAt: now - 40_000,
				status: "running",
				inputs: { feedback: { instructions: ["Apply the gate feedback and re-check citations"] } },
				invocation: {
					kind: "agent",
					task: "Resume the report review with the latest feedback and verify every changed claim.",
					resumeMessage: "Continue the previous session with the updated gate feedback.",
				},
			},
		],
		validationAttempts: 1,
		retry: { max: 2 },
		transitions: [{ event: "BLOCK", target: "validation-rejected" }],
	}),
	state("validation-rejected", "failed", "agent", {
		agent: "reviewer",
		retry: { max: 2 },
		attempts: 2,
		validationAttempts: 2,
	}),
]);

export const mapVariantsRun = run("map-variants-running", "running", [
	state("map-empty", "pending", "map", {
		mapConfig: { over: "input.items", as: "item", items: [] },
		transitions: [{ event: "NEXT", target: "map-running" }],
	}),
	state("map-running", "running", "map", {
		concurrency: 3,
		subProgress: { done: 1, running: 2, failed: 0, total: 5 },
		mapConfig: {
			over: "chapters",
			as: "chapter",
			items: [
				{
					key: "one",
					label: "A deliberately long chapter title that must stay compact in the item header",
					status: "done",
					summary: [
						"A long summary used to verify bounded map previews.",
						"Keep the runtime panel compact.",
						"Preserve resolved input details.",
						"Avoid mounting the complete value initially.",
						"Show an explicit truncation marker.",
						"Keep the complete text available through Open full.",
					].join("\n"),
					value: {
						title: "A deliberately long chapter title that must stay compact in the item header",
						instructions:
							"Use the full evidence pack, preserve caveats, include citations, and provide enough additional text to exercise collapsed JSON rendering in the runtime inspector.",
					},
				},
				{ key: "two", label: "Two", status: "running" },
				{ key: "three", label: "Three", status: "running" },
				{ key: "four", label: "Four", status: "pending" },
			],
		},
		transitions: [{ event: "NEXT", target: "map-failed" }],
	}),
	state("map-failed", "failed", "map", {
		concurrency: 2,
		subProgress: { done: 2, running: 0, failed: 1, total: 4 },
		mapConfig: {
			over: "sections",
			as: "section",
			items: [
				{ key: "one", label: "One", status: "done" },
				{ key: "two", label: "Two", status: "done" },
				{ key: "three", label: "Three", status: "failed" },
				{ key: "four", label: "Four", status: "pending" },
			],
		},
		transitions: [{ event: "NEXT", target: "map-done" }],
	}),
	state("map-done", "done", "map", {
		concurrency: 4,
		subProgress: { done: 4, running: 0, failed: 0, total: 4 },
		mapConfig: {
			over: "cards",
			as: "card",
			items: [
				{ key: "a", label: "A", status: "done" },
				{ key: "b", label: "B", status: "done" },
				{ key: "c", label: "C", status: "done" },
				{ key: "d", label: "D", status: "done" },
			],
		},
	}),
]);

export const fanoutVariantsRun = run("fanout-variants-running", "running", [
	state("parallel-pending", "pending", "parallel", {
		parallelConfig: {
			count: 2,
			branches: [
				{ id: "left", taskPreview: "Left branch" },
				{ id: "right", taskPreview: "Right branch" },
			],
		},
		transitions: [{ event: "START", target: "parallel-running" }],
	}),
	state("parallel-running", "running", "parallel", {
		concurrency: 2,
		parallelConfig: {
			count: 4,
			branches: [
				{ id: "a", agent: "a" },
				{ id: "b", agent: "b" },
				{ id: "c", agent: "c" },
				{ id: "d", agent: "d" },
			],
		},
		subProgress: { done: 1, running: 2, failed: 0, total: 4 },
		transitions: [{ event: "onDone", target: "parallel-done" }],
	}),
	state("parallel-done", "done", "parallel", {
		parallelConfig: { count: 3, branches: [{ id: "a" }, { id: "b" }, { id: "c" }] },
	}),
]);

export const transitionEdgeRun = run("edge-transitions-running", "running", [
	state("start", "done", "agent", {
		transitions: [
			{ event: "A", target: "branch-a" },
			{ event: "B", target: "branch-b" },
		],
	}),
	state("branch-a", "done", "agent", { transitions: [{ event: "JOIN", target: "join" }] }),
	state("branch-b", "running", "script", {
		commandPreview: "npm test",
		transitions: [{ event: "JOIN", target: "join" }],
	}),
	state("join", "pending", "agent", {
		taskPreview: "Join/fan-in work",
		transitions: [
			{ event: "RETRY_BACK", target: "branch-a" },
			{ event: "DONE", target: "done" },
		],
	}),
	state("done", "pending", "final", { final: true }),
]);

export const stressRun = run(
	"hyperchart-stress-running",
	"running",
	[
		state("args", "done", "script", {
			commandPreview: "validate args",
			artifacts: [{ name: "args", path: "artifacts/args.json" }],
			transitions: [{ event: "VALID", target: "plan" }],
		}),
		state("plan", "done", "agent", {
			agent: "planner",
			taskPreview: "Plan all work",
			transitions: [{ event: "PLAN_READY", target: "parallel-research" }],
		}),
		state("parallel-research", "done", "parallel", {
			parallelConfig: { count: 3, branches: [{ id: "official" }, { id: "market" }, { id: "technical" }] },
			transitions: [{ event: "RESEARCH_DONE", target: "coverage-review" }],
		}),
		state("coverage-review", "done", "agent", {
			agent: "reviewer",
			taskPreview: "Validate source coverage",
			retry: { max: 2 },
			validationAttempts: 1,
			transitions: [
				{ event: "PASS", target: "chapter-map" },
				{ event: "BLOCK", target: "parallel-research" },
			],
		}),
		state("chapter-map", "running", "map", {
			concurrency: 3,
			subProgress: { done: 2, running: 1, failed: 0, total: 4 },
			mapConfig: {
				over: "plan.chapters",
				as: "chapter",
				items: [
					{ key: "intro", label: "Intro", status: "done" },
					{ key: "platform", label: "Platform", status: "done" },
					{ key: "risk", label: "Risk", status: "running" },
					{ key: "next", label: "Next", status: "pending" },
				],
			},
			transitions: [{ event: "MAP_DONE", target: "visual-review" }],
		}),
		state("visual-review", "pending", "agent", {
			agent: "visual-reviewer",
			taskPreview: "Review visual consistency",
			transitions: [
				{ event: "PASS", target: "render" },
				{ event: "BLOCK", target: "chapter-map" },
			],
		}),
		state("render", "pending", "script", {
			commandPreview: "python render_report.py",
			artifacts: [{ name: "html", path: "dist/report.html" }],
			transitions: [{ event: "RENDERED", target: "done" }],
		}),
		state("done", "pending", "final", { final: true }),
	],
	{ description: "Full stress graph with transitions, map worker, validation retry metadata, fanout, artifacts" },
);

export const allBoardRuns = [
	...runStripRuns,
	statusMatrixRun,
	stateKindsRun,
	richCardsRun,
	mapVariantsRun,
	fanoutVariantsRun,
	transitionEdgeRun,
	stressRun,
];
