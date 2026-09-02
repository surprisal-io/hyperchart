import { describe, expect, it } from "vitest";
import {
	agent,
	arg,
	chart,
	compactProjection,
	compound,
	compileProjectionRetention,
	createBranchProjection,
	final,
	map,
	normalizeChartConfig,
	parallel,
	result,
	resume,
	t,
} from "../packages/hyperchart/src/index.js";
import type { ChartAst, ChartCst } from "../packages/hyperchart/src/index.js";
import { actionUidKey } from "../packages/hyperchart/src/core/action_uid.js";

function parsed(config: ChartCst): ChartAst {
	const normalized = normalizeChartConfig(config);
	if (!normalized.ok) throw new Error(normalized.diagnostics.map((entry) => entry.message).join("\n"));
	return normalized.ast;
}

describe("projection retention", () => {
	it("discovers result readers and resumable actions from the normalized AST", () => {
		const ast = parsed(chart({
			kind: "chart",
			id: "retention",
			initial: "writer",
			states: {
				writer: {
					kind: "state",
					action: agent("writer"),
					onReenter: resume("Continue the prior writer session."),
					transitions: { DONE: "reader" },
				},
				reader: {
					kind: "state",
					action: agent("reader", { task: t`Read ${result("writer")}` }),
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		}));
		const plan = compileProjectionRetention(ast);
		const writer = ast.states.writer;
		if (writer?.kind !== "state") throw new Error("missing writer");

		expect(plan.resultReaders.get("writer")).toEqual(new Set(["reader"]));
		expect(plan.resumableActions.has(actionUidKey(writer.action.uid))).toBe(true);
		expect([...plan.reenterableStates]).toEqual(expect.arrayContaining(["writer", "reader", "done"]));
	});

	it("resolves nested compound, map, and parallel entry and exit paths", () => {
		const region = (name: string) => compound({
			initial: "work",
			states: {
				work: { kind: "state", action: agent(name), transitions: { DONE: "finished" } },
				finished: final(),
			},
		});
		const ast = parsed(chart({
			kind: "chart",
			id: "nested-retention",
			args: { items: {} },
			initial: "outer",
			states: {
				outer: compound({
					initial: "fan",
					onDone: "done",
					states: {
						fan: parallel({
							onDone: "merged",
							states: {
								left: compound({
									initial: "fanout",
									states: {
										fanout: map({
											over: arg("items"),
											onReenter: resume("Resume mapped work."),
											initial: "work",
											onDone: "leftDone",
											states: {
												work: { kind: "state", action: agent("mapped"), onReenter: resume("Resume item."), transitions: { DONE: "itemDone" } },
												itemDone: final(),
											},
										}),
										leftDone: final(),
									},
								}),
								right: region("right"),
							},
						}),
						merged: final(),
					},
				}),
				done: final(),
			},
		}));

		const reenterable = [...compileProjectionRetention(ast).reenterableStates];
		expect(reenterable).toEqual(expect.arrayContaining([
			"outer",
			"outer.fan",
			"outer.fan.left",
			"outer.fan.left.fanout",
			"outer.fan.left.fanout.work",
			"outer.fan.left.fanout.itemDone",
			"outer.fan.left.leftDone",
			"outer.fan.right",
			"outer.fan.right.work",
			"outer.fan.right.finished",
			"outer.merged",
			"done",
		]));
		for (const localId of ["fan", "left", "work", "finished"]) {
			expect(reenterable).not.toContain(localId);
		}
	});

	it("prunes only proven non-resumable sessions and conservatively retains semantic values", () => {
		const ast = parsed(chart({
			kind: "chart",
			id: "compact",
			initial: "resumable",
			states: {
				resumable: { kind: "state", action: agent("worker"), onReenter: resume("Resume."), transitions: { DONE: "restart" } },
				restart: { kind: "state", action: agent("worker"), transitions: { DONE: "done" } },
				done: final(),
			},
		}));
		const resumable = ast.states.resumable;
		const restart = ast.states.restart;
		if (resumable?.kind !== "state" || restart?.kind !== "state") throw new Error("missing actions");
		const projection = createBranchProjection(ast);
		projection.sessions[actionUidKey(resumable.action.uid)] = "resume.jsonl";
		projection.sessions[actionUidKey(restart.action.uid)] = "restart.jsonl";
		projection.inputs.restart = { input: "retain" };
		projection.results.restart = { output: "retain" };
		projection.results.done = { final: "retain" };
		projection.spawns.items = { one: 1 };
		projection.stateVisits["compact:restart:agent"] = 4;
		projection.actorProducerVisits.sender = 3;
		const retainedActors = projection.actors;
		const retainedPools = projection.actorPools;

		compactProjection(projection, ast, compileProjectionRetention(ast));

		expect(projection.sessions).toEqual({ [actionUidKey(resumable.action.uid)]: "resume.jsonl" });
		expect(projection.inputs.restart).toEqual({ input: "retain" });
		expect(projection.results.restart).toEqual({ output: "retain" });
		expect(projection.results.done).toEqual({ final: "retain" });
		expect(projection.spawns.items).toEqual({ one: 1 });
		expect(projection.stateVisits["compact:restart:agent"]).toBe(4);
		expect(projection.actorProducerVisits.sender).toBe(3);
		expect(projection.actors).toBe(retainedActors);
		expect(projection.actorPools).toBe(retainedPools);
	});
});
