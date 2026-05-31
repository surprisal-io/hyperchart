import { describe, expect, it } from "vitest";
import { agent, chart, final, jsonSchema, normalizeChartConfig, user } from "../src/index.js";

describe("normalizeChartConfig", () => {
	it("normalizes a valid chart into a frozen AST", () => {
		const result = normalizeChartConfig(
			chart({
				id: "ok",
				initial: "start",
				states: {
					start: {
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

	it("reports invalid initial state and transition targets", () => {
		const result = normalizeChartConfig(
			chart({
				id: "broken",
				initial: "missing",
				states: {
					start: { action: agent("worker"), transitions: { DONE: "missing" } },
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
