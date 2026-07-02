import { describe, expect, it } from "vitest";
import { agent, chart, final, jsonSchema, normalizeChartConfig, tsImport, user } from "../src/index.js";

describe("normalizeChartConfig", () => {
	it("normalizes a valid chart into a frozen AST", () => {
		const result = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "ok",
				initial: "start",
				states: {
					start: {
						kind: "state",
						action: agent("worker", {
							output: jsonSchema({ type: "object", properties: { value: { type: "string" } } }),
						}),
						transitions: { DONE: "done", FAILED: "failed" },
					},
					done: final(),
					failed: final(),
				},
			}),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected valid chart");
		expect(result.ast.states.start?.kind).toBe("state");
		expect(Object.isFrozen(result.ast)).toBe(true);
		expect(Object.isFrozen(result.ast.states)).toBe(true);
	});

	it("normalizes validate with a default onReject of resume", () => {
		const result = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "validated",
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

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected valid chart");
		const work = result.ast.states.work;
		if (work?.kind !== "state") throw new Error("expected action state");
		expect(work.validate).toEqual({ kind: "tsImport", module: "./checks.js", export: "testsPass" });
		expect(work.onReject).toBe("resume");
	});

	it("normalizes after on an action state", () => {
		const result = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "timed",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: agent("coder"),
						after: { delayMs: 500, target: "escalated" },
						transitions: { DONE: "done" },
					},
					done: final(),
					escalated: final(),
				},
			}),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected valid chart");
		const work = result.ast.states.work;
		if (work?.kind !== "state") throw new Error("expected action state");
		expect(work.after).toEqual({ delayMs: 500, target: "escalated" });
	});

	it("rejects invalid after shapes and unknown after targets", () => {
		const badDelay = normalizeChartConfig({
			id: "bad-delay",
			initial: "work",
			states: {
				work: { action: agent("coder"), after: { delayMs: -1, target: "done" }, transitions: { DONE: "done" } },
				done: final(),
			},
		});
		expect(badDelay.ok).toBe(false);
		expect(badDelay.diagnostics.map((d) => d.code)).toContain("INVALID_AFTER");

		const unknownTarget = normalizeChartConfig({
			id: "bad-target",
			initial: "work",
			states: {
				work: { action: agent("coder"), after: { delayMs: 500, target: "missing" }, transitions: { DONE: "done" } },
				done: final(),
			},
		});
		expect(unknownTarget.ok).toBe(false);
		expect(unknownTarget.diagnostics.map((d) => d.code)).toContain("UNKNOWN_AFTER_TARGET");
	});

	it("rejects inline functions as validators", () => {
		const result = normalizeChartConfig({
			id: "inline-validate",
			initial: "work",
			states: {
				work: {
					action: agent("coder"),
					validate: () => true,
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		});

		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((d) => d.code)).toContain("INVALID_GUARD");
	});

	it("rejects onReject without validate and invalid onReject values", () => {
		const withoutValidate = normalizeChartConfig({
			id: "no-validate",
			initial: "work",
			states: {
				work: { action: agent("coder"), onReject: "resume", transitions: { DONE: "done" } },
				done: final(),
			},
		});
		expect(withoutValidate.ok).toBe(false);
		expect(withoutValidate.diagnostics.map((d) => d.code)).toContain("INVALID_ON_REJECT");

		const badValue = normalizeChartConfig({
			id: "bad-on-reject",
			initial: "work",
			states: {
				work: {
					action: agent("coder"),
					validate: tsImport("./checks.js", "testsPass"),
					onReject: "explode",
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		});
		expect(badValue.ok).toBe(false);
		expect(badValue.diagnostics.map((d) => d.code)).toContain("INVALID_ON_REJECT");
	});

	it("reports invalid initial state and transition targets", () => {
		const result = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "broken",
				initial: "missing",
				states: {
					start: { kind: "state", action: agent("worker"), transitions: { DONE: "missing" } },
				},
			}),
		);

		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((d) => d.code)).toEqual(
			expect.arrayContaining(["UNKNOWN_INITIAL_STATE", "UNKNOWN_TRANSITION_TARGET"]),
		);
	});

	it("reports missing action on non-final states", () => {
		const result = normalizeChartConfig({
			id: "broken",
			initial: "start",
			states: {
				start: {},
			},
		});

		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((d) => d.code)).toContain("MISSING_ACTION");
	});

	it("rejects custom user events named FAILED", () => {
		const result = normalizeChartConfig({
			id: "broken",
			initial: "ask",
			states: {
				ask: { action: user({ prompt: "Pick", options: ["FAILED"] }), transitions: { FAILED: "done" } },
				done: final(),
			},
		});

		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((d) => d.code)).toContain("RESERVED_EVENT_EMIT");
	});

	it("reports invalid output schema shape", () => {
		const result = normalizeChartConfig({
			id: "broken",
			initial: "start",
			states: {
				start: {
					action: { kind: "agent", name: "worker", output: { kind: "jsonSchema", schema: "nope" } },
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		});

		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((d) => d.code)).toContain("INVALID_JSON_SCHEMA");
	});
});
