import { describe, expect, it } from "vitest";
import {
	actor,
	actorInput,
	messageInput,
	input,
	result,
	artifact,
	artifactOf,
	t,
	agent,
	arg,
	call,
	chart,
	compound,
	failed,
	final,
	item,
	loop,
	map,
	message,
	parallel,
	protocol,
	receive,
	reply,
	send,
	z,
	normalizeChartConfig,
	createBranchProjection,
	projectBranch,
	explainReplay,
	type DurableLogRecord,
	type Effect,
	type MachineEvent,
	type Runtime,
	start,
	stepMachine,
} from "../packages/hyperchart/src/index.js";
import { createAsyncQueue } from "../packages/hyperchart/src/utils/async_queue.js";
import { inspectChartAst } from "../packages/hyperchart/src/core/inspect_ast.js";
import { hyperchartRunFromRuntime } from "../packages/hyperchart/src/host/adapters.js";

const AuditProtocol = protocol({ RECORD: message({ input: z.object({ path: z.string() }).strict() }) });
const Auditor = actor({
	input: z.object({}).strict(),
	protocol: AuditProtocol,
	initial: "idle",
	states: {
		idle: receive({ on: { RECORD: "settle" } }),
		settle: reply({ target: "idle" }),
	},
});

const EditorProtocol = protocol({
	APPLY: message({
		input: z.object({ patch: z.string() }).strict(),
		replies: {
			APPLIED: z.object({ commit: z.string() }).strict(),
			REJECTED: z.object({ reason: z.string() }).strict(),
		},
	}),
});
const Editor = actor({
	input: z.object({ file: z.string() }).strict(),
	protocol: EditorProtocol,
	initial: "idle",
	states: {
		idle: receive({ on: { APPLY: "applied" } }),
		applied: reply({ target: "idle", event: "APPLIED", output: { commit: "c1" } }),
	},
});

function actorChart() {
	const auditor = Auditor({});
	return chart({
		kind: "chart",
		id: "actor-void-send",
		actors: { auditor },
		initial: "record",
		states: {
			record: send({ to: auditor, event: "RECORD", input: { path: "audit.log" }, target: "done" }),
			done: final(),
		},
	});
}

class ActorRuntime implements Runtime {
	readonly records: DurableLogRecord[] = [];
	readonly queue = createAsyncQueue<MachineEvent>();
	readonly effectsSeen: Effect[] = [];
	readonly pendingCancellationAcks: Array<Extract<Effect, { kind: "cancel" }>> = [];
	constructor(
		readonly ast: ReturnType<typeof parsed>,
		readonly fail?: "create" | "enqueue" | "reply",
		readonly agentReplies: Record<string, Array<string | { type: string; output?: unknown }>> = {},
		readonly autoAcknowledgeCancellation = true,
	) {}
	runEffects(effects: Effect[]): void {
		this.effectsSeen.push(...effects);
		for (const effect of effects) {
			if (effect.kind === "durable_records") {
				this.records.push(...effect.records);
				this.queue.send({ kind: "durable_records_added", effectId: effect.id, records: effect.records });
			} else if (effect.kind === "agent") {
				const reply = this.agentReplies[effect.actionUid.state]?.shift();
				if (reply !== undefined) this.queue.send({ kind: "agent", effectId: effect.id, event: typeof reply === "string" ? { type: reply } : reply });
			} else if (effect.kind === "actor_create") {
				this.queue.send({ kind: "actor_effect", effectId: effect.id, operation: "create", ok: this.fail !== "create", ...(this.fail === "create" ? { error: "create validation" } : {}) });
			} else if (effect.kind === "actor_enqueue") {
				this.queue.send({ kind: "actor_effect", effectId: effect.id, operation: "enqueue", ok: this.fail !== "enqueue", ...(this.fail === "enqueue" ? { error: "batch validation" } : {}) });
			} else if (effect.kind === "actor_reply") {
				this.queue.send({ kind: "actor_effect", effectId: effect.id, operation: "reply", ok: this.fail !== "reply", ...(this.fail === "reply" ? { error: "reply validation" } : {}) });
			} else if (effect.kind === "timer") {
				this.queue.send({ kind: "timer", effectId: effect.id });
			} else if (effect.kind === "cancel" && effect.requestId !== undefined && effect.target !== undefined) {
				this.pendingCancellationAcks.push(effect);
				if (this.autoAcknowledgeCancellation) this.acknowledgeCancellation(effect);
			}
		}
	}
	acknowledgeCancellation(effect: Extract<Effect, { kind: "cancel" }>) {
		if (effect.requestId === undefined || effect.target === undefined) throw new Error("not a durable actor cancellation");
		this.queue.send({ kind: "cancellation_acknowledged", effectId: effect.id, requestId: effect.requestId, target: effect.target });
	}
	eventsQueue() { return this.queue; }
	async loadAst() { return this.ast; }
	async loadLogs() { return this.records; }
}

