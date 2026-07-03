import { describe, expect, it } from "vitest";
import {
	agent,
	chart,
	arg,
	compound,
	final,
	item,
	json,
	key,
	map,
	normalizeChartConfig,
	parallel,
	result,
	t,
	tsImport,
} from "../src/index.js";
import { loop, start } from "../src/core/execution_loop.js";
import type { ChartAst, ChartCst, DurableLogRecord, GuardOutcome, MachineEvent } from "../src/index.js";
import { failOnPullEvents, MockRuntime } from "./mock_runtime.js";

// The acceptance suite for the engine's core promise: a crashed run restarts from its log
// without re-running any completed work, and a log keeps applying to a modified chart as long
// as its facts still make sense there.

function make(config: ChartCst): ChartAst {
	const result = normalizeChartConfig(config);
	if (!result.ok) throw new Error(`gauntlet chart should be valid: ${JSON.stringify(result.diagnostics)}`);
	return result.ast;
}

type AgentReply = string | { type: string; output?: unknown };

type LiveOptions = {
	logs?: readonly DurableLogRecord[];
	args?: Readonly<Record<string, unknown>>;
	// state path → successive replies of its agent (rejections retry from the same queue)
	agents?: Record<string, AgentReply[]>;
	// successive validator verdicts
	verdicts?: GuardOutcome[];
	fireTimers?: boolean;
};

// Drives a full live run: scripted agent replies, verdicts and timers, every appended record
// collected — the returned log is exactly what a durable store would hold afterwards.
async function runLive(ast: ChartAst, options: LiveOptions = {}) {
	const agents = new Map(Object.entries(options.agents ?? {}).map(([state, replies]) => [state, [...replies]]));
	const verdicts = [...(options.verdicts ?? [])];
	const events: MachineEvent[] = [];
	const appended: DurableLogRecord[] = [];
	const runtime = new MockRuntime({
		ast,
		logs: options.logs ?? [],
		events,
		onRunEffects(effects) {
			for (const effect of effects) {
				switch (effect.kind) {
					case "agent":
					case "rejected": {
						const reply = agents.get(effect.actionUid.state)?.shift();
						if (reply !== undefined) {
							events.push({
								kind: "agent",
								effectId: effect.id,
								event: typeof reply === "string" ? { type: reply } : reply,
							});
						}
						break;
					}
					case "validate": {
						const outcome = verdicts.shift();
						if (outcome === undefined) throw new Error("unexpected validate effect");
						events.push({ kind: "validated", effectId: effect.id, outcome });
						break;
					}
					case "timer":
						if (options.fireTimers) {
							events.push({ kind: "timer", effectId: effect.id });
						}
						break;
					case "durable_records":
						appended.push(...effect.records);
						events.push({ kind: "durable_records_added", effectId: effect.id, records: effect.records });
						break;
					case "cancel":
					case "user":
						break;
				}
			}
		},
	});
	const state = await (options.args === undefined ? loop(runtime) : start(runtime, options.args));
	return { state, runtime, log: [...(options.logs ?? []), ...appended] };
}

async function replay(ast: ChartAst, log: readonly DurableLogRecord[]) {
	const runtime = new MockRuntime({ ast, logs: log, events: failOnPullEvents() });
	const state = await loop(runtime);
	return { state, runtime };
}

function paramChart(): ChartAst {
	return make(
		chart({
			kind: "chart",
			id: "gauntlet-params",
			initial: "plan",
			states: {
				plan: {
					kind: "state",
					action: agent("planner", { task: t`Plan ${arg("topic")}.` }),
					transitions: { PLAN_READY: "build" },
				},
				build: {
					kind: "state",
					action: agent("builder", { task: t`Build ${arg("topic")} following ${json(result("plan", "steps"))}.` }),
					transitions: { BUILT: "done" },
				},
				done: final(),
			},
		}),
	);
}

function twoStepChart(): ChartAst {
	return make(
		chart({
			kind: "chart",
			id: "gauntlet-linear",
			initial: "first",
			states: {
				first: { kind: "state", action: agent("first-worker"), transitions: { FIRST_DONE: "second" } },
				second: { kind: "state", action: agent("second-worker"), transitions: { SECOND_DONE: "done" } },
				done: final(),
			},
		}),
	);
}

