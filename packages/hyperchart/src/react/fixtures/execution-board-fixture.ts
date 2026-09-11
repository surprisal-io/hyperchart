import { z } from "zod";
import { actor, arg, agent, call, chart, compound, final, map, message, parallel, protocol, receive, reply, script, sendBatch, tsAction } from "../../core/dsl.js";
import type { DurableLogRecord } from "../../core/durable_events.js";
import { createMachine, type Effect, type MachineEvent } from "../../core/machine.js";
import { normalizeChartConfig } from "../../core/normalize.js";
import { createBranchProjection, projectBranch, type BranchProjection } from "../../core/projection.js";
import { explainReplay } from "../../core/replay_check.js";
import { loop } from "../../execution/execution_loop.js";
import { hyperchartRunFromRuntime } from "../../host/adapters.js";
import { inspectChartAst } from "../../core/inspect_ast.js";
import type { ChartAst } from "../../core/types.js";
import type { HyperchartRunInfo } from "../../host/models.js";
import type { Runtime } from "../../runtime/runtime.js";

const WorkerProtocol = protocol({
	WORK: message({
		input: z.object({ item: z.string() }).strict(),
		replies: { COMPLETED: z.object({ item: z.string(), accepted: z.boolean() }).strict() },
	}),
});
const Worker = actor({
	input: z.object({ role: z.string() }).strict(),
	protocol: WorkerProtocol,
	initial: "idle",
	states: {
		idle: receive({ on: { WORK: "process" } }),
		process: { kind: "state", action: agent("actor-worker", { task: "Process the accepted actor message." }), transitions: { DONE: "respond" } },
		respond: reply({ target: "idle", event: "COMPLETED", output: { item: "processed", accepted: true } }),
	},
});
const worker = Worker({ role: "execution-board-worker" });

const cst = chart({
	kind: "chart",
	id: "storybook-complete-execution",
	args: {
		items: { default: { alpha: { value: 1 }, beta: { value: 2 }, gamma: { value: 3 }, delta: { value: 4 } } },
	},
	actors: { worker },
	initial: "plan",
	states: {
		plan: { kind: "state", action: agent("planner", { task: "Plan the execution." }), transitions: { DONE: "prepare" } },
		prepare: { kind: "state", action: script("node", ["scripts/prepare.mjs"]), transitions: { DONE: "score" } },
		score: { kind: "state", action: tsAction("./actions/score.ts", "score"), transitions: { DONE: "fanout" } },
		fanout: parallel({
			states: {
				research: compound({
					initial: "collect",
					states: {
						collect: { kind: "state", action: agent("parallel-researcher", { task: "Collect evidence in parallel." }), transitions: { DONE: "summarize" } },
						summarize: { kind: "state", action: script("node", ["scripts/summarize.mjs"]), transitions: { DONE: "done" } },
						done: final(),
					},
				}),
				evaluation: compound({
					initial: "measure",
					states: {
						measure: { kind: "state", action: tsAction("./actions/measure.ts", "measure"), transitions: { DONE: "review" } },
						review: { kind: "state", action: agent("parallel-reviewer", { task: "Review metrics in parallel." }), transitions: { DONE: "done" } },
						done: final(),
					},
				}),
			},
			onDone: "workers",
		}),
		workers: map({
			over: arg("items"),
			concurrency: 4,
			initial: "research",
			onDone: "dispatch",
			states: {
				research: { kind: "state", action: agent("researcher", { task: "Research this map item." }), transitions: { DONE: "transform" } },
				transform: { kind: "state", action: script("node", ["scripts/transform.mjs"]), transitions: { DONE: "evaluate" } },
				evaluate: { kind: "state", action: tsAction("./actions/evaluate.ts", "evaluate"), transitions: { DONE: "done" } },
				done: final(),
			},
		}),
		dispatch: sendBatch({
			to: worker,
			event: "WORK",
			inputs: [{ item: "alpha" }, { item: "beta" }],
			target: "request",
		}),
		request: call({
			to: worker,
			event: "WORK",
			input: { item: "final" },
			transitions: { COMPLETED: "publish" },
		}),
		publish: { kind: "state", action: agent("publisher", { task: "Publish the final result." }), transitions: { DONE: "done" } },
		done: final(),
	},
});

class CaptureComplete extends Error {}

