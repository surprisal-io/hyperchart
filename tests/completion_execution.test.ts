import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
	actor,
	actorPool,
	agent,
	chart,
	completion,
	createBranchProjection,
	final,
	message,
	messageInput,
	inspectChartAst,
	normalizeChartConfig,
	notify,
	projectBranch,
	protocol,
	receive,
	refs,
	reply,
	send,
	sendBatch,
	stepMachine,
	waitFor,
	z,
	type DurableLogRecord,
	type Effect,
	type MachineEvent,
	type Runtime,
} from "../packages/hyperchart/src/index.js";
import { createAsyncQueue } from "../packages/hyperchart/src/utils/async_queue.js";
import { start } from "./helpers/execution.js";

const WorkProtocol = protocol({
	START: message({ input: z.object({ value: z.string() }).strict() }),
});

type Results = { wait: { value: string } };
type Actors = { worker: typeof WorkProtocol };
type Completions = { done: { event: "DONE"; payload: { value: string } } };

function authoredCompletionChart(
	options: { delay?: boolean; duplicate?: boolean; reuseWait?: boolean; concurrent?: boolean } = {},
) {
	const typed = refs<
		Record<string, never>,
		Results,
		Record<string, never>,
		Record<string, never>,
		Record<never, Record<string, unknown>>,
		Actors,
		Completions
	>();
	const workerRef = typed.actorRef("worker");
	const doneRef = typed.completionRef("done");
	const Worker = actor({
		input: z.object({}).strict(),
		protocol: WorkProtocol,
		initial: "idle",
		states: {
			idle: receive({ on: { START: "publish" } }),
			publish: notify({
				to: doneRef,
				event: "DONE",
				payload: { value: messageInput("START", "value") },
				target: options.duplicate === true ? "publishAgain" : "settle",
			}),
			...(options.duplicate === true
				? {
						publishAgain: notify({
							to: doneRef,
							event: "DONE",
							payload: { value: messageInput("START", "value") },
							target: "settle",
						}),
					}
				: {}),
			settle: reply({ target: "idle" }),
		},
	});
	const worker =
		options.concurrent === true ? actorPool({ concurrency: 2, worker: Worker })({}) : Worker({});
	const wait = waitFor({ from: doneRef, event: "DONE", target: options.reuseWait === true ? "wait" : "complete" });
	const authored = typed.chart({
		kind: "chart",
		id: "completion-test",
		completions: {
			done: completion({ event: "DONE", schema: z.object({ value: z.string() }).strict() }),
		},
		actors: { worker },
		initial: "start",
		states: {
			start:
				options.concurrent === true
					? sendBatch({
							to: workerRef,
							event: "START",
							inputs: [{ value: "ready" }, { value: "duplicate" }],
							target: "wait",
						})
					: send({
							to: workerRef,
							event: "START",
							input: { value: "ready" },
							target: options.delay === true ? "delay" : "wait",
						}),
			...(options.delay === true
				? {
						delay: { kind: "state" as const, action: agent("hold"), transitions: { RELEASE: "wait" } },
					}
				: {}),
			wait,
			complete: final(),
		},
	});
	return authored;
}

function completionChart(
	options: { delay?: boolean; duplicate?: boolean; reuseWait?: boolean; concurrent?: boolean } = {},
) {
	const normalized = normalizeChartConfig(authoredCompletionChart(options));
	assert.equal(normalized.ok, true, normalized.ok ? undefined : JSON.stringify(normalized.diagnostics));
	return normalized.ast;
}

class CompletionRuntime implements Runtime {
	readonly branchId = "main";
	readonly records: DurableLogRecord[] = [];
	readonly queue = createAsyncQueue<MachineEvent>();
	readonly effectsSeen: Effect[] = [];
	notificationAppendHeld = false;
	private releaseNotificationAppend: (() => void) | undefined;
	constructor(
		readonly ast: ReturnType<typeof completionChart>,
		readonly completionValid = true,
		readonly releaseImmediately = true,
		private readonly holdNotificationAppend = false,
		private readonly respondToCompletion = true,
	) {}

	releaseHeldNotificationAppend(): void {
		this.releaseNotificationAppend?.();
		this.releaseNotificationAppend = undefined;
	}

