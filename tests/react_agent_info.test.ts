import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HyperchartStateInfo } from "../packages/hyperchart/src/host/models.js";
import { AgentInfoCard } from "../packages/hyperchart/src/react/components/inspector/details/AgentInfoCard.js";

describe("Agent inspector details", () => {
	it("renders the loaded agent description", () => {
		const state: HyperchartStateInfo = {
			id: "analyze",
			type: "agent",
			status: "pending",
			agent: "video-review-analyzer",
			agentDescription: "Finds visual callouts against the transcript.",
		};

		const markup = renderToStaticMarkup(createElement(AgentInfoCard, { state, allStates: [state] }));

		expect(markup).toContain("Finds visual callouts against the transcript.");
	});

	it("renders symbolic role and toolset with their resolved runtime configuration", () => {
		const state: HyperchartStateInfo = {
			id: "research",
			type: "agent",
			status: "running",
			agent: "research-scout",
			role: "worker",
			model: "openai/fallback",
			resolvedModel: "deepseek/deepseek-v4-pro",
			thinking: "xhigh",
			toolset: "researching",
			tools: ["read"],
			resolvedTools: ["read", "web_search", "browser", "finish"],
		};

		const markup = renderToStaticMarkup(createElement(AgentInfoCard, { state, allStates: [state] }));

		expect(markup).toContain("role worker");
		expect(markup).toContain("deepseek/deepseek-v4-pro");
		expect(markup).toContain("toolset researching");
		expect(markup).toContain("web_search");
		expect(markup).toContain("browser");
		expect(markup).toContain("finish");
		expect(markup).not.toContain("openai/fallback");
		expect(markup).not.toContain("all tools allowed");
	});

	it("labels an unconstrained definition as using host defaults instead of all tools", () => {
		const state: HyperchartStateInfo = {
			id: "delegate",
			type: "agent",
			status: "pending",
			agent: "delegate",
		};

		const markup = renderToStaticMarkup(createElement(AgentInfoCard, { state, allStates: [state] }));

		expect(markup).toContain("host default tools");
		expect(markup).not.toContain("all tools allowed");
	});

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
