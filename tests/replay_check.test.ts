import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
	agent,
	actor,
	arg,
	chart,
	script,
	event,
	explainReplay,
	createBranchProjection,
	projectBranch,
	final,
	map,
	message,
	normalizeChartConfig,
	protocol,
	receive,
	reply,
	send,
	tsImport,
	z,
	t,
	type ActionUID,
	type ChartAst,
	type DurableLogRecord,
	type GuardRefAst,
	type StateActionAst,
	type StateAst,
	type StatePath,
} from "../packages/hyperchart/src/index.js";

function ast(input: unknown): ChartAst {
	const parsed = normalizeChartConfig(input);
	if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	return parsed.ast;
}

function twoStep(firstTarget = "second"): ChartAst {
	return ast(
		chart({
			kind: "chart",
			id: "replay-test",
			initial: "first",
			states: {
				first: { kind: "state", action: agent("first-worker"), transitions: { FIRST_DONE: firstTarget } },
				[firstTarget]: { kind: "state", action: agent("second-worker"), transitions: { SECOND_DONE: "done" } },
				done: final(),
			},
		}),
	);
}

function actionUid(chartAst: ChartAst, state: StatePath): ActionUID {
	const node = chartAst.states[state];
	if (node?.kind !== "state") throw new Error(`Expected action state ${state}`);
	return { ...node.action.uid, state };
}

function definition(chartAst: ChartAst, state: StatePath): StateActionAst {
	const node = chartAst.states[state];
	if (node?.kind !== "state") throw new Error(`Expected action state ${state}`);
	return node.action;
}

function definitionForUid(uid: ActionUID): StateActionAst {
	return { kind: "agent", uid, name: "test-worker" };
}

function meta(seqId: number) {
	return { parentId: seqId - 1, seqId, timestamp: seqId };
}

function args(seqId = 1): DurableLogRecord {
	return { type: "args", args: {}, parentId: null, seqId, timestamp: seqId };
}

function invoke(uid: ActionUID, seqId: number, actionDefinition: StateActionAst = definitionForUid(uid)): DurableLogRecord {
	return {
		type: "state_action",
		kind: "invoke",
		actionUid: uid,
		definition: actionDefinition,
		...meta(seqId),
	};
}

function complete(uid: ActionUID, eventType: string, seqId: number, output?: unknown): DurableLogRecord {
	return {
		type: "state_action",
		kind: "complete",
		actionUid: uid,
		event: { type: eventType, ...(output === undefined ? {} : { output }) },
		...meta(seqId),
	};
}

function validated(uid: ActionUID, eventType: string, seqId: number, guard: GuardRefAst = tsImport("./checks.js", "ok")): DurableLogRecord {
	return {
		type: "state_action",
		kind: "validated",
		actionUid: uid,
		event: { type: eventType },
		guard,
		outcome: true,
		...meta(seqId),
	};
}

