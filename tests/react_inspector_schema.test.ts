import { describe, expect, it } from "vitest";
import type { HyperchartStateInfo } from "../packages/hyperchart/src/react/types.js";
import { schemaAtPath, schemaTypeText } from "../packages/hyperchart/src/react/components/inspector/helpers/schema.js";
import {
	transitionBindingDisplay,
	transitionBindingLabel,
	transitionBindingTitle,
} from "../packages/hyperchart/src/react/components/inspector/helpers/transitions.js";

const unionReplySchema = {
	schema: {
		anyOf: [
			{
				type: "object",
				properties: {
					candidate: { type: "string" },
					shared: { type: "string" },
				},
			},
			{
				type: "object",
				properties: {
					screeningAttempt: { type: "integer" },
					rejectedHypotheses: { type: "array", items: { type: "string" } },
					shared: { type: "number" },
					nested: {
						oneOf: [{ type: "object", properties: { reason: { type: "string" } } }, { type: "null" }],
					},
				},
			},
		],
	},
};

describe("Inspector schema paths", () => {
	it("resolves event fields declared by one reply union variant", () => {
		expect(schemaTypeText(schemaAtPath(unionReplySchema, "screeningAttempt"))).toBe("number");
		expect(schemaTypeText(schemaAtPath(unionReplySchema, "rejectedHypotheses"))).toBe("Array<string>");
		expect(schemaTypeText(schemaAtPath(unionReplySchema, "nested.reason"))).toBe("string");
	});

	it("shows the resolved union field type in transition binding tooltips", () => {
		const state: HyperchartStateInfo = {
			id: "candidate-selection",
			status: "running",
			replySchema: unionReplySchema,
		};
		const binding = transitionBindingDisplay("event:screeningAttempt");

		expect(transitionBindingTitle(state, binding)).toBe("number");
	});

	it("shows normalized chart argument types for arg bindings", () => {
		const state: HyperchartStateInfo = { id: "publish", status: "running" };
		const binding = transitionBindingDisplay('arg("environment")');

		expect(
			transitionBindingTitle(state, binding, [state], {
				environment: { schema: { kind: "jsonSchema", schema: { enum: ["staging", "production"] } } },
			}),
		).toBe('"staging" | "production"');
	});

	it("shows the source state input type for input bindings", () => {
		const state: HyperchartStateInfo = {
			id: "candidate-selection",
			status: "running",
			inputs: [
				{
					name: "parentHypothesisId",
					schema: { schema: { anyOf: [{ type: "string" }, { type: "null" }] } },
					required: false,
					defaulted: true,
				},
			],
		};
		const binding = transitionBindingDisplay('input("parentHypothesisId")');

		expect(binding).toEqual({
			kind: "input",
			name: "parentHypothesisId",
			preview: 'input("parentHypothesisId")',
		});
		expect(transitionBindingLabel(binding)).toBe('input("parentHypothesisId")');
		expect(transitionBindingTitle(state, binding)).toBe("string | null");
	});

	it("keeps malformed input binding previews non-semantic", () => {
		const binding = transitionBindingDisplay('input("bad\\x")');

		expect(binding).toEqual({ kind: "unknown", preview: 'input("bad\\x")' });
	});

	it("preserves differing field types from multiple reply union variants", () => {
		expect(schemaTypeText(schemaAtPath(unionReplySchema, "shared"))).toBe("string | number");
	});

	it("returns undefined when no reply union variant declares the path", () => {
		expect(schemaAtPath(unionReplySchema, "missing")).toBeUndefined();
	});
});
