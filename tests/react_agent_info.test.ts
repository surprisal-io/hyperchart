import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HyperchartStateInfo } from "../src/host/models.js";
import { AgentInfoCard } from "../src/react/components/inspector/details/AgentInfoCard.js";

describe("Agent inspector details", () => {
	it("warns when the referenced agent definition cannot be loaded", () => {
		const state: HyperchartStateInfo = {
			id: "analyze",
			type: "agent",
			status: "pending",
			agent: "video-review-analyzer",
			agentDefinitionUnavailable: true,
		};

		const markup = renderToStaticMarkup(createElement(AgentInfoCard, { state, allStates: [state] }));

		expect(markup).toContain('role="alert"');
		expect(markup).toContain("Agent definition could not be loaded");
		expect(markup).toContain("this state cannot run");
		expect(markup).toContain("unavailable");
		expect(markup).not.toContain("all tools allowed");
	});
});