describe("explainReplay", () => {
	it("rejects forged actor creation placement and generation provenance", () => {
		const ActorProtocol = protocol({ PING: message({ input: z.object({}) }) });
		const Actor = actor({
			input: z.object({}), protocol: ActorProtocol, initial: "idle",
			states: { idle: receive({ on: { PING: "settle" } }), settle: reply({ target: "idle" }) },
		});
		const declaration = Actor({});
		const current = ast(chart({
			kind: "chart", id: "actor-replay-provenance", actors: { a: declaration }, initial: "done", states: { done: final() },
		}));
		const definition = current.actors["@a"]!;
		const valid = {
			type: "actor_created" as const,
			declaration: "@a",
			occurrence: "@a",
			generation: 1,
			input: {},
			definition,
			...meta(1),
		};
		const forgeries: DurableLogRecord[] = [
			{ ...valid, owner: "forged" },
			{ ...valid, occurrence: "forged.@a" },
			{ ...valid, occurrence: "forged" },
			{ ...valid, generation: 2, occurrence: "@a" },
		];

		for (const forged of forgeries) {
			const explanation = explainReplay(current, [forged]);
			expect(explanation.prefixEnd).toBe(0);
			expect(explanation.broken).toMatchObject({ seqId: 1 });
		}
	});

	it("derives a restarted actor's logical occurrence from its concrete occurrence", () => {
		const ActorProtocol = protocol({ PING: message({ input: z.object({}) }) });
		const Actor = actor({
			input: z.object({}), protocol: ActorProtocol, initial: "idle",
			states: { idle: receive({ on: { PING: "settle" } }), settle: reply({ target: "idle" }) },
		});
		const declaration = Actor({});
		const current = ast(chart({
			kind: "chart", id: "actor-replay-generation", actors: { a: declaration }, initial: "done", states: { done: final() },
		}));
		const definition = current.actors["@a"]!;
		const log: DurableLogRecord[] = [
			{ type: "actor_created", declaration: "@a", occurrence: "@a", generation: 1, input: {}, definition, ...meta(1) },
			{ type: "actor_scope", kind: "stopped", occurrence: "@a", ...meta(2) },
			{ type: "actor_created", declaration: "@a", occurrence: "@a~2", generation: 2, input: {}, definition, ...meta(3) },
		];

		const explanation = explainReplay(current, log);
		const projection = projectBranch(createBranchProjection(current), current, log);

		expect(explanation.broken).toBeUndefined();
		expect(projection.actors["@a~2"]?.logicalOccurrence).toBe("@a");
	});

	it("flags a reply contract changed in the live actor protocol", () => {
		const OldProtocol = protocol({ PING: message({ input: z.object({}), reply: z.object({ value: z.string() }) }) });
		const NewProtocol = protocol({ PING: message({ input: z.object({}), reply: z.object({ value: z.number() }) }) });
		const OldActor = actor({
			input: z.object({}), protocol: OldProtocol, initial: "idle",
			states: { idle: receive({ on: { PING: "settle" } }), settle: reply({ target: "idle", output: { value: "old" } }) },
		});
		const NewActor = actor({
			input: z.object({}), protocol: NewProtocol, initial: "idle",
			states: { idle: receive({ on: { PING: "settle" } }), settle: reply({ target: "idle", output: { value: 1 } }) },
		});
		const oldActor = OldActor({});
		const newActor = NewActor({});
		const old = ast(chart({
			kind: "chart", id: "actor-reply-contract", actors: { worker: oldActor }, initial: "ping",
			states: { ping: send({ to: oldActor, event: "PING", input: {}, target: "done" }), done: final() },
		}));
		const current = ast(chart({
			kind: "chart", id: "actor-reply-contract", actors: { worker: newActor }, initial: "ping",
			states: { ping: send({ to: newActor, event: "PING", input: {}, target: "done" }), done: final() },
		}));
		const declaration = old.actors["@worker"]!;
		const source = old.states.ping;
		assert(source?.kind === "send", "expected send source");
		const contract = declaration.protocol.PING!;
		assert(contract.reply.kind === "single", "expected single reply contract");
		const envelope = { messageId: "ping:message:1:0", event: "PING", input: {}, producerState: "ping", producerVisit: 1, batchIndex: 0 };
		const log: DurableLogRecord[] = [
			{ type: "actor_created", declaration: "@worker", occurrence: "@worker", generation: 1, input: {}, definition: declaration, ...meta(1) },
			{ type: "actor_messages_enqueued", occurrence: "@worker", generation: 1, source: { producerState: "ping", kind: "send", definition: source, targetDeclaration: "@worker", event: "PING", inputSchema: contract.input }, messages: [envelope], ...meta(2) },
			{ type: "actor_message", kind: "accepted", occurrence: "@worker", messageId: envelope.messageId, receiveState: "@worker.idle", ...meta(3) },
			{ type: "actor_message", kind: "replied", occurrence: "@worker", messageId: envelope.messageId, message: "PING", output: { value: "old" }, schema: contract.reply.schema, ...meta(4) },
		];

		const explanation = explainReplay(current, log);

		expect(explanation.broken).toBeUndefined();
		expect(explanation.stale).toEqual(expect.arrayContaining([
			expect.objectContaining({ seqId: 4, reason: "actor_reply_contract_changed", state: "@worker" }),
		]));
	});

	it("rejects an actor creation whose map owner was not a concrete spawned occurrence", () => {
		const ActorProtocol = protocol({ PING: message({ input: z.object({}) }) });
		const Actor = actor({
			input: z.object({}), protocol: ActorProtocol, initial: "idle",
			states: { idle: receive({ on: { PING: "settle" } }), settle: reply({ target: "idle" }) },
		});
		const declaration = Actor({});
		const current = ast(chart({
			kind: "chart", id: "actor-map-owner-provenance", initial: "m", states: {
				m: map({
					over: arg("items"), actors: { a: declaration }, initial: "work", onDone: "done",
					states: { work: { kind: "state", action: agent("worker"), transitions: { DONE: "finished" } }, finished: final() },
				}),
				done: final(),
			},
		}));
		const definition = current.actors["m.@a"]!;
		const log: DurableLogRecord[] = [
			args(),
			{ type: "spawned", path: "m", instances: { real: {} }, ...meta(2) },
			{
				type: "actor_created", declaration: "m.@a", owner: "m",
				occurrence: "m.@a", generation: 1,
				input: {}, definition, ...meta(3),
			},
		];

		const explanation = explainReplay(current, log);
		expect(explanation.prefixEnd).toBe(2);
		expect(explanation.broken).toMatchObject({ seqId: 3 });
		expect(explanation.broken?.error).toContain("was not spawned");
	});

	it("treats guard env, reply, and artifact provenance as replay-sensitive", () => {
		const make = (value: string) => ast(chart({ kind: "chart", id: "guard-provenance", initial: "work", states: {
			work: { kind: "state", action: agent("worker"), validate: script("node", [], { env: { CHECK: value }, artifacts: { report: "report.json" }, reply: z.object({ ok: z.boolean() }) }), transitions: { DONE: "done" } }, done: final(),
		} }));
		const original = make("one");
		const changed = make("two");
		const uid = actionUid(original, "work");
		const guard = (original.states.work as Extract<StateAst, { kind: "state" }>).validate;
		if (guard === undefined) throw new Error("expected guard");
		const log: DurableLogRecord[] = [args(), invoke(uid, 2, definition(original, "work")), complete(uid, "DONE", 3), validated(uid, "DONE", 4, guard)];
		const explanation = explainReplay(changed, log);
		expect(explanation.stale).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "guard_changed" })]));
	});

	it("accepts compatible edits without skipped or stale facts", () => {
		const original = twoStep();
		const current = ast(
			chart({
				kind: "chart",
				id: "replay-test",
				initial: "first",
				states: {
					first: { kind: "state", action: agent("first-worker"), transitions: { FIRST_DONE: "second", OTHER: "unused" } },
					second: { kind: "state", action: agent("second-worker"), transitions: { SECOND_DONE: "done" } },
					unused: { kind: "state", action: agent("unused-worker"), transitions: { DONE: "done" } },
					done: final(),
				},
			}),
		);
		const log = [args(), invoke(actionUid(original, "first"), 2, definition(original, "first"))];

		const explanation = explainReplay(current, log);

		expect(explanation.prefixEnd).toBe(log.length);
		expect(explanation.broken).toBeUndefined();
		expect(explanation.skipped).toEqual([]);
		expect(explanation.stale).toEqual([]);
	});

	it("reports facts made inactive by a retargeted transition as skipped", () => {
		const original = twoStep("second");
		const current = twoStep("renamed");
		const first = actionUid(original, "first");
		const second = actionUid(original, "second");
		const log = [
			args(),
			invoke(first, 2),
			complete(first, "FIRST_DONE", 3),
			invoke(second, 4),
			complete(second, "SECOND_DONE", 5),
		];

		const explanation = explainReplay(current, log);

		expect(explanation.broken).toBeUndefined();
		expect(explanation.prefixEnd).toBe(log.length);
		expect(explanation.skipped.map((entry) => [entry.seqId, entry.state])).toEqual([
			[4, "second"],
			[5, "second"],
		]);
	});

	it("rejects pre-provenance invoke records instead of replaying them", () => {
		const current = twoStep();
		const first = actionUid(current, "first");
		const oldInvoke = { type: "state_action", kind: "invoke", actionUid: first, ...meta(2) } as unknown as DurableLogRecord;
		const log = [args(), oldInvoke];

		const explanation = explainReplay(current, log);

		expect(explanation.broken).toMatchObject({ seqId: 2, state: "first" });
		expect(explanation.broken?.error).toContain("missing action definition provenance");
	});

	it("stops at the first structurally broken record", () => {
		const original = twoStep();
		const current = ast(
			chart({
				kind: "chart",
				id: "replay-test",
				initial: "first",
				states: {
					first: { kind: "state", action: agent("first-worker"), transitions: { OTHER: "second" } },
					second: { kind: "state", action: agent("second-worker"), transitions: { SECOND_DONE: "done" } },
					done: final(),
				},
			}),
		);
		const first = actionUid(original, "first");
		const log = [args(), invoke(first, 2), complete(first, "FIRST_DONE", 3)];

		const explanation = explainReplay(current, log);

		expect(explanation.prefixEnd).toBe(2);
		expect(explanation.broken).toMatchObject({ seqId: 3, state: "first", invokeSeqId: 2 });
		expect(explanation.broken?.error).toContain("No transition for event type FIRST_DONE");
	});

	it("treats spawned records on non-map states as broken", () => {
		const current = ast(
			chart({
				kind: "chart",
				id: "replay-test",
				initial: "fan",
				states: {
					fan: { kind: "state", action: agent("worker"), transitions: { DONE: "done" } },
					done: final(),
				},
			}),
		);
		const log: DurableLogRecord[] = [
			args(),
			{ type: "spawned", path: "fan", instances: { a: { id: "a" } }, ...meta(2) },
		];

		const explanation = explainReplay(current, log);

		expect(explanation.broken).toMatchObject({ seqId: 2, state: "fan" });
		expect(explanation.broken?.error).toContain("Spawned record for non-map state fan");
	});

	it("reports missing event binding paths as broken", () => {
		const current = ast(
			chart({
				kind: "chart",
				id: "replay-test",
				initial: "first",
				states: {
					first: {
						kind: "state",
						action: agent("first-worker"),
						transitions: { FIRST_DONE: { target: "second", input: { payload: event("payload.value") } } },
					},
					second: {
						kind: "state",
						input: { payload: z.string() },
						action: agent("second-worker"),
						transitions: { SECOND_DONE: "done" },
					},
					done: final(),
				},
			}),
		);
		const first = actionUid(current, "first");
		const log = [args(), invoke(first, 2), complete(first, "FIRST_DONE", 3, { payload: {} })];

		const explanation = explainReplay(current, log);

		expect(explanation.broken).toMatchObject({ seqId: 3, state: "first", invokeSeqId: 2 });
		expect(explanation.broken?.error).toContain("payload.value");
	});

	it("treats removed validators under old validated records as broken", () => {
		const old = ast(
			chart({
				kind: "chart",
				id: "replay-test",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker"), validate: tsImport("./checks.js", "ok"), transitions: { DONE: "done" } },
					done: final(),
				},
			}),
		);
		const current = ast(
			chart({
				kind: "chart",
				id: "replay-test",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker"), transitions: { DONE: "done" } },
					done: final(),
				},
			}),
		);
		const work = actionUid(old, "work");
		const log = [args(), invoke(work, 2), complete(work, "DONE", 3), validated(work, "DONE", 4)];

		const explanation = explainReplay(current, log);

		expect(explanation.broken).toMatchObject({ seqId: 4, state: "work", invokeSeqId: 2 });
		expect(explanation.broken?.error).toContain("No pending validation");
	});

	it("allows old completions to become pending when a validator is added", () => {
		const old = ast(
			chart({
				kind: "chart",
				id: "replay-test",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker"), transitions: { DONE: "done" } },
					done: final(),
				},
			}),
		);
		const current = ast(
			chart({
				kind: "chart",
				id: "replay-test",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker"), validate: tsImport("./checks.js", "ok"), transitions: { DONE: "done" } },
					done: final(),
				},
			}),
		);
		const work = actionUid(old, "work");
		const log = [args(), invoke(work, 2), complete(work, "DONE", 3)];

		const explanation = explainReplay(current, log);

		expect(explanation.broken).toBeUndefined();
		expect(explanation.prefixEnd).toBe(log.length);
	});

	it("warns about stale action definitions without cutting", () => {
		const old = ast(
			chart({
				kind: "chart",
				id: "replay-test",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker", { task: "old" }), transitions: { DONE: "done" } },
					done: final(),
				},
			}),
		);
		const current = ast(
			chart({
				kind: "chart",
				id: "replay-test",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker", { task: "new" }), transitions: { DONE: "done" } },
					done: final(),
				},
			}),
		);
		const work = actionUid(old, "work");
		const log = [args(), invoke(work, 2, definition(old, "work"))];

		const explanation = explainReplay(current, log);

		expect(explanation.broken).toBeUndefined();
		expect(explanation.stale).toMatchObject([{ seqId: 2, state: "work", reason: "action_definition_changed" }]);
	});

	it("does not mark edge binding changes as stale", () => {
		const old = ast(
			chart({
				kind: "chart",
				id: "replay-test",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker", { task: t`same` }), transitions: { DONE: "done" } },
					done: final(),
				},
			}),
		);
		const current = ast(
			chart({
				kind: "chart",
				id: "replay-test",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker", { task: t`same` }), transitions: { DONE: "done" } },
					done: final(),
				},
			}),
		);
		const work = actionUid(old, "work");
		const log = [args(), invoke(work, 2, definition(old, "work"))];

		expect(explainReplay(current, log).stale).toEqual([]);
	});

	it("warns about changed guard provenance on validated records", () => {
		const oldGuard = tsImport("./checks.js", "oldOk");
		const newGuard = tsImport("./checks.js", "newOk");
		const old = ast(
			chart({
				kind: "chart",
				id: "replay-test",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker"), validate: oldGuard, transitions: { DONE: "done" } },
					done: final(),
				},
			}),
		);
		const current = ast(
			chart({
				kind: "chart",
				id: "replay-test",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker"), validate: newGuard, transitions: { DONE: "done" } },
					done: final(),
				},
			}),
		);
		const work = actionUid(old, "work");
		const log = [args(), invoke(work, 2, definition(old, "work")), complete(work, "DONE", 3), validated(work, "DONE", 4, oldGuard)];

		const explanation = explainReplay(current, log);

		expect(explanation.broken).toBeUndefined();
		expect(explanation.stale).toMatchObject([{ seqId: 4, state: "work", reason: "guard_changed", invokeSeqId: 2 }]);
	});

	it("replays spawned maps from old facts", () => {
		const current = ast(
			chart({
				kind: "chart",
				id: "replay-test",
				initial: "fan",
				states: {
					fan: map({
						over: arg("items"),
						initial: "work",
						onDone: "done",
						states: {
							work: { kind: "state", action: agent("worker"), transitions: { DONE: "finished" } },
							finished: final(),
						},
					}),
					done: final(),
				},
			}),
		);
		const log: DurableLogRecord[] = [
			{ type: "args", args: { items: { a: { id: "a" } } }, parentId: null, seqId: 1, timestamp: 1 },
			{ type: "spawned", path: "fan", instances: { a: { id: "a" } }, ...meta(2) },
		];

		const explanation = explainReplay(current, log);

		expect(explanation.broken).toBeUndefined();
		expect(explanation.skipped).toEqual([]);
	});
});
