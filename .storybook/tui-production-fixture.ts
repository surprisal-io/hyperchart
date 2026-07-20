import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import deckDirectorChart from "../packages/pi-hyperchart/examples/deck-director.chart.js";
import { normalizeChartConfig } from "@surprisal/hyperchart/internal/core/normalize";
import { actionUidKey } from "@surprisal/hyperchart/internal/core/action_uid";
import type { ActionUID, ChartAst, StateAst, StatePath } from "@surprisal/hyperchart/internal/core/types";
import type { DurableLogRecord } from "@surprisal/hyperchart/internal/core/durable_events";
import type {
	RunComponentOptions,
	RunHistoryItem,
} from "../packages/pi-hyperchart/src/tui/components.js";
import type {
	HyperchartSessionProgress,
	HyperchartSessionProgressFile,
} from "../packages/hyperchart/src/runtime/generic/session_progress.js";

const STORY_NOW = Date.UTC(2026, 6, 14, 12, 0, 0);
const RUNTIME_NOW = Date.now();

export type ProductionTuiFixture = {
	root: string;
	ast: ChartAst;
	primary: RunComponentOptions;
	manyRunning: RunComponentOptions;
	history: RunHistoryItem[];
};

const MANY_RUNNING_KEYS = [
	"official",
	"developer",
	"market",
	"community",
	"security",
	"standards",
	"funding",
	"benchmarks",
] as const;

function normalizeDeckDirector(): ChartAst {
	const parsed = normalizeChartConfig(deckDirectorChart, { path: "storybook:deck-director.chart.ts" });
	if (!parsed.ok) throw new Error(parsed.diagnostics.map((item) => item.message).join("\n"));
	return parsed.ast;
}

