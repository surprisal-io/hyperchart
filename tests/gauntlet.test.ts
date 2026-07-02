import { describe, expect, it } from "vitest";
import { agent, chart, compound, final, normalizeChartConfig, parallel, tsImport } from "../src/index.js";
import { loop } from "../src/core/execution_loop.js";
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

type LiveOptions = {
	logs?: readonly DurableLogRecord[];
	// state path → successive event types its agent replies with (rejections retry from the same queue)
	agents?: Record<string, string[]>;
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
						const eventType = agents.get(effect.actionUid.state)?.shift();
						if (eventType !== undefined) {
							events.push({ kind: "agent", effectId: effect.id, event: { type: eventType } });
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
	const state = await loop(runtime);
	return { state, runtime, log: [...(options.logs ?? []), ...appended] };
}

async function replay(ast: ChartAst, log: readonly DurableLogRecord[]) {
	const runtime = new MockRuntime({ ast, logs: log, events: failOnPullEvents() });
	const state = await loop(runtime);
	return { state, runtime };
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