function parsed(input: unknown = actorChart()) {
	const result = normalizeChartConfig(input);
	if (!result.ok) throw new Error(result.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join("\n"));
	return result.ast;
}

async function waitFor<T>(read: () => T | undefined, message: string): Promise<T> {
	for (let turn = 0; turn < 100; turn++) {
		const value = read();
		if (value !== undefined) return value;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(message);
}

describe("explicit event-sourced actors", () => {
	it("ignores a stale ok actor-effect response as a race loser instead of erroring the run", async () => {
		const runtime = new ActorRuntime(parsed());
		const state = await loop(runtime);
		const stale = stepMachine(state, {
			kind: "actor_effect",
			effectId: "actor:create:@auditor",
			operation: "create",
			ok: true,
		});
		expect(stale.kind).not.toBe("error");
	});

	it("accepts every message through receive, settles void send, drains, and replays from facts", async () => {
		const runtime = new ActorRuntime(parsed());
		const state = await loop(runtime);
		expect(state.projection.actors["@auditor"]).toMatchObject({ status: "stopped", currentState: "idle" });
		expect(state.projection.actors["@auditor"]?.messages).toHaveLength(1);
		expect(state.projection.actors["@auditor"]?.messages[0]).toMatchObject({ event: "RECORD", status: "settled" });
		const accepted = runtime.records.find((record) => record.type === "actor_message" && record.kind === "accepted");
		expect(accepted).toMatchObject({ occurrence: "@auditor", receiveState: "@auditor.idle" });
		expect(runtime.records.map((record) => record.type)).toEqual(expect.arrayContaining([
			"actor_created",
			"actor_messages_enqueued",
			"actor_message",
			"actor_scope",
		]));
		const replayed = projectBranch(createBranchProjection(runtime.ast), runtime.ast, JSON.parse(JSON.stringify(runtime.records)) as DurableLogRecord[]);
		expect(replayed.actors).toEqual(state.projection.actors);
		expect(replayed.activeLeaves).toEqual(state.projection.activeLeaves);
	});

	it("holds an actor-owning compound final until queued mail drains before invoking its successor", async () => {
		const WorkProtocol = protocol({ WORK: message({ input: z.object({ id: z.number() }).strict() }) });
		const Worker = actor({
			input: z.object({}).strict(), protocol: WorkProtocol, initial: "idle",
			states: {
				idle: receive({ on: { WORK: "work" } }),
				work: { kind: "state", action: agent("mail-worker"), transitions: { DONE: "settle" } },
				settle: reply({ target: "idle" }),
			},
		});
		const worker = Worker({});
		const ast = parsed(chart({
			kind: "chart", id: "actor-compound-drain-gate", initial: "phase",
			states: {
				phase: compound({
					actors: { worker }, initial: "dispatch", onDone: "successor",
					states: {
						dispatch: send({ to: worker, event: "WORK", inputs: [{ id: 1 }, { id: 2 }], target: "finished" }),
						finished: final(),
					},
				}),
				successor: { kind: "state", action: agent("successor"), transitions: { DONE: "done" } },
				done: final(),
			},
		}));
		const runtime = new ActorRuntime(ast, undefined, {
			"phase.@worker.work": ["DONE", "DONE"],
			successor: ["DONE"],
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(state.projection.actors["phase.@worker"]?.messages).toHaveLength(2);
		const stopped = runtime.records.find((record) => record.type === "actor_scope" && record.kind === "stopped" && record.occurrence === "phase.@worker");
		const successorInvoke = runtime.records.find((record) => record.type === "state_action" && record.kind === "invoke" && record.actionUid.state === "successor");
		expect(stopped).toBeDefined();
		expect(successorInvoke).toBeDefined();
		if (stopped === undefined || successorInvoke === undefined) throw new Error("missing drain/successor facts");
		expect(successorInvoke.seqId).toBeGreaterThan(stopped.seqId);
	});

	it("keeps compounds without actors atomic on final entry", () => {
		const ast = parsed(chart({
			kind: "chart", id: "compound-atomic-exit", initial: "phase",
			states: {
				phase: compound({ initial: "finished", onDone: "successor", states: { finished: final() } }),
				successor: { kind: "state", action: agent("successor"), transitions: { DONE: "done" } },
				done: final(),
			},
		}));

		expect(createBranchProjection(ast).activeLeaves).toEqual(["successor"]);
	});

	it("drains an actor owned by a completed parallel region before the parallel joins", async () => {
		const auditor = Auditor({});
		const ast = parsed(chart({
			kind: "chart", id: "actor-parallel-region", initial: "audit",
			states: {
				audit: parallel({
					onDone: "done",
					states: {
						a: compound({
							actors: { auditor }, initial: "record",
							states: {
								record: send({ to: auditor, event: "RECORD", input: { path: "audit.log" }, target: "adone" }),
								adone: final(),
							},
						}),
						b: compound({ initial: "bdone", states: { bdone: final() } }),
					},
				}),
				done: final(),
			},
		}));
		const runtime = new ActorRuntime(ast);
		const state = await loop(runtime);
		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(state.projection.actors["audit.a.@auditor"]).toMatchObject({ status: "stopped" });
		expect(runtime.records.flatMap((record) => record.type === "actor_scope" && record.occurrence === "audit.a.@auditor" ? [record.kind] : [])).toEqual(["closing", "stopped"]);
	});

	it("drains an actor owned directly by a parallel before the parallel joins", async () => {
		const auditor = Auditor({});
		const ast = parsed(chart({
			kind: "chart", id: "actor-parallel-owner", initial: "audit",
			states: {
				audit: parallel({
					actors: { auditor }, onDone: "done",
					states: {
						a: compound({
							initial: "record",
							states: {
								record: send({ to: auditor, event: "RECORD", input: { path: "audit.log" }, target: "adone" }),
								adone: final(),
							},
						}),
						b: compound({ initial: "bdone", states: { bdone: final() } }),
					},
				}),
				done: final(),
			},
		}));
		const runtime = new ActorRuntime(ast);
		const state = await loop(runtime);
		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(state.projection.actors["audit.@auditor"]).toMatchObject({ status: "stopped" });
	});

	it("preserves unknown kind objects in chart-level send input", async () => {
		const DataProtocol = protocol({ STORE: message({ input: z.object({ note: z.object({ kind: z.string() }).strict() }).strict() }) });
		const Store = actor({
			input: z.object({}).strict(), protocol: DataProtocol, initial: "idle",
			states: { idle: receive({ on: { STORE: "settle" } }), settle: reply({ target: "idle" }) },
		});
		const store = Store({});
		const ast = parsed(chart({
			kind: "chart", id: "actor-data-kind-send", actors: { store }, initial: "send",
			states: {
				send: send({ to: store, event: "STORE", input: { note: { kind: "unit" } }, target: "done" }),
				done: final(),
			},
		}));
		const runtime = new ActorRuntime(ast);
		const state = await loop(runtime);
		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(state.projection.actors["@store"]?.messages[0]?.input).toEqual({ note: { kind: "unit" } });
	});

	it("normalizes and resolves unknown kind objects in actor placement input", async () => {
		const PlacementProtocol = protocol({ PING: message({ input: z.object({}).strict() }) });
		const Placed = actor({
			input: z.object({ meta: z.object({ kind: z.string() }).strict() }).strict(),
			protocol: PlacementProtocol,
			initial: "idle",
			states: { idle: receive({ on: { PING: "settle" } }), settle: reply({ target: "idle" }) },
		});
		const placed = Placed({ meta: { kind: "unit" } });
		const normalized = normalizeChartConfig(chart({
			kind: "chart", id: "actor-data-kind-placement", actors: { placed }, initial: "done", states: { done: final() },
		}));
		expect(normalized.ok).toBe(true);
		if (!normalized.ok) throw new Error(JSON.stringify(normalized.diagnostics));
		expect(normalized.diagnostics).toEqual([]);
		const runtime = new ActorRuntime(normalized.ast);
		const state = await loop(runtime);
		expect(state.projection.actors["@placed"]).toMatchObject({ input: { meta: { kind: "unit" } }, status: "stopped" });
	});

	it("settles an actor message through an after-only timer path", async () => {
		const TimedProtocol = protocol({ RUN: message({ input: z.object({}).strict(), reply: z.object({ timedOut: z.boolean() }).strict() }) });
		const Timed = actor({
			input: z.object({}).strict(), protocol: TimedProtocol, initial: "idle",
			states: {
				idle: receive({ on: { RUN: "work" } }),
				work: { kind: "state", action: agent("slow-worker"), transitions: {}, after: { delayMs: 10, target: "settle" } },
				settle: reply({ target: "idle", output: { timedOut: true } }),
			},
		});
		const timed = Timed({});
		const ast = parsed(chart({
			kind: "chart", id: "actor-after-execution", actors: { timed }, initial: "run",
			states: { run: call({ to: timed, event: "RUN", input: {}, target: "done" }), done: final() },
		}));
		const runtime = new ActorRuntime(ast);
		const state = await loop(runtime);
		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(state.projection.results.run).toEqual({ timedOut: true });
		expect(runtime.records.some((record) => record.type === "state_action" && record.kind === "timer_fired" && record.actionUid.state === "@timed.work")).toBe(true);
		expect(state.projection.actors["@timed"]?.messages[0]).toMatchObject({ status: "settled" });
	});

	it("processes an authored-order batch one message at a time", async () => {
		const auditor = Auditor({});
		const ast = parsed(chart({
			kind: "chart", id: "actor-batch", actors: { auditor }, initial: "record",
			states: {
				record: send({ to: auditor, event: "RECORD", inputs: [{ path: "a" }, { path: "b" }, { path: "c" }], target: "done" }),
				done: final(),
			},
		}));
		const runtime = new ActorRuntime(ast);
		const state = await loop(runtime);
		expect(state.projection.actors["@auditor"]?.messages.map((entry) => [entry.input, entry.status])).toEqual([
			[{ path: "a" }, "settled"],
			[{ path: "b" }, "settled"],
			[{ path: "c" }, "settled"],
		]);
		const enqueue = runtime.records.filter((record) => record.type === "actor_messages_enqueued");
		expect(enqueue).toHaveLength(1);
	});

	it("correlates a call and routes the exact named reply", async () => {
		const editor = Editor({ file: "src/index.ts" });
		const ast = parsed(chart({
			kind: "chart", id: "actor-call", actors: { editor }, initial: "apply",
			states: {
				apply: call({ to: editor, event: "APPLY", input: { patch: "p" }, transitions: { APPLIED: "done", REJECTED: "rework" } }),
				rework: failed(),
				done: final(),
			},
		}));
		const runtime = new ActorRuntime(ast);
		const state = await loop(runtime);
		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(state.projection.results.apply).toEqual({ commit: "c1" });
		expect(state.projection.pendingActorCalls).toEqual({});
		expect(runtime.records.some((record) => record.type === "actor_call_resolved" && record.replyEvent === "APPLIED")).toBe(true);
	});

	it("creates isolated map-local occurrences and waits for their structured drain", async () => {
		const editor = Editor({ file: item("file") });
		const ast = parsed(chart({
			kind: "chart", id: "actor-map", initial: "projects",
			states: {
				projects: map({
					over: arg("projects"), actors: { editor }, initial: "apply", onDone: "done",
					states: {
						apply: call({ to: editor, event: "APPLY", input: { patch: "p" }, transitions: { APPLIED: "finished", REJECTED: "failed" } }),
						finished: final(), failed: failed(),
					},
				}),
				done: final(),
			},
		}));
		const runtime = new ActorRuntime(ast);
		const state = await start(runtime, { projects: { a: { file: "a.ts" }, b: { file: "b.ts" } } });
		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(Object.keys(state.projection.actors)).toEqual(["projects#a.@editor", "projects#b.@editor"]);
		expect(Object.values(state.projection.actors).map((entry) => [entry.input, entry.status])).toEqual([
			[{ file: "a.ts" }, "stopped"],
			[{ file: "b.ts" }, "stopped"],
		]);
		// Finite maps and explicit actors share immutable occurrence inputs: the one spawned fact
		// pins {key,item}, and actor placement resolves from that same projected substrate.
		expect(state.projection.inputs["projects#a"]).toEqual({ key: "a", item: { file: "a.ts" } });
		expect(state.projection.inputs["projects#b"]).toEqual({ key: "b", item: { file: "b.ts" } });
		expect(runtime.records.filter((record) => record.type === "spawned")).toHaveLength(1);
	});

	it("allows one map item to invoke main-chart work while another item's actor drains", async () => {
		const WorkProtocol = protocol({ WORK: message({ input: z.object({}).strict() }) });
		const Worker = actor({
			input: z.object({}).strict(), protocol: WorkProtocol, initial: "idle",
			states: {
				idle: receive({ on: { WORK: "handle" } }),
				handle: { kind: "state", action: agent("actor-handler"), transitions: { DONE: "settle" } },
				settle: reply({ target: "idle" }),
			},
		});
		const worker = Worker({});
		const ast = parsed(chart({
			kind: "chart", id: "actor-map-independent-drain", initial: "projects",
			states: {
				projects: map({
					over: arg("projects"), actors: { worker }, initial: "dispatch", onDone: "done",
					states: {
						dispatch: send({ to: worker, event: "WORK", input: {}, target: "choose" }),
						choose: { kind: "state", action: agent("chooser"), transitions: { FINISH: "finished", CONTINUE: "continue" } },
						continue: { kind: "state", action: agent("continuation"), transitions: { DONE: "finished" } },
						finished: final(),
					},
				}),
				done: final(),
			},
		}));
		const runtime = new ActorRuntime(ast);
		const running = start(runtime, { projects: { a: {}, b: {} } });
		const agentEffect = (statePath: string) => [...runtime.effectsSeen].reverse().find(
			(effect): effect is Extract<Effect, { kind: "agent" }> => effect.kind === "agent" && effect.actionUid.state === statePath,
		);

		const chooseA = await waitFor(() => agentEffect("projects#a.choose"), "item #a chooser was not invoked");
		const chooseB = await waitFor(() => agentEffect("projects#b.choose"), "item #b chooser was not invoked");
		await waitFor(() => agentEffect("projects#a.@worker.handle"), "item #a actor handler was not invoked");
		await waitFor(() => agentEffect("projects#b.@worker.handle"), "item #b actor handler was not invoked");
		runtime.queue.send({ kind: "agent", effectId: chooseA.id, event: { type: "FINISH" } });
		await waitFor(
			() => runtime.records.find((record) => record.type === "actor_scope" && record.kind === "closing" && record.occurrence === "projects#a.@worker"),
			"item #a actor did not begin draining",
		);
		expect(runtime.records.some((record) => record.type === "actor_scope" && record.kind === "stopped" && record.occurrence === "projects#a.@worker")).toBe(false);

		runtime.queue.send({ kind: "agent", effectId: chooseB.id, event: { type: "CONTINUE" } });
		const continuation = await waitFor(() => agentEffect("projects#b.continue"), "item #b continuation was serialized behind item #a drain");
		expect(runtime.records.some((record) => record.type === "actor_scope" && record.kind === "stopped" && record.occurrence === "projects#a.@worker")).toBe(false);

		runtime.queue.send({ kind: "agent", effectId: continuation.id, event: { type: "DONE" } });
		await waitFor(
			() => runtime.records.find((record) => record.type === "actor_scope" && record.kind === "closing" && record.occurrence === "projects#b.@worker"),
			"item #b actor did not begin draining",
		);
		for (const statePath of ["projects#a.@worker.handle", "projects#b.@worker.handle"]) {
			const handler = agentEffect(statePath);
			if (handler === undefined) throw new Error(`missing ${statePath}`);
			runtime.queue.send({ kind: "agent", effectId: handler.id, event: { type: "DONE" } });
		}
		for (const occurrence of ["projects#a.@worker", "projects#b.@worker"]) {
			await waitFor(
				() => runtime.records.find((record) => record.type === "actor_scope" && record.kind === "stopped" && record.occurrence === occurrence),
				`${occurrence} did not stop`,
			);
		}
		const state = await running;
		expect(state.projection.activeLeaves).toEqual(["done"]);
	});

	it("keeps chart-level actors open while a map waits for item actors to drain", async () => {
		const WorkerProtocol = protocol({ PROCESS: message({ input: z.object({}).strict() }) });
		const Worker = actor({
			input: z.object({}).strict(), protocol: WorkerProtocol, initial: "idle",
			states: {
				idle: receive({ on: { PROCESS: "work" } }),
				work: { kind: "state", action: agent("item-worker"), transitions: { DONE: "settle" } },
				settle: reply({ target: "idle" }),
			},
		});
		const auditor = Auditor({});
		const worker = Worker({});
		const ast = parsed(chart({
			kind: "chart", id: "actor-root-map-drain", actors: { auditor }, initial: "projects",
			states: {
				projects: map({
					over: arg("projects"), actors: { worker }, initial: "process", onDone: "record",
					states: {
						process: send({ to: worker, event: "PROCESS", input: {}, target: "finished" }),
						finished: final(),
					},
				}),
				record: send({ to: auditor, event: "RECORD", input: { path: "after-map.log" }, target: "done" }),
				done: final(),
			},
		}));
		const runtime = new ActorRuntime(ast, undefined, {
			"projects#a.@worker.work": ["DONE"],
			"projects#b.@worker.work": ["DONE"],
		});
		const state = await start(runtime, { projects: { a: {}, b: {} } });
		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(state.projection.actors["@auditor"]?.messages[0]).toMatchObject({ event: "RECORD", status: "settled" });
		expect(state.projection.actors["projects#a.@worker"]).toMatchObject({ status: "stopped" });
		expect(state.projection.actors["projects#b.@worker"]).toMatchObject({ status: "stopped" });

		const mapItemSeqIds = runtime.records.flatMap((record) => {
			if (record.type === "state_action" && record.actionUid.state.startsWith("projects#")) return [record.seqId];
			if ("occurrence" in record && typeof record.occurrence === "string" && record.occurrence.startsWith("projects#")) return [record.seqId];
			return [];
		});
		expect(mapItemSeqIds.length).toBeGreaterThan(0);
		const auditorClosing = runtime.records.find((record) => record.type === "actor_scope" && record.occurrence === "@auditor" && record.kind === "closing");
		const auditorEnqueue = runtime.records.find((record) => record.type === "actor_messages_enqueued" && record.occurrence === "@auditor");
		expect(auditorClosing).toBeDefined();
		expect(auditorEnqueue).toBeDefined();
		if (auditorClosing === undefined || auditorEnqueue === undefined) throw new Error("missing auditor lifecycle facts");
		expect(auditorClosing.seqId).toBeGreaterThan(Math.max(...mapItemSeqIds));
		expect(auditorClosing.seqId).toBeGreaterThan(auditorEnqueue.seqId);
		expect(runtime.records.flatMap((record) => record.type === "actor_scope" && record.occurrence === "@auditor" ? [record.kind] : [])).toEqual(["closing", "stopped"]);
	});

	it("projects faithful inspector hierarchy, unique occurrences, internal states, and call edges", async () => {
		const editor = Editor({ file: item("file") });
		const ast = parsed(chart({
			kind: "chart", id: "actor-inspector", initial: "projects",
			states: {
				projects: map({
					over: arg("projects"), actors: { editor }, initial: "apply", onDone: "done",
					states: {
						apply: call({ to: editor, event: "APPLY", input: { patch: "p" }, transitions: { APPLIED: "finished", REJECTED: "failed" } }),
						finished: final(), failed: failed(),
					},
				}),
				done: final(),
			},
		}));
		const runtime = new ActorRuntime(ast);
		await start(runtime, { projects: { a: { file: "a.ts" }, b: { file: "b.ts" } } });
		const run = hyperchartRunFromRuntime(inspectChartAst(ast), ast, runtime.records);
		expect(new Set(run.states.map((entry) => entry.id)).size).toBe(run.states.length);
		expect(run.states).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: "projects#a.@editor",
				scopeParentId: "projects#a",
				actorDeclaration: expect.objectContaining({ declarationPath: "projects.@editor" }),
				actorOccurrence: expect.objectContaining({ occurrencePath: "projects#a.@editor", generation: 1 }),
			}),
			expect.objectContaining({ id: "projects#a.@editor.idle", scopeParentId: "projects#a.@editor", runtimeStatePath: "projects#a.@editor.idle", type: "receive" }),
			expect.objectContaining({ id: "projects#a.@editor.applied", scopeParentId: "projects#a.@editor", runtimeStatePath: "projects#a.@editor.applied", type: "reply" }),
		]));
		const caller = run.states.find((entry) => entry.id === "projects#a.apply");
		expect(caller?.actorMessageLink).toEqual({
			kind: "call",
			to: "projects#a.@editor",
			event: "APPLY",
			messages: [expect.objectContaining({ messageId: "projects#a.apply:message:1:0" })],
		});
	});

	it("fails an invalid batch atomically without writing a partial enqueue", async () => {
		const auditor = Auditor({});
		const ast = parsed(chart({
			kind: "chart", id: "actor-invalid-batch", actors: { auditor }, initial: "record",
			states: { record: send({ to: auditor, event: "RECORD", inputs: [{ path: "a" }], target: "done" }), done: final() },
		}));
		const runtime = new ActorRuntime(ast, "enqueue");
		const state = await loop(runtime);
		expect(state.projection.failure?.error).toBe("batch validation");
		expect(runtime.records.some((record) => record.type === "actor_messages_enqueued")).toBe(false);
	});

	it("waits for genuine acknowledgements from every actor phase before failure terminalization", async () => {
		const editor = Editor({ file: "src/index.ts" });
		const ast = parsed(chart({
			kind: "chart", id: "actor-failure-quiescence", actors: { editor }, initial: "apply",
			states: {
				apply: call({ to: editor, event: "APPLY", input: { patch: "p" }, transitions: { APPLIED: "done", REJECTED: "done" } }),
				done: final(),
			},
		}));
		const runtime = new ActorRuntime(ast, "reply", {}, false);
		let completed = false;
		const running = loop(runtime).then((state) => { completed = true; return state; });
		for (let turn = 0; turn < 30 && runtime.pendingCancellationAcks.length < 3; turn++) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		expect(runtime.pendingCancellationAcks.map((effect) => effect.target?.kind).sort()).toEqual(["actor_call", "actor_effect", "actor_message"]);
		expect(runtime.records.filter((record) => record.type === "cancellation").map((record) => record.kind)).toEqual(["requested", "requested", "requested"]);
		expect(completed).toBe(false);
		for (const effect of runtime.pendingCancellationAcks.slice(0, -1)) runtime.acknowledgeCancellation(effect);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(completed).toBe(false);
		runtime.acknowledgeCancellation(runtime.pendingCancellationAcks.at(-1)!);
		const state = await running;
		expect(completed).toBe(true);
		expect(Object.values(state.projection.cancellations).every((entry) => entry.acknowledged)).toBe(true);
		expect(state.projection.actors["@editor"]?.status).toBe("cancelled");
	});

	it("writes failure intent before accepting an unsupported FIFO head", async () => {
		const MixedProtocol = protocol({
			A: message({ input: z.object({ value: z.string() }) }),
			B: message({ input: z.object({ value: z.string() }) }),
		});
		const Mixed = actor({
			input: z.object({}), protocol: MixedProtocol, initial: "idle",
			states: { idle: receive({ on: { A: "settle" } }), settle: reply({ target: "idle" }) },
		});
		const mixed = Mixed({});
		const ast = parsed(chart({
			kind: "chart", id: "unsupported-head", actors: { mixed }, initial: "send",
			states: { send: send({ to: mixed, event: "B", input: { value: "bad" }, target: "done" }), done: final() },
		}));
		const runtime = new ActorRuntime(ast);
		const state = await loop(runtime);
		expect(state.projection.failure?.error).toContain("unsupported");
		const types = runtime.records.map((record) => record.type === "actor_message" ? `${record.type}/${record.kind}` : record.type);
		expect(types).not.toContain("actor_message/accepted");
		expect(types.indexOf("failure_intent")).toBeGreaterThan(types.indexOf("actor_messages_enqueued"));
	});

	it("accepts the next resumed message using live receive routing while preserving logged provenance", async () => {
		const RouteProtocol = protocol({ PING: message({ input: z.object({}).strict(), reply: z.object({ route: z.string() }).strict() }) });
		const makeChart = (target: "logged" | "live") => {
			const Routed = target === "logged"
				? actor({
					input: z.object({}).strict(), protocol: RouteProtocol, initial: "idle",
					states: {
						idle: receive({ on: { PING: "logged" } }),
						logged: reply({ target: "idle", output: { route: "logged" } }),
					},
				})
				: actor({
					input: z.object({}).strict(), protocol: RouteProtocol, initial: "idle",
					states: {
						idle: receive({ on: { PING: "live" } }),
						live: reply({ target: "idle", output: { route: "live" } }),
					},
				});
			const routed = Routed({});
			return parsed(chart({
				kind: "chart", id: "actor-live-routing", actors: { routed }, initial: "ping",
				states: { ping: call({ to: routed, event: "PING", input: {}, target: "done" }), done: final() },
			}));
		};
		const oldAst = makeChart("logged");
		const oldRuntime = new ActorRuntime(oldAst);
		await loop(oldRuntime);
		const acceptedIndex = oldRuntime.records.findIndex((record) => record.type === "actor_message" && record.kind === "accepted");
		expect(acceptedIndex).toBeGreaterThan(0);
		const prefix = JSON.parse(JSON.stringify(oldRuntime.records.slice(0, acceptedIndex))) as DurableLogRecord[];
		const created = prefix.find((record) => record.type === "actor_created");
		expect(created?.type === "actor_created" ? created.definition.states.idle : undefined).toMatchObject({ kind: "receive", on: { PING: "logged" } });

		const liveRuntime = new ActorRuntime(makeChart("live"));
		liveRuntime.records.push(...prefix);
		const state = await loop(liveRuntime);

		expect(state.projection.results.ping).toEqual({ route: "live" });
		const preserved = liveRuntime.records.find((record) => record.type === "actor_created");
		expect(preserved).toEqual(created);
	});

	it("detects stale send provenance and broken call resolution on a genuinely fresh replay", async () => {
		const originalRuntime = new ActorRuntime(parsed());
		await loop(originalRuntime);
		const changedAuditor = Auditor({});
		const changed = parsed(chart({
			kind: "chart", id: "actor-void-send", actors: { auditor: changedAuditor }, initial: "record",
			states: {
				record: send({ to: changedAuditor, event: "RECORD", input: { path: "audit.log" }, target: "after" }),
				after: final(), done: final(),
			},
		}));
		expect(explainReplay(changed, originalRuntime.records).stale).toEqual(expect.arrayContaining([
			expect.objectContaining({ reason: "actor_message_source_changed", state: "record" }),
		]));

		const editor = Editor({ file: "src/index.ts" });
		const callAst = parsed(chart({
			kind: "chart", id: "broken-call-order", actors: { editor }, initial: "apply",
			states: {
				apply: call({ to: editor, event: "APPLY", input: { patch: "p" }, transitions: { APPLIED: "done", REJECTED: "done" } }),
				done: final(),
			},
		}));
		const callRuntime = new ActorRuntime(callAst);
		await loop(callRuntime);
		const broken = [...callRuntime.records];
		const resolvedIndex = broken.findIndex((record) => record.type === "actor_call_resolved");
		const settledIndex = broken.findIndex((record) => record.type === "actor_message" && record.kind === "settled");
		const [resolved] = broken.splice(resolvedIndex, 1);
		if (resolved === undefined) throw new Error("missing call resolution fact");
		broken.splice(settledIndex, 0, resolved);
		expect(explainReplay(callAst, broken).broken?.error).toContain("before its message settled");
	});

	it("resolves actor-local typed input, message, state input, results, and artifacts", async () => {
		const LocalProtocol = protocol({
			APPLY: message({ input: z.object({ patch: z.string() }), reply: z.object({ commit: z.string() }) }),
		});
		const Local = actor({
			input: z.object({ file: z.string() }), protocol: LocalProtocol, initial: "idle",
			states: {
				idle: receive({ on: { APPLY: "work" } }),
				work: {
					kind: "state",
					input: { prefix: z.string().default("apply") },
					action: agent("editor", {
						task: t`${input("prefix")} ${messageInput("APPLY", "patch")} to ${actorInput("file")}`,
						reply: z.object({ commit: z.string() }),
						artifacts: { changed: artifact(t`${actorInput("file")}.changed`) },
					}),
					transitions: { DONE: "verify" },
				},
				verify: {
					kind: "state",
					action: agent("verifier", {
						task: t`verify ${result("work", "commit")}`,
						reads: [artifactOf("work", { artifact: "changed" })],
						reply: z.object({ commit: z.string() }),
					}),
					transitions: { VERIFIED: "settle" },
				},
				settle: reply({ target: "idle", output: result("verify") }),
			},
		});
		const local = Local({ file: "src/file.ts" });
		const ast = parsed(chart({
			kind: "chart", id: "actor-local", actors: { local }, initial: "apply",
			states: { apply: call({ to: local, event: "APPLY", input: { patch: "p1" }, target: "done" }), done: final() },
		}));
		const runtime = new ActorRuntime(ast, undefined, {
			"@local.work": [{ type: "DONE", output: { commit: "c1" } }],
			"@local.verify": [{ type: "VERIFIED", output: { commit: "c1" } }],
		});
		const state = await loop(runtime);
		expect(state.projection.results.apply).toEqual({ commit: "c1" });
		const work = runtime.effectsSeen.find((effect) => effect.kind === "agent" && effect.actionUid.state === "@local.work");
		const verify = runtime.effectsSeen.find((effect) => effect.kind === "agent" && effect.actionUid.state === "@local.verify");
		expect(work?.kind === "agent" ? work.task : undefined).toBe("apply p1 to src/file.ts");
		expect(work?.kind === "agent" ? work.artifacts?.[0]?.path : undefined).toBe("src/file.ts.changed");
		expect(verify?.kind === "agent" ? verify.task : undefined).toBe("verify c1");
		expect(verify?.kind === "agent" ? verify.reads?.[0]?.path : undefined).toBe("src/file.ts.changed");
	});

	it("creates a new generation after a compound owner exits and re-enters", async () => {
		const auditor = Auditor({});
		const ast = parsed(chart({
			kind: "chart", id: "actor-reentry", initial: "phase",
			states: {
				phase: {
					kind: "compound", actors: { auditor }, initial: "record", onDone: "between",
					states: {
						record: send({ to: auditor, event: "RECORD", input: { path: "audit.log" }, target: "finished" }),
						finished: final(),
					},
				},
				between: { kind: "state", action: { kind: "agent", name: "chooser" }, transitions: { AGAIN: "phase", DONE: "done" } },
				done: final(),
			},
		}));
		const runtime = new ActorRuntime(ast, undefined, { between: ["AGAIN", "DONE"] });
		const state = await loop(runtime);
		expect(Object.keys(state.projection.actors)).toEqual(["phase.@auditor", "phase.@auditor~2"]);
		expect(Object.values(state.projection.actors).map((entry) => [entry.generation, entry.status])).toEqual([[1, "stopped"], [2, "stopped"]]);
		const run = hyperchartRunFromRuntime(inspectChartAst(ast), ast, runtime.records);
		const actorNodes = run.states.filter((entry) => entry.actorOccurrence?.logicalPath === "phase.@auditor");
		expect(actorNodes).toHaveLength(1);
		expect(actorNodes[0]).toMatchObject({
			id: "phase.@auditor",
			actorOccurrence: {
				occurrencePath: "phase.@auditor~2",
				logicalPath: "phase.@auditor",
				generation: 2,
				generationHistory: [
					expect.objectContaining({ visit: 1, status: "done", inputs: { input: {} } }),
					expect.objectContaining({ visit: 2, status: "done", inputs: { input: {} } }),
				],
			},
		});
		expect(run.states.some((entry) => entry.id.includes("~2"))).toBe(false);
	});

	it("rejects declarations in runtime data, duplicate placement, illegal owners, and unavailable placement refs", () => {
		const auditor = Auditor({});
		const duplicate = normalizeChartConfig(chart({
			kind: "chart", id: "duplicate", actors: { first: auditor, second: auditor }, initial: "done", states: { done: final() },
		}));
		expect(duplicate.ok).toBe(false);
		if (!duplicate.ok) expect(duplicate.diagnostics.map((entry) => entry.code)).toContain("DUPLICATE_ACTOR_PLACEMENT");

		const embedded = normalizeChartConfig({
			kind: "chart", id: "embedded", actors: { auditor }, initial: "record",
			states: { record: { kind: "send", to: auditor, event: "RECORD", input: { path: auditor }, target: "done" }, done: final() },
		});
		expect(embedded.ok).toBe(false);
		if (!embedded.ok) expect(embedded.diagnostics.map((entry) => entry.code)).toContain("ACTOR_DECLARATION_IN_DATA");

		const illegalOwner = normalizeChartConfig({
			kind: "chart", id: "illegal-owner", initial: "work",
			states: { work: { kind: "state", actors: { auditor: Auditor({}) }, action: agent("worker"), transitions: { DONE: "done" } }, done: final() },
		});
		expect(illegalOwner.ok).toBe(false);
		if (!illegalOwner.ok) expect(illegalOwner.diagnostics.map((entry) => entry.code)).toContain("INVALID_ACTOR_OWNER");

		const lateEditor = Editor({ file: result("prepare", "file") });
		const latePlacement = normalizeChartConfig(chart({
			kind: "chart", id: "late-placement", actors: { lateEditor }, initial: "prepare",
			states: {
				prepare: { kind: "state", action: agent("planner"), transitions: { DONE: "done" } },
				done: final(),
			},
		}));
		expect(latePlacement.ok).toBe(false);
		if (!latePlacement.ok) expect(latePlacement.diagnostics.map((entry) => entry.code)).toContain("INVALID_ACTOR_PLACEMENT_REF");
	});
});