function validatedChart(): ChartAst {
	return make(
		chart({
			kind: "chart",
			id: "gauntlet-validated",
			initial: "work",
			states: {
				work: {
					kind: "state",
					action: agent("coder"),
					validate: tsImport("./checks.js", "testsPass"),
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		}),
	);
}

function timedChart(): ChartAst {
	return make(
		chart({
			kind: "chart",
			id: "gauntlet-timed",
			initial: "work",
			states: {
				work: {
					kind: "state",
					action: agent("slowpoke"),
					after: { delayMs: 500, target: "escalated" },
					transitions: { DONE: "done" },
				},
				done: final(),
				escalated: final(),
			},
		}),
	);
}

function nestedChart(): ChartAst {
	return make(
		chart({
			kind: "chart",
			id: "gauntlet-nested",
			initial: "review",
			states: {
				review: compound({
					initial: "analyze",
					onDone: "deploy",
					states: {
						analyze: { kind: "state", action: agent("analyzer"), transitions: { OK: "fix" } },
						fix: { kind: "state", action: agent("fixer"), transitions: { OK: "verified" } },
						verified: final(),
					},
					transitions: { FAILED: "escalate" },
				}),
				deploy: final(),
				escalate: final(),
			},
		}),
	);
}

function parallelChart(): ChartAst {
	const region = (worker: string) =>
		compound({
			initial: "scan",
			states: {
				scan: { kind: "state" as const, action: agent(worker), transitions: { OK: "ok" } },
				ok: final(),
			},
		});
	return make(
		chart({
			kind: "chart",
			id: "gauntlet-parallel",
			initial: "audit",
			states: {
				audit: parallel({
					states: { security: region("security-bot"), perf: region("perf-bot") },
					onDone: "merge",
					transitions: { FAILED: "escalate" },
				}),
				merge: final(),
				escalate: final(),
			},
		}),
	);
}

function mapChart(concurrency?: number): ChartAst {
	return make(
		chart({
			kind: "chart",
			id: "gauntlet-map",
			initial: "plan",
			states: {
				plan: {
					kind: "state",
					action: agent("planner"),
					transitions: { PLAN_READY: "chapters" },
				},
				chapters: map({
					over: result("plan", "chapters"),
					...(concurrency === undefined ? {} : { concurrency }),
					initial: "author",
					onDone: "done",
					states: {
						author: {
							kind: "state",
							action: agent("author", { task: t`Write ${key()}: ${item("title")}` }),
							transitions: { AUTHORED: "written" },
						},
						written: final(),
					},
					transitions: { FAILED: "escalate" },
				}),
				done: final(),
				escalate: final(),
			},
		}),
	);
}

const MAP_PLAN_REPLY: AgentReply = {
	type: "PLAN_READY",
	output: { chapters: { intro: { title: "Intro" }, body: { title: "Body" } } },
};

type Scenario = {
	name: string;
	ast: () => ChartAst;
	options: LiveOptions;
	finalLeaves: string[];
};

const SCENARIOS: Scenario[] = [
	{
		name: "linear two-step",
		ast: twoStepChart,
		options: { agents: { first: ["FIRST_DONE"], second: ["SECOND_DONE"] } },
		finalLeaves: ["done"],
	},
	{
		name: "validation cycle with a rejected round",
		ast: validatedChart,
		options: { agents: { work: ["DONE", "DONE"] }, verdicts: [{ ok: false, reason: "tests failing" }, true] },
		finalLeaves: ["done"],
	},
	{
		name: "deadline escalation",
		ast: timedChart,
		options: { fireTimers: true },
		finalLeaves: ["escalated"],
	},
	{
		name: "compound completed through onDone",
		ast: nestedChart,
		options: { agents: { "review.analyze": ["OK"], "review.fix": ["OK"] } },
		finalLeaves: ["deploy"],
	},
	{
		name: "parallel join",
		ast: parallelChart,
		options: { agents: { "audit.security.scan": ["OK"], "audit.perf.scan": ["OK"] } },
		finalLeaves: ["merge"],
	},
	{
		name: "parallel abort",
		ast: parallelChart,
		options: { agents: { "audit.security.scan": ["FAILED"] } },
		finalLeaves: ["escalate"],
	},
	{
		// The spawned fact replays the fan-out: instance paths, key/item rendering and the join
		// are all recomputed from the log without touching `over` again.
		name: "map fan-out and join",
		ast: mapChart,
		options: {
			agents: {
				plan: [MAP_PLAN_REPLY],
				"chapters#intro.author": ["AUTHORED"],
				"chapters#body.author": ["AUTHORED"],
			},
		},
		finalLeaves: ["done"],
	},
	{
		// One instance's FAILED bubbles to the map's own transitions and aborts ALL instances.
		name: "map abort",
		ast: mapChart,
		options: { agents: { plan: [MAP_PLAN_REPLY], "chapters#intro.author": ["FAILED"] } },
		finalLeaves: ["escalate"],
	},
	{
		// The args fact and result payloads replay from the log; the replay runtime has no
		// loadArgs at all.
		name: "parameter flow (args + results + input)",
		ast: paramChart,
		options: {
			args: { topic: "AI report" },
			agents: { plan: [{ type: "PLAN_READY", output: { steps: ["a", "b"] } }], build: ["BUILT"] },
		},
		finalLeaves: ["done"],
	},
];

describe("replay gauntlet", () => {
	for (const scenario of SCENARIOS) {
		it(`${scenario.name}: full replay is silent and deterministic`, async () => {
			const ast = scenario.ast();
			const live = await runLive(ast, scenario.options);
			expect(live.state.projection.activeLeaves).toEqual(scenario.finalLeaves);
			expect(live.state.projection.pendingActions).toEqual([]);

			// Zero re-invocation: a completed log replays without a single effect — no agents, no
			// validators, no timers, no cancels, nothing appended.
			const first = await replay(ast, live.log);
			expect(first.runtime.effectBatches).toEqual([]);
			expect(JSON.stringify(first.state.projection)).toBe(JSON.stringify(live.state.projection));

			// Determinism: two replays of the same log produce byte-identical projections.
			const second = await replay(ast, live.log);
			expect(JSON.stringify(second.state.projection)).toBe(JSON.stringify(first.state.projection));
		});
	}

	it("crash mid-validation: the validator re-runs, the agent does not", async () => {
		const ast = validatedChart();
		const live = await runLive(ast, { agents: { work: ["DONE"] }, verdicts: [true] });
		// Cut the log right after the completion claim: the verdict never landed.
		const prefix = live.log.filter((record) => !(record.type === "state_action" && record.kind === "validated"));

		const resumed = await runLive(ast, { logs: prefix, verdicts: [true] });

		expect(resumed.state.projection.activeLeaves).toEqual(["done"]);
		const kinds = resumed.runtime.effectBatches.flat().map((effect) => effect.kind);
		expect(kinds.filter((kind) => kind === "agent")).toEqual([]);
		expect(kinds.filter((kind) => kind === "validate")).toEqual(["validate"]);
	});

	it("crash mid-flight: only the unfinished step re-runs", async () => {
		const ast = twoStepChart();
		const live = await runLive(ast, { agents: { first: ["FIRST_DONE"], second: ["SECOND_DONE"] } });
		// Cut the log after second's invoke: the agent was running when the process died.
		const prefix = live.log.slice(0, 3);

		const resumed = await runLive(ast, { logs: prefix, agents: { second: ["SECOND_DONE"] } });

		expect(resumed.state.projection.activeLeaves).toEqual(["done"]);
		const agentRuns = resumed.runtime.effectBatches
			.flat()
			.flatMap((effect) => (effect.kind === "agent" ? [effect.actionUid.state] : []));
		expect(agentRuns).toEqual(["second"]);
	});

	it("crash mid-fan-out: spawned instances are pinned, only unfinished ones re-run", async () => {
		const ast = mapChart(1);
		const live = await runLive(ast, {
			agents: {
				plan: [MAP_PLAN_REPLY],
				"chapters#intro.author": ["AUTHORED"],
				"chapters#body.author": ["AUTHORED"],
			},
		});
		expect(live.state.projection.activeLeaves).toEqual(["done"]);
		// Cut right after intro's completion: with concurrency 1, body was never even started.
		const cut = live.log.findIndex(
			(record) =>
				record.type === "state_action" && record.kind === "complete" && record.actionUid.state.includes("#intro"),
		);
		const prefix = live.log.slice(0, cut + 1);

		const resumed = await runLive(ast, { logs: prefix, agents: { "chapters#body.author": ["AUTHORED"] } });

		expect(resumed.state.projection.activeLeaves).toEqual(["done"]);
		const agentRuns = resumed.runtime.effectBatches
			.flat()
			.flatMap((effect) => (effect.kind === "agent" ? [effect.actionUid.state] : []));
		expect(agentRuns).toEqual(["chapters#body.author"]);
		// The fan-out is a fact: resuming does not re-resolve `over` — no second spawned record.
		expect(resumed.log.filter((record) => record.type === "spawned")).toHaveLength(1);
	});

	it("modified chart: a step added inside the map body re-opens every logged instance", async () => {
		const v1 = mapChart();
		const live = await runLive(v1, {
			agents: {
				plan: [MAP_PLAN_REPLY],
				"chapters#intro.author": ["AUTHORED"],
				"chapters#body.author": ["AUTHORED"],
			},
		});
		expect(live.state.projection.activeLeaves).toEqual(["done"]);

		// v2 routes AUTHORED into a brand-new per-instance review step.
		const v2 = make(
			chart({
				kind: "chart",
				id: "gauntlet-map",
				initial: "plan",
				states: {
					plan: {
						kind: "state",
						action: agent("planner"),
						transitions: { PLAN_READY: "chapters" },
					},
					chapters: map({
						over: result("plan", "chapters"),
						initial: "author",
						onDone: "done",
						states: {
							author: {
								kind: "state",
								action: agent("author", { task: t`Write ${key()}: ${item("title")}` }),
								transitions: { AUTHORED: "review" },
							},
							review: {
								kind: "state",
								action: agent("map-reviewer"),
								transitions: { OK: "written" },
							},
							written: final(),
						},
						transitions: { FAILED: "escalate" },
					}),
					done: final(),
					escalate: final(),
				},
			}),
		);
		const resumed = await runLive(v2, {
			logs: live.log,
			agents: { "chapters#intro.review": ["OK"], "chapters#body.review": ["OK"] },
		});

		expect(resumed.state.projection.activeLeaves).toEqual(["done"]);
		const agentRuns = resumed.runtime.effectBatches
			.flat()
			.flatMap((effect) => (effect.kind === "agent" ? [effect.actionUid.state] : []));
		// The spawn fact and both AUTHORED completions were reused as-is; only the new step ran.
		expect(agentRuns.sort()).toEqual(["chapters#body.review", "chapters#intro.review"]);
	});

	it("modified chart: the logged prefix is reused, the new route continues live", async () => {
		const v1 = make(
			chart({
				kind: "chart",
				id: "gauntlet-evolve",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker"), transitions: { DONE: "done" } },
					done: final(),
				},
			}),
		);
		const live = await runLive(v1, { agents: { work: ["DONE"] } });
		expect(live.state.projection.activeLeaves).toEqual(["done"]);

		// v2 reroutes DONE into a brand-new review step.
		const v2 = make(
			chart({
				kind: "chart",
				id: "gauntlet-evolve",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker"), transitions: { DONE: "review" } },
					review: { kind: "state", action: agent("reviewer"), transitions: { OK: "done" } },
					done: final(),
				},
			}),
		);
		const resumed = await runLive(v2, { logs: live.log, agents: { review: ["OK"] } });

		expect(resumed.state.projection.activeLeaves).toEqual(["done"]);
		const agentRuns = resumed.runtime.effectBatches
			.flat()
			.flatMap((effect) => (effect.kind === "agent" ? [effect.actionUid.state] : []));
		// work's DONE fact was reused as-is; only the new step actually ran.
		expect(agentRuns).toEqual(["review"]);
	});

	it("modified chart: validation added later checks the logged completion live", async () => {
		const v1 = make(
			chart({
				kind: "chart",
				id: "gauntlet-validate-later",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("coder"), transitions: { DONE: "done" } },
					done: final(),
				},
			}),
		);
		const live = await runLive(v1, { agents: { work: ["DONE"] } });

		const v2 = make(
			chart({
				kind: "chart",
				id: "gauntlet-validate-later",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: agent("coder"),
						validate: tsImport("./checks.js", "testsPass"),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
		);
		const resumed = await runLive(v2, { logs: live.log, verdicts: [true] });

		expect(resumed.state.projection.activeLeaves).toEqual(["done"]);
		const kinds = resumed.runtime.effectBatches.flat().map((effect) => effect.kind);
		expect(kinds.filter((kind) => kind === "agent")).toEqual([]);
		expect(kinds.filter((kind) => kind === "validate")).toEqual(["validate"]);
	});

	it("modified chart: a fact the chart cannot apply fails loud", async () => {
		const v1 = make(
			chart({
				kind: "chart",
				id: "gauntlet-breaking",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker"), transitions: { DONE: "done" } },
					done: final(),
				},
			}),
		);
		const live = await runLive(v1, { agents: { work: ["DONE"] } });

		// v2 renamed the event: the logged DONE has no route anymore.
		const v2 = make(
			chart({
				kind: "chart",
				id: "gauntlet-breaking",
				initial: "work",
				states: {
					work: { kind: "state", action: agent("worker"), transitions: { SHIP: "done" } },
					done: final(),
				},
			}),
		);
		const runtime = new MockRuntime({ ast: v2, logs: live.log, events: failOnPullEvents() });

		await expect(loop(runtime)).rejects.toThrow("No transition for event type DONE in state work");
	});
});