function templatePathFor(statePath: StatePath): StatePath {
	return statePath.replace(/#[^.]+(?=\.|$)/g, "") as StatePath;
}

function action(ast: ChartAst, statePath: StatePath): { uid: ActionUID; definition: Extract<StateAst, { kind: "state" }>["action"] } {
	const templatePath = templatePathFor(statePath);
	const state = ast.states[templatePath];
	if (state?.kind !== "state") throw new Error(`Missing action state ${templatePath}`);
	return { uid: { ...state.action.uid, state: statePath }, definition: state.action };
}

function deckLog(ast: ChartAst, variant: "single" | "many" = "single"): DurableLogRecord[] {
	let seq = 0;
	const records: DurableLogRecord[] = [];
	const push = (record: Record<string, unknown> & { type: DurableLogRecord["type"]; timestamp: number }) => {
		const parentId = seq === 0 ? null : seq;
		seq += 1;
		records.push({ ...record, seqId: seq, parentId } as DurableLogRecord);
	};
	push({
		type: "args",
		args: {
			topic: "Agentic developer tooling in 2026",
			audience: "engineering leaders",
			goal: "Choose an adoption strategy",
			style: "evidence-led analytical report",
			constraints: "official sources, explicit caveats, HTML output",
		},
		timestamp: RUNTIME_NOW - 720_000,
	});
	const keys = variant === "many" ? MANY_RUNNING_KEYS : (["official", "developer", "market"] as const);
	const buckets = Object.fromEntries(
		keys.map((key) => [key, { queries: [`${key} agent tooling evidence`], purpose: `${key} evidence`, required_sources: 3 }]),
	);
	const plan = action(ast, "plan");
	push({ type: "state_action", kind: "invoke", actionUid: plan.uid, definition: plan.definition, timestamp: RUNTIME_NOW - 700_000 });
	push({
		type: "state_action",
		kind: "complete",
		actionUid: plan.uid,
		event: {
			type: "PLAN_READY",
			output: {
				artifacts_dir: "artifacts/agentic-tooling-2026",
				buckets,
				coverage_thresholds: Object.fromEntries(keys.map((key) => [key, 3])),
			},
		},
		timestamp: RUNTIME_NOW - 650_000,
	});
	push({
		type: "spawned",
		path: "research",
		instances: Object.fromEntries(keys.map((key) => [key, { purpose: `${key} evidence` }])),
		timestamp: RUNTIME_NOW - 630_000,
	});
	if (variant === "many") {
		keys.forEach((key, index) => {
			const scout = action(ast, `research#${key}.scout` as StatePath);
			push({
				type: "state_action",
				kind: "invoke",
				actionUid: scout.uid,
				definition: scout.definition,
				timestamp: RUNTIME_NOW - 120_000 + index * 4_000,
			});
		});
		return records;
	}
	for (const [key, completedAt] of [
		["official", RUNTIME_NOW - 430_000],
		["developer", RUNTIME_NOW - 260_000],
	] as const) {
		const scout = action(ast, `research#${key}.scout` as StatePath);
		push({ type: "state_action", kind: "invoke", actionUid: scout.uid, definition: scout.definition, timestamp: completedAt - 110_000 });
		push({
			type: "state_action",
			kind: "complete",
			actionUid: scout.uid,
			event: { type: "SCOUTED", output: { bucket: key, sources: key === "official" ? 7 : 5 } },
			timestamp: completedAt,
		});
	}
	const market = action(ast, "research#market.scout");
	push({ type: "state_action", kind: "invoke", actionUid: market.uid, definition: market.definition, timestamp: RUNTIME_NOW - 95_000 });
	return records;
}

function transcript(name: string, task: string, summary: string, toolPath: string) {
	const sessionId = `00000000-0000-4000-8000-${Buffer.from(name).toString("hex").slice(0, 12).padEnd(12, "0")}`;
	const times = [0, 1, 2, 3, 4, 5].map((offset) => new Date(STORY_NOW - 120_000 + offset * 10_000).toISOString());
	return [
		{ type: "session", version: 3, id: sessionId, timestamp: times[0], cwd: "/Users/demo/Work/pi-hyperchart" },
		{ type: "model_change", id: "00000001", parentId: null, timestamp: times[1], provider: "anthropic", modelId: "claude-sonnet-4-5" },
		{ type: "thinking_level_change", id: "00000002", parentId: "00000001", timestamp: times[1], thinkingLevel: "high" },
		{
			type: "message",
			id: "00000003",
			parentId: "00000002",
			timestamp: times[2],
			message: { role: "user", content: [{ type: "text", text: task }], timestamp: STORY_NOW - 100_000 },
		},
		{
			type: "message",
			id: "00000004",
			parentId: "00000003",
			timestamp: times[3],
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "I’ll inspect the evidence fixture and validate source coverage." },
					{ type: "toolCall", id: `${name}-read`, name: "read", arguments: { path: toolPath } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: { input: 1240, output: 180, cacheRead: 0, cacheWrite: 0, totalTokens: 1420, cost: { input: 0.00372, output: 0.0027, cacheRead: 0, cacheWrite: 0, total: 0.00642 } },
				stopReason: "toolUse",
				timestamp: STORY_NOW - 90_000,
			},
		},
		{
			type: "message",
			id: "00000005",
			parentId: "00000004",
			timestamp: times[4],
			message: {
				role: "toolResult",
				toolCallId: `${name}-read`,
				toolName: "read",
				content: [{ type: "text", text: "Loaded 7 sourced evidence records with URLs, dates, and factual summaries." }],
				isError: false,
				timestamp: STORY_NOW - 80_000,
			},
		},
		{
			type: "message",
			id: "00000006",
			parentId: "00000005",
			timestamp: times[5],
			message: {
				role: "assistant",
				content: [{ type: "text", text: summary }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: { input: 1810, output: 220, cacheRead: 0, cacheWrite: 0, totalTokens: 2030, cost: { input: 0.00543, output: 0.0033, cacheRead: 0, cacheWrite: 0, total: 0.00873 } },
				stopReason: "stop",
				timestamp: STORY_NOW - 70_000,
			},
		},
	];
}

function writeJsonl(path: string, values: readonly unknown[]) {
	writeFileSync(path, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
}

function session(
	runDir: string,
	uid: ActionUID,
	options: {
		name: string;
		status: HyperchartSessionProgress["status"];
		startedAgo: number;
		completedAgo?: number;
		model: string;
		turns: number;
		tools: number;
		tokens: number;
		task: string;
		summary: string;
		currentTool?: string;
	},
): HyperchartSessionProgress {
	const key = actionUidKey(uid);
	const sessionDir = join(runDir, "sessions", key.replace(/[^a-zA-Z0-9._-]+/g, "_"));
	mkdirSync(sessionDir, { recursive: true });
	const sessionFile = join(sessionDir, "2026-07-14T11-58-00.000Z.jsonl");
	writeJsonl(sessionFile, transcript(options.name, options.task, options.summary, `artifacts/${options.name}.json`));
	return {
		actionKey: key,
		actionUid: uid,
		actionName: options.name,
		status: options.status,
		startedAt: RUNTIME_NOW - options.startedAgo,
		lastActivityAt: RUNTIME_NOW - 5_000,
		...(options.completedAgo === undefined ? {} : { completedAt: RUNTIME_NOW - options.completedAgo }),
		sessionFile,
		model: options.model,
		thinking: "high",
		turnCount: options.turns,
		toolCount: options.tools,
		tokenCount: options.tokens,
		...(options.currentTool === undefined
			? {}
			: {
					currentTool: options.currentTool,
					currentToolArgs: JSON.stringify({ query: "enterprise agent adoption 2026" }),
					currentToolStartedAt: RUNTIME_NOW - 18_000,
				}),
		lastMessage: options.summary,
	};
}

function writeRun(root: string, ast: ChartAst, variant: "running" | "many-running" | "stopped" | "stale") {
	const runId =
		variant === "running"
			? "deck-director-20260714-114800"
			: variant === "many-running"
				? "deck-director-20260714-115200"
				: variant === "stopped"
					? "deck-director-20260713-172100"
					: "deck-director-20260712-093000";
	const runDir = join(root, runId);
	mkdirSync(join(runDir, "sessions"), { recursive: true });
	writeJsonl(join(runDir, "log.jsonl"), deckLog(ast, variant === "many-running" ? "many" : "single"));
	writeFileSync(
		join(runDir, "meta.json"),
		`${JSON.stringify({ chartId: ast.id, chartPath: "packages/pi-hyperchart/examples/deck-director.chart.ts", workDir: "/Users/demo/Work/pi-hyperchart", createdAt: new Date(STORY_NOW - 720_000).toISOString() }, null, 2)}\n`,
	);
	writeFileSync(
		join(runDir, "status.json"),
		`${JSON.stringify({ version: 1, runId, runDir, chartId: ast.id, state: variant === "stale" ? "stopped" : variant === "many-running" ? "running" : variant, startedAt: STORY_NOW - 720_000, updatedAt: STORY_NOW - 5_000, ...(variant === "stale" ? { replayWarnings: ["Runner heartbeat expired; durable state remains resumable."] } : {}) }, null, 2)}\n`,
	);
	const planUid = action(ast, "plan").uid;
	const officialUid = action(ast, "research#official.scout").uid;
	const marketUid = action(ast, "research#market.scout").uid;
	const runningSessions = variant === "many-running"
		? MANY_RUNNING_KEYS.map((key, index) =>
				session(runDir, action(ast, `research#${key}.scout` as StatePath).uid, {
					name: `deck-source-scout-${key}`,
					status: "running",
					startedAgo: 120_000 - index * 4_000,
					model: index % 2 === 0 ? "anthropic/claude-sonnet-4-5" : "openai/gpt-5.2",
					turns: 2 + index,
					tools: 3 + index,
					tokens: 4_200 + index * 1_350,
					task: `Collect and verify ${key} evidence.`,
					summary: `Actively researching the ${key} evidence bucket.`,
					currentTool: ["web_search", "read", "browser", "grep"][index % 4]!,
				}),
			)
		: [];
	const sessions = [
		...runningSessions,
		...(variant === "many-running" ? [] : [session(runDir, marketUid, {
			name: "deck-source-scout",
			status: variant === "running" ? "running" : variant === "stopped" ? "cancelled" : "failed",
			startedAgo: 95_000,
			...(variant === "running" ? {} : { completedAgo: 35_000 }),
			model: "anthropic/claude-sonnet-4-5",
			turns: 5,
			tools: 9,
			tokens: 18_420,
			task: "Research enterprise adoption and risk signals for agentic developer tooling.",
			summary: variant === "stale" ? "Session stopped after losing its runner heartbeat; durable work can be resumed." : "Collected market evidence; validating the final two sources.",
			...(variant === "running" ? { currentTool: "web_search" } : {}),
		})]),
		...(variant === "many-running" ? [] : [session(runDir, officialUid, {
			name: "deck-source-scout",
			status: "completed",
			startedAgo: 540_000,
			completedAgo: 430_000,
			model: "anthropic/claude-sonnet-4-5",
			turns: 4,
			tools: 7,
			tokens: 13_806,
			task: "Collect official product and SDK announcements.",
			summary: "Verified seven official sources and wrote the normalized evidence artifact.",
		})]),
		session(runDir, planUid, {
			name: "deck-html-planner",
			status: "completed",
			startedAgo: 700_000,
			completedAgo: 650_000,
			model: "openai/gpt-5.2",
			turns: 3,
			tools: 2,
			tokens: 8_214,
			task: "Plan the evidence buckets and report argument.",
			summary: "Created three evidence buckets with explicit coverage thresholds.",
		}),
	];
	const progress: HyperchartSessionProgressFile = {
		version: 1,
		updatedAt: STORY_NOW - 5_000,
		sessions: Object.fromEntries(sessions.map((item) => [item.actionKey, item])),
	};
	writeFileSync(join(runDir, "sessions", "progress.json"), `${JSON.stringify(progress, null, 2)}\n`, "utf8");
	return { runId, runDir };
}

export function materializeProductionTuiFixture(): ProductionTuiFixture {
	const root = mkdtempSync(join(tmpdir(), `pi-hyperchart-storybook-tui-${process.pid}-`));
	const ast = normalizeDeckDirector();
	const running = writeRun(root, ast, "running");
	const manyRunning = writeRun(root, ast, "many-running");
	const stopped = writeRun(root, ast, "stopped");
	const stale = writeRun(root, ast, "stale");
	const history: RunHistoryItem[] = [
		{
			runId: running.runId,
			runDir: running.runDir,
			chartId: ast.id,
			state: "running",
			live: true,
			final: false,
			sessionCount: 3,
			createdAt: new Date(STORY_NOW - 720_000).toISOString(),
			updatedAt: new Date(STORY_NOW - 5_000).toISOString(),
		},
		{
			runId: stopped.runId,
			runDir: stopped.runDir,
			chartId: ast.id,
			state: "stopped",
			live: false,
			final: false,
			sessionCount: 3,
			createdAt: new Date(STORY_NOW - 86_400_000).toISOString(),
			updatedAt: new Date(STORY_NOW - 82_800_000).toISOString(),
		},
		{
			runId: stale.runId,
			runDir: stale.runDir,
			chartId: ast.id,
			state: "stopped",
			live: false,
			final: false,
			sessionCount: 3,
			createdAt: new Date(STORY_NOW - 172_800_000).toISOString(),
			updatedAt: new Date(STORY_NOW - 169_200_000).toISOString(),
		},
	];
	return {
		root,
		ast,
		primary: {
			runId: running.runId,
			runDir: running.runDir,
			logPath: join(running.runDir, "log.jsonl"),
			ast,
			live: true,
			cwd: "/Users/demo/Work/pi-hyperchart",
		},
		manyRunning: {
			runId: manyRunning.runId,
			runDir: manyRunning.runDir,
			logPath: join(manyRunning.runDir, "log.jsonl"),
			ast,
			live: true,
			cwd: "/Users/demo/Work/pi-hyperchart",
		},
		history,
	};
}

export function cleanupProductionTuiFixture(fixture: ProductionTuiFixture | undefined): void {
	if (fixture !== undefined) rmSync(fixture.root, { recursive: true, force: true });
}
