import { z } from "zod";
import {
	actor,
	actorPool,
	agent,
	call,
	callBatch,
	chart,
	final,
	json,
	message,
	messageInput,
	protocol,
	receive,
	reply,
	t,
} from "../../core/dsl.js";
import { refs } from "../../core/typed.js";
import type { DurableLogRecord } from "../../core/durable_events.js";
import { createMachine, type Effect, type MachineEvent } from "../../core/machine.js";
import { createBranchProjection, projectBranch } from "../../core/projection.js";
import { loop } from "../../execution/execution_loop.js";
import type { HyperchartRunInfo } from "../../host/models.js";
import type { Runtime } from "../../runtime/runtime.js";
import { storyScenario } from "./story-scenario.js";

const Work = protocol({
	WORK: message({ input: z.object({ id: z.number() }).strict(), reply: z.object({ id: z.number() }).strict() }),
});
const typed = refs<Record<never, never>, { batch: { id: number }[] }>();
const Worker = actor({
	input: z.object({}).strict(),
	protocol: Work,
	initial: "idle",
	states: {
		idle: receive({ on: { WORK: "settle" } }),
		settle: reply({ target: "idle", output: { id: messageInput("WORK", "id") } }),
	},
});
const workers = actorPool({ concurrency: 2, worker: Worker })({});
const singleton = Worker({});
export const singletonCallScenario = storyScenario(
	chart({
		kind: "chart",
		id: "storybook-singleton-call-result",
		actors: { singleton },
		initial: "request",
		states: {
			request: call({ to: singleton, event: "WORK", input: { id: 1 }, target: "done" }),
			done: final(),
		},
	}),
);
export const callBatchResultScenario = storyScenario(
	typed.chart({
		kind: "chart",
		id: "storybook-call-batch-result",
		actors: { workers },
		initial: "batch",
		states: {
			batch: callBatch({ to: workers, event: "WORK", inputs: [{ id: 1 }, { id: 0 }], target: "use" }),
			use: {
				kind: "state",
				action: agent("batch-reader", { task: t`Ordered replies: ${json(typed.result("batch"))}` }),
				transitions: { DONE: "done" },
			},
			done: final(),
		},
	}),
);

class BatchStoryRuntime implements Runtime {
	readonly branchId = "main";
	readonly records: DurableLogRecord[] = [];
	private readonly queued: MachineEvent[] = [];
	private readonly waiters: Array<() => void> = [];
	private seqId = 0;
	async runEffects(effects: Effect[]) {
		for (const effect of effects) {
			switch (effect.kind) {
				case "durable_records": {
					const records = effect.records.map(
						(draft): DurableLogRecord =>
							({
								...draft,
								seqId: ++this.seqId,
								parentId: this.seqId === 1 ? null : this.seqId - 1,
								branchId: this.branchId,
								timestamp: 1_700_400_000_000 + this.seqId * 1_000,
							}) as DurableLogRecord,
					);
					this.records.push(...records);
					this.push({ kind: "durable_records_added", effectId: effect.id, records });
					break;
				}
				case "actor_create":
				case "actor_enqueue":
				case "actor_reply":
					this.push({
						kind: "actor_effect",
						effectId: effect.id,
						operation:
							effect.kind === "actor_create" ? "create" : effect.kind === "actor_enqueue" ? "enqueue" : "reply",
						ok: true,
					});
					break;
				case "agent":
					this.push({ kind: "agent", effectId: effect.id, outcome: { kind: "completed", event: { type: "DONE" } } });
					break;
				case "cancel":
					break;
				default:
					throw new Error(`Unexpected batch-result story effect ${effect.kind}`);
			}
		}
	}
	async *eventsQueue(): AsyncIterable<MachineEvent> {
		while (true) {
			if (this.queued.length === 0) {
				await new Promise<void>((resolve) => this.waiters.push(resolve));
			}
			const next = this.queued.shift();
			if (next !== undefined) {
				yield next;
			}
		}
	}
	private push(event: MachineEvent) {
		this.queued.push(event);
		this.waiters.shift()?.();
	}
}
async function capture(scenario: typeof callBatchResultScenario, runId: string): Promise<HyperchartRunInfo> {
	const ast = scenario.ast;
	const runtime = new BatchStoryRuntime();
	await runtime.runEffects([{ kind: "durable_records", id: "args", records: [{ type: "args", args: {} }] }]);
	const projection = projectBranch(createBranchProjection(ast), ast, runtime.records);
	await loop(runtime, { machineState: () => createMachine(ast, projection) });
	return scenario.runtimeRun(runtime.records, {
		runId,
		status: { state: "complete" },
		cwd: "/storybook/actor-call",
		createdAt: 1_700_400_000_000,
		updatedAt: 1_700_400_100_000,
	});
}
let capturedBatch: Promise<HyperchartRunInfo> | undefined;
let capturedSingleton: Promise<HyperchartRunInfo> | undefined;
export function captureCallBatchResultStory(): Promise<HyperchartRunInfo> {
	capturedBatch ??= capture(callBatchResultScenario, "batch:ordered-result");
	return capturedBatch;
}
export function captureSingletonCallStory(): Promise<HyperchartRunInfo> {
	capturedSingleton ??= capture(singletonCallScenario, "actor:single-call-complete");
	return capturedSingleton;
}