	async runEffects(effects: Effect[]): Promise<void> {
		this.effectsSeen.push(...effects);
		for (const effect of effects) {
			if (effect.kind === "durable_records") {
				if (
					this.holdNotificationAppend &&
					!this.notificationAppendHeld &&
					effect.records.some((record) => record.type === "completion" && record.kind === "notified")
				) {
					this.notificationAppendHeld = true;
					await new Promise<void>((resolve) => {
						this.releaseNotificationAppend = resolve;
					});
				}
				let seqId = this.records.at(-1)?.seqId ?? 0;
				let parentId = seqId === 0 ? null : seqId;
				const records = effect.records.map((draft) => {
					const record = {
						...draft,
						seqId: ++seqId,
						parentId,
						branchId: this.branchId,
						timestamp: Date.now(),
					} as DurableLogRecord;
					parentId = record.seqId;
					return record;
				});
				this.records.push(...records);
				this.queue.send({ kind: "durable_records_added", effectId: effect.id, records });
			} else if (effect.kind === "actor_create") {
				this.queue.send({ kind: "actor_effect", effectId: effect.id, operation: "create", ok: true });
			} else if (effect.kind === "actor_enqueue") {
				this.queue.send({ kind: "actor_effect", effectId: effect.id, operation: "enqueue", ok: true });
			} else if (effect.kind === "actor_reply") {
				this.queue.send({ kind: "actor_effect", effectId: effect.id, operation: "reply", ok: true });
			} else if (effect.kind === "completion_notify" && this.respondToCompletion) {
				this.queue.send({
					kind: "completion_effect",
					effectId: effect.id,
					operation: "notify",
					ok: this.completionValid,
					...(this.completionValid ? {} : { error: "Completion payload does not match exact endpoint schema" }),
				});
			} else if (effect.kind === "agent" && this.releaseImmediately) {
				this.queue.send({
					kind: "agent",
					effectId: effect.id,
					outcome: { kind: "completed", event: { type: "RELEASE" } },
				});
			}
		}
	}

	eventsQueue() {
		return this.queue;
	}
	async loadAst() {
		return this.ast;
	}
	async loadProjection() {
		return projectBranch(createBranchProjection(this.ast), this.ast, this.records);
	}
	async loadLogs() {
		return this.records;
	}
}

async function eventually(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition was not reached");
}

