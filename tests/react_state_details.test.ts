import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StateDetails } from "../packages/hyperchart/src/react/components/inspector/details/StateDetails.js";
import type { HyperchartStateInfo } from "../packages/hyperchart/src/host/models.js";

describe("StateDetails", () => {
	it("labels an initial state independently from its runtime status", () => {
		const state: HyperchartStateInfo = {
			id: "work",
			type: "agent",
			status: "pending",
			initial: true,
			agent: "worker",
		};

		const markup = renderToStaticMarkup(createElement(StateDetails, { state, allStates: [state] }));

		expect(markup).toContain('title="Initial state"');
		expect(markup).toContain(">initial</span>");
		expect(markup).toContain(">pending</span>");
	});

	it("hides descendant contracts but keeps agents in scope for compound states", () => {
		const compound: HyperchartStateInfo = { id: "write", type: "compound", status: "running" };
		const child: HyperchartStateInfo = {
			id: "write.validate",
			type: "agent",
			status: "running",
			agent: "reviewer",
			replySchema: {
				schema: {
					type: "object",
					properties: { pass: { type: "boolean" } },
					required: ["pass"],
				},
			},
		};

		const markup = renderToStaticMarkup(createElement(StateDetails, { state: compound, allStates: [compound, child] }));

		expect(markup).toContain("Agents in scope");
		expect(markup).not.toContain("Contracts in scope");
		expect(markup).not.toContain("Reply / result shape");
	});
});