class ExecutionBoardRuntime implements Runtime {
	readonly branchId = "main";
	readonly records: DurableLogRecord[] = [];
	readonly projection: BranchProjection;
	private readonly queued: MachineEvent[] = [];
	private readonly waiters: Array<() => void> = [];
	private seqId = 0;

	constructor(readonly ast: ChartAst) {
		this.projection = createBranchProjection(ast);
	}

	async loadAst() { return this.ast; }
	async loadProjection() { return this.projection; }

	async runEffects(effects: Effect[]) {
		for (const effect of effects) {
			switch (effect.kind) {
				case "durable_records": {
					const records = effect.records.map((draft): DurableLogRecord => ({
						...draft,
						seqId: ++this.seqId,
						parentId: this.seqId === 1 ? null : this.seqId - 1,
						branchId: "main",
						timestamp: 1_700_200_000_000 + this.seqId * 1_000,
					}) as DurableLogRecord);
					this.records.push(...records);
					if (effect.id === "args") projectBranch(this.projection, this.ast, records);
					if (records.some((record) => record.type === "state_action" && record.kind === "invoke" && record.actionUid.state === "publish")) throw new CaptureComplete();
					this.push({ kind: "durable_records_added", effectId: effect.id, records });
					break;
				}
				case "agent":
					this.push({ kind: "agent", effectId: effect.id, outcome: { kind: "completed", event: { type: "DONE" } } });
					break;
				case "script":
					this.push({ kind: "script", effectId: effect.id, event: { type: "DONE" } });
					break;
				case "tsImport":
					this.push({ kind: "tsImport", effectId: effect.id, event: { type: "DONE" } });
					break;
				case "actor_create":
				case "actor_enqueue":
				case "actor_reply":
					this.push({
						kind: "actor_effect",
						effectId: effect.id,
						operation: effect.kind === "actor_create" ? "create" : effect.kind === "actor_enqueue" ? "enqueue" : "reply",
						ok: true,
					});
					break;
				case "cancel":
					break;
				default:
					throw new Error(`Unexpected execution-board effect ${effect.kind}`);
			}
		}
	}

	async *eventsQueue(): AsyncIterable<MachineEvent> {
		while (true) {
			if (this.queued.length === 0) await new Promise<void>((resolve) => this.waiters.push(resolve));
			const event = this.queued.shift();
			if (event !== undefined) yield event;
		}
	}

	private push(event: MachineEvent) {
		this.queued.push(event);
		this.waiters.shift()?.();
	}
}

let capturedRun: Promise<HyperchartRunInfo> | undefined;

export function captureExecutionBoardRun(): Promise<HyperchartRunInfo> {
	capturedRun ??= capture();
	return capturedRun;
}

async function capture(): Promise<HyperchartRunInfo> {
	const normalized = normalizeChartConfig(cst, { path: "storybook:complete-execution" });
	if (!normalized.ok) throw new Error(normalized.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	const runtime = new ExecutionBoardRuntime(normalized.ast);
	await runtime.runEffects([{ kind: "durable_records", id: "args", records: [{ type: "args", args: { items: { alpha: { value: 1 }, beta: { value: 2 }, gamma: { value: 3 }, delta: { value: 4 } } } }] }]);
	const semantic = { machineState: () => createMachine(normalized.ast, structuredClone(runtime.projection)) };
	try {
		await loop(runtime, semantic);
	} catch (error) {
		if (!(error instanceof CaptureComplete)) throw error;
	}
	const replay = explainReplay(normalized.ast, runtime.records);
	if (replay.broken !== undefined || replay.prefixEnd !== runtime.records.length || replay.skipped.length > 0 || replay.stale.length > 0) {
		throw new Error(`Execution board failed replay validation: ${JSON.stringify(replay)}`);
	}
	return hyperchartRunFromRuntime(inspectChartAst(normalized.ast, { chartPath: "storybook:complete-execution" }), normalized.ast, runtime.records, {
		runId: "storybook:complete-execution",
		status: {
			runId: "storybook:complete-execution",
			chartId: normalized.ast.id,
			state: "running",
			startedAt: 1_700_200_000_000,
			updatedAt: 1_700_200_100_000,
		},
		cwd: "/storybook/executed-fixture",
		createdAt: 1_700_200_000_000,
		updatedAt: 1_700_200_100_000,
	});
}
