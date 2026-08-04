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
	failed,
	final,
	item,
	loop,
	map,
	message,
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

describe("explicit event-sourced actors", () => {
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
