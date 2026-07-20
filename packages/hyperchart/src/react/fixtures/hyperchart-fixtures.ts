import type { HyperchartRunInfo } from "../types.js";

const FIXTURE_NOW = Date.UTC(2026, 6, 7, 22, 45, 0);
const now = FIXTURE_NOW;

export const runningRun: HyperchartRunInfo = {
	runId: "deck-director-20260707-224500",
	chartName: "deck-director",
	description: "Google I/O 2026 announcement narrative deck",
	status: "running",
	cwd: "/Users/demo/Work/pi-hyperchart",
	createdAt: now - 900_000,
	updatedAt: now - 8_000,
	pid: 42420,
	args: { topic: "Google I/O 2026: most important recent announcements", audience: "executives" },
	stateCount: 13,
	states: [
		{
			id: "research-plan",
			type: "agent",
			agent: "deck-source-scout",
			status: "done",
			model: "deepseek/deepseek-v4-pro",
			taskPreview: "Create a report plan and source buckets.",
			transitions: [{ event: "PLAN_READY", target: "source-research" }],
			artifacts: [{ name: "plan", path: "artifacts/report-plan.json", schema: { schemaName: "ReportPlan" } }],
		},
		{
			id: "source-research",
			type: "parallel",
			status: "done",
			parallelConfig: {
				count: 3,
				branches: [
					{ id: "official", agent: "deck-source-scout", taskPreview: "Official Google sources" },
					{ id: "market", agent: "deck-source-scout", taskPreview: "Market/financial analysis" },
					{ id: "developer", agent: "deck-source-scout", taskPreview: "Developer impact" },
				],
			},
			transitions: [{ event: "RESEARCH_DONE", target: "coverage-review" }],
		},
		{
			id: "coverage-review",
			type: "agent",
			agent: "deck-beat-verifier",
			status: "done",
			taskPreview: "Validate source coverage and citation density.",
			retry: { max: 2 },
			transitions: [
				{ event: "PASS", target: "narrative-plan" },
				{ event: "BLOCK", target: "source-research" },
			],
		},
		{
			id: "narrative-plan",
			type: "agent",
			agent: "deck-narrative-synthesizer",
			status: "done",
			reads: ["research-plan", "source-research"],
			taskPrompt: "Synthesize verified research into narrative beats with evidence refs.",
			transitions: [{ event: "NARRATIVE_READY", target: "chapter-production" }],
		},
		{
			id: "chapter-production",
			type: "map",
			status: "running",
			concurrency: 3,
			mapConfig: {
				over: "narrative-plan.chapters",
				as: "chapter",
				items: [
					{
						key: "sec-platform",
						label: "Platform numbers",
						status: "done",
						summary: "Cloud, Gemini, Android, AI Overviews scale.",
					},
					{
						key: "sec-products",
						label: "Product announcements",
						status: "running",
						summary: "Gemini app, agents, Android XR.",
					},
					{
						key: "sec-recommendations",
						label: "Recommendations",
						status: "pending",
						summary: "What leaders should do next.",
					},
				],
			},
			subProgress: { done: 1, running: 1, failed: 0, total: 3 },
			transitions: [{ event: "MAP_DONE", target: "visual-review" }],
		},
		{
			id: "chapter-production#sec-platform.write-copy",
			type: "agent",
			agent: "deck-chapter-author",
			status: "done",
			mapKey: "sec-platform",
			reads: ["narrative-plan"],
			visits: 1,
		},
		{
			id: "chapter-production#sec-products.design-elements",
			type: "agent",
			agent: "deck-interaction-designer",
			status: "running",
			mapKey: "sec-products",
			model: "openrouter/z-ai/glm-5.2",
		},
		{
			id: "visual-review",
			type: "agent",
			agent: "deck-vision-scout",
			status: "pending",
			taskPreview: "Check visual consistency, unsupported numbers, and data refs.",
			retry: { max: 1 },
		},
		{
			id: "render-report",
			type: "script",
			status: "pending",
			commandPreview: "python3 render_report.py",
			artifacts: [{ name: "html", path: "dist/report.html" }],
		},
		{
			id: "done",
			type: "final",
			status: "pending",
			final: true,
		},
	],
};

export const failedRun: HyperchartRunInfo = {
	...runningRun,
	runId: "deck-director-20260706-234626",
	status: "failed",
	updatedAt: now - 2_400_000,
	states: runningRun.states.map((state) =>
		state.id === "visual-review"
			? {
					...state,
					status: "failed",
				}
			: state.id === "chapter-production"
				? { ...state, status: "done", subProgress: { done: 3, running: 0, failed: 0, total: 3 } }
				: state,
	),
};

const { pid: _runningPid, ...runningRunWithoutPid } = runningRun;

export const inspectRun: HyperchartRunInfo = {
	...runningRunWithoutPid,
	runId: "inspect:deck-director",
	status: "paused",
	updatedAt: now,
	states: runningRun.states.map((state) => {
		const { subProgress, ...rest } = state;
		return {
			...rest,
			status: state.final ? "done" : "pending",
			...(state.type === "map"
				? { subProgress: { done: 0, running: 0, failed: 0, total: 3 } }
				: subProgress === undefined
					? {}
					: { subProgress }),
		};
	}),
};

export const allRuns = [runningRun, failedRun, inspectRun];