describe("durable chart-owned completion endpoints", () => {
	it("atomically records notification and consumption and completes the waiting chart", async () => {
		const runtime = new CompletionRuntime(completionChart());
		const inspected = inspectChartAst(runtime.ast);
		expect(inspected.completionDeclarations).toEqual([
			{ name: "done", event: "DONE", schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } },
		]);
		expect(inspected.states.some((item) => item.id === "wait" && item.kind === "waitFor")).toBe(true);
		expect(inspected.states.some((item) => item.id === "@worker.publish" && item.kind === "notify")).toBe(true);
		const state = await start(runtime);
		expect(state.projection.activeLeaves).toEqual(["complete"]);
		const completionRecords = runtime.records.filter((record) => record.type === "completion");
		expect(completionRecords.map((record) => record.kind)).toEqual(["notified", "consumed"]);
		expect(state.projection.results.wait).toEqual({ value: "ready" });
		const notified = completionRecords[0]!;
		const notifyComplete = runtime.records[notified.seqId];
		expect(notifyComplete?.type).toBe("state_action");
		expect(notifyComplete?.parentId).toBe(notified.seqId);
		const consumed = completionRecords[1]!;
		const waitComplete = runtime.records[consumed.seqId];
		expect(waitComplete?.type).toBe("state_action");
		expect(waitComplete?.parentId).toBe(consumed.seqId);

		const replayed = projectBranch(createBranchProjection(runtime.ast), runtime.ast, runtime.records);
		expect(replayed.results.wait).toEqual({ value: "ready" });
		expect(replayed.completions.done?.consumed?.actionUid.state).toBe("wait");
		const duplicate = {
			...notified,
			seqId: runtime.records.length + 1,
			parentId: runtime.records.at(-1)?.seqId ?? null,
		} as DurableLogRecord;
		expect(() => projectBranch(createBranchProjection(runtime.ast), runtime.ast, [...runtime.records, duplicate])).toThrow(
			/notified more than once/,
		);
	});

	it("retains a notification that arrives before the chart enters waitFor", async () => {
		const runtime = new CompletionRuntime(completionChart({ delay: true }), true, false);
		const running = start(runtime);
		await eventually(() => runtime.records.some((record) => record.type === "completion" && record.kind === "notified"));
		expect(runtime.records.some((record) => record.type === "completion" && record.kind === "consumed")).toBe(false);
		const delay = runtime.effectsSeen.find((effect) => effect.kind === "agent");
		assert(delay?.kind === "agent");
		runtime.queue.send({
			kind: "agent",
			effectId: delay.id,
			outcome: { kind: "completed", event: { type: "RELEASE" } },
		});
		const state = await running;
		expect(state.projection.activeLeaves).toEqual(["complete"]);
		expect(state.projection.results.wait).toEqual({ value: "ready" });
	});

	it("rejects cloned bindings, unknown endpoints, forged refs, and refs embedded in payload data", () => {
		const cloned = { ...authoredCompletionChart() };
		const clonedResult = normalizeChartConfig(cloned);
		expect(clonedResult.ok).toBe(false);
		if (!clonedResult.ok) expect(clonedResult.diagnostics.some((row) => row.code === "UNBOUND_COMPLETION_REF")).toBe(true);

		const unknown = authoredCompletionChart();
		Reflect.deleteProperty(unknown.completions, "done");
		const unknownResult = normalizeChartConfig(unknown);
		expect(unknownResult.ok).toBe(false);
		if (!unknownResult.ok) expect(unknownResult.diagnostics.some((row) => row.code === "UNKNOWN_COMPLETION_REF")).toBe(true);

		const forged = authoredCompletionChart();
		Reflect.set(forged.states.wait.action, "from", { kind: "completionRef", name: "done" });
		const forgedResult = normalizeChartConfig(forged);
		expect(forgedResult.ok).toBe(false);
		if (!forgedResult.ok) expect(forgedResult.diagnostics.some((row) => row.code === "INVALID_COMPLETION_REF")).toBe(true);

		const embedded = authoredCompletionChart();
		const definition = embedded.actors.worker.definition;
		assert.equal(definition.kind, "actorTemplate");
		if (definition.kind !== "actorTemplate") throw new Error("expected ordinary actor");
		const publish = definition.states.publish;
		assert(publish !== undefined && publish.kind === "state");
		const notifyAction = publish.action;
		assert.equal(notifyAction.kind, "notify");
		Reflect.set(notifyAction, "payload", { value: notifyAction.to });
		const embeddedResult = normalizeChartConfig(embedded);
		expect(embeddedResult.ok).toBe(false);
		if (!embeddedResult.ok) expect(embeddedResult.diagnostics.some((row) => row.code === "COMPLETION_REF_IN_DATA")).toBe(true);
	});

	it("treats a late completion validator response after notify cancellation as a race loser", async () => {
		const ast = completionChart();
		const runtime = new CompletionRuntime(ast, true, true, false, false);
		const running = start(runtime).catch(() => undefined);
		while (!runtime.effectsSeen.some((effect) => effect.kind === "completion_notify")) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		const notifyEffect = runtime.effectsSeen.find((effect) => effect.kind === "completion_notify");
		assert(notifyEffect?.kind === "completion_notify");
		const beforeCancellation = await runtime.loadProjection();
		expect(beforeCancellation.pendingActions.some((pending) => pending.definition.kind === "notify")).toBe(true);
		const afterCancellation = {
			...beforeCancellation,
			pendingActions: beforeCancellation.pendingActions.filter((pending) => pending.definition.kind !== "notify"),
		};
		const output = stepMachine(
			{
				ast,
				projection: afterCancellation,
				dispatched: new Set(),
				poolAdmissionReservations: new Map(),
			},
			{ kind: "completion_effect", effectId: notifyEffect.id, operation: "notify", ok: true },
		);
		expect(output.kind).not.toBe("error");
		expect(
			output.kind === "effect" &&
				output.effects.some((effect) => effect.kind === "durable_records" && effect.id === notifyEffect.id),
		).toBe(false);
		runtime.queue.close();
		await running;
	});

	it("fails closed on invalid payloads and duplicate notifications", async () => {
		const invalidRuntime = new CompletionRuntime(completionChart(), false);
		const invalid = await start(invalidRuntime);
		expect(invalid.projection.failure).toBeDefined();
		expect(invalid.projection.failure?.error).toContain("exact endpoint schema");
		expect(invalidRuntime.records.some((record) => record.type === "completion")).toBe(false);

		const concurrentRuntime = new CompletionRuntime(completionChart({ concurrent: true }), true, true, true);
		const concurrentRun = start(concurrentRuntime);
		while (!concurrentRuntime.notificationAppendHeld) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(concurrentRuntime.effectsSeen.filter((effect) => effect.kind === "completion_notify")).toHaveLength(1);
		concurrentRuntime.releaseHeldNotificationAppend();
		const concurrent = await concurrentRun;
		expect(concurrent.projection.failure?.error).toContain("notified more than once");
		expect(concurrentRuntime.records.filter((record) => record.type === "completion").map((record) => record.kind)).toEqual([
			"notified",
		]);
		expect(concurrentRuntime.effectsSeen.filter((effect) => effect.kind === "completion_notify")).toHaveLength(1);

		const duplicateRuntime = new CompletionRuntime(completionChart({ duplicate: true }));
		const duplicate = await start(duplicateRuntime);
		expect(duplicate.projection.failure).toBeDefined();
		expect(duplicate.projection.failure?.error).toContain("notified more than once");

		const staleWaitRuntime = new CompletionRuntime(completionChart({ reuseWait: true }));
		const staleWait = await start(staleWaitRuntime);
		expect(staleWait.projection.failure).toBeDefined();
		expect(staleWait.projection.failure?.error).toContain("cannot be consumed by another wait visit");
	});
});
