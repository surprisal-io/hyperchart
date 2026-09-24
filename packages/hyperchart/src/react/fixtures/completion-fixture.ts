import { z } from "zod";
import {
	actor,
	agent,
	completion,
	final,
	message,
	messageInput,
	notify,
	protocol,
	receive,
	reply,
	send,
	waitFor,
} from "../../core/dsl.js";
import { refs } from "../../core/typed.js";
import type { DurableLogRecord } from "../../core/durable_events.js";
import type { ChartCst } from "../../core/types.js";
import { createMachine, type Effect, type MachineEvent } from "../../core/machine.js";
import { createBranchProjection, projectBranch } from "../../core/projection.js";
import { loop } from "../../execution/execution_loop.js";
import type { HyperchartRunInfo } from "../../host/models.js";
import type { Runtime } from "../../runtime/runtime.js";
import { storyScenario } from "./story-scenario.js";

const Work = protocol({ START: message({ input: z.object({ value: z.string() }).strict() }) });
const bound = refs<
	Record<never, never>,
	{ wait: { value: string } },
	Record<never, never>,
	Record<never, never>,
	Record<never, Record<string, unknown>>,
	{ worker: typeof Work },
	{ done: { event: "DONE"; payload: { value: string } } }
>();
const workerRef = bound.actorRef("worker");
const doneRef = bound.completionRef("done");
const Worker = actor({
	input: z.object({}).strict(),
	protocol: Work,
	initial: "idle",
	states: {
		idle: receive({ on: { START: "publish" } }),
		publish: notify({
			to: doneRef,
			event: "DONE",
			payload: { value: messageInput("START", "value") },
			target: "settle",
		}),
		settle: reply({ target: "idle" }),
	},
});
const worker = Worker({});
export const completionStoryChart: ChartCst = bound.chart({
	kind: "chart",
	id: "storybook-chart-completion",
	completions: { done: completion({ event: "DONE", schema: z.object({ value: z.string() }).strict() }) },
	actors: { worker },
	initial: "dispatch",
	states: {
		dispatch: send({ to: workerRef, event: "START", input: { value: "from worker" }, target: "delay" }),
		delay: { kind: "state", action: agent("release-controller"), transitions: { RELEASE: "wait" } },
		wait: waitFor({ from: doneRef, event: "DONE", target: "done" }),
		done: final(),
	},
});
export const completionScenario = storyScenario(completionStoryChart);

class SnapshotReached extends Error {}
type Snapshot = "notification-retained" | "waiting" | "consumed" | "notify-in-flight" | "notify-failed";
class CompletionStoryRuntime implements Runtime {
	readonly branchId = "main";
	readonly records: DurableLogRecord[] = [];
	private readonly queued: MachineEvent[] = [];
	private readonly waiters: Array<() => void> = [];
	private seqId = 0;
	// A live pending visit should not display years of elapsed time in Storybook.
	private readonly startedAt = Date.now() - 30_000;
	constructor(private readonly snapshot: Snapshot) {}

	async runEffects(effects: Effect[]) {
		for (const effect of effects) {
			switch (effect.kind) {
				case "durable_records": {
					const added = effect.records.map(
						(draft): DurableLogRecord =>
							({
								...draft,
								seqId: ++this.seqId,
								parentId: this.seqId === 1 ? null : this.seqId - 1,
								branchId: this.branchId,
								timestamp: this.startedAt + this.seqId * 1_000,
							}) as DurableLogRecord,
					);
					this.records.push(...added);
					const reached =
						this.snapshot === "notification-retained"
							? added.some((record) => record.type === "completion" && record.kind === "notified")
							: this.snapshot === "waiting"
								? added.some(
										(record) =>
											record.type === "state_action" && record.kind === "invoke" && record.actionUid.state === "wait",
									)
								: this.snapshot === "notify-in-flight"
									? added.some(
											(record) =>
												record.type === "state_action" &&
												record.kind === "invoke" &&
												record.actionUid.state === "@worker.publish",
										)
									: this.snapshot === "notify-failed"
										? added.some((record) => record.type === "failure_intent")
										: added.some((record) => record.type === "completion" && record.kind === "consumed");
					if (reached) {
						throw new SnapshotReached();
					}
					this.push({ kind: "durable_records_added", effectId: effect.id, records: added });
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
				case "completion_notify":
					this.push({
						kind: "completion_effect",
						effectId: effect.id,
						operation: "notify",
						ok: this.snapshot !== "notify-failed",
						...(this.snapshot === "notify-failed" ? { error: "Notification delivery failed" } : {}),
					});
					break;
				case "agent":
					if (this.snapshot !== "notification-retained") {
						this.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "RELEASE" } },
						});
					}
					break;
				case "cancel":
					break;
				default:
					throw new Error(`Unexpected completion story effect ${effect.kind}`);
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

const cache = new Map<Snapshot, Promise<HyperchartRunInfo>>();
export function captureCompletionStory(snapshot: Snapshot): Promise<HyperchartRunInfo> {
	const cached = cache.get(snapshot);
	if (cached !== undefined) {
		return cached;
	}
	const pending = capture(snapshot);
	cache.set(snapshot, pending);
	return pending;
}
async function capture(snapshot: Snapshot): Promise<HyperchartRunInfo> {
	const ast = completionScenario.ast;
	const runtime = new CompletionStoryRuntime(snapshot);
	await runtime.runEffects([{ kind: "durable_records", id: "args", records: [{ type: "args", args: {} }] }]);
	const projection = projectBranch(createBranchProjection(ast), ast, runtime.records);
	try {
		await loop(runtime, { machineState: () => createMachine(ast, projection) });
	} catch (error) {
		if (!(error instanceof SnapshotReached)) {
			throw error;
		}
	}
	return completionScenario.runtimeRun(runtime.records, {
		runId: `completion:${snapshot}`,
		status: { state: snapshot === "consumed" ? "complete" : snapshot === "notify-failed" ? "failed" : "running" },
		cwd: "/storybook/completion",
		createdAt: runtime.records[0]?.timestamp ?? Date.now(),
		updatedAt: runtime.records.at(-1)?.timestamp ?? Date.now(),
	});
}
