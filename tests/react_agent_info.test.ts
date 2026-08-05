import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HyperchartStateInfo } from "../packages/hyperchart/src/host/models.js";
import { AgentInfoCard } from "../packages/hyperchart/src/react/components/inspector/details/AgentInfoCard.js";
import { VisitInvocationDetails } from "../packages/hyperchart/src/react/components/inspector/details/VisitInvocationDetails.js";

describe("Agent inspector details", () => {
	it("explains declared reads and renders their artifact contract", () => {
		const state: HyperchartStateInfo = {
			id: "write",
			type: "agent",
			status: "running",
			agent: "writer",
			reads: ['artifactOf("prepare", { artifact: "context" })'],
			readArtifacts: [{
				name: "context",
				sourceState: "prepare",
				path: "artifacts/context.json",
				schema: { schema: { type: "object", description: "Context the writer must read.", properties: { risks: { type: "array", items: { type: "string" } } } } },
			}],
		};
		const markup = renderToStaticMarkup(createElement(AgentInfoCard, { state, allStates: [state] }));
		expect(markup).toContain("prepare → context");
		expect(markup).toContain("artifacts/context.json");
		expect(markup).not.toContain('title="{');
		expect(markup).not.toContain("Files supplied to the agent before it starts.");
		expect(markup).not.toContain("Context the writer must read.");
	});

	it("distinguishes joined artifact reads from single artifact reads", () => {
		const state: HyperchartStateInfo = {
			id: "write",
			type: "agent",
			status: "running",
			agent: "writer",
			reads: ['joinArtifactOf("research.collect", { artifact: "brief" })'],
			readArtifacts: [{ name: "brief", sourceState: "research.collect", path: "artifacts/source-{key}.json", readKind: "join" }],
		};
		const authored = renderToStaticMarkup(createElement(AgentInfoCard, { state, allStates: [state] }));
		const resolved = renderToStaticMarkup(createElement(VisitInvocationDetails, {
			state,
			allStates: [state],
			invocation: { kind: "agent", reads: [{ name: "brief", sourceState: "research#a.collect", path: "artifacts/source-a.json", readKind: "join" }] },
		}));
		expect(authored).toContain('data-artifact-read-kind="join"');
		expect(resolved).toContain('data-artifact-read-kind="join"');
	});

	it("keeps artifact schemas on resolved reads", () => {
		const state: HyperchartStateInfo = { id: "write", type: "agent", status: "running", agent: "writer" };
		const markup = renderToStaticMarkup(createElement(VisitInvocationDetails, {
			state,
			allStates: [state],
			invocation: {
				kind: "agent",
				reads: [{ path: "artifacts/context.json", name: "context", sourceState: "prepare", schema: { schema: { type: "object", description: "Resolved context contract.", properties: { title: { type: "string" } } } } }],
			},
		}));
		expect(markup).toContain("resolved reads");
		expect(markup).toContain("prepare → context");
		expect(markup).toContain("artifacts/context.json");
		expect(markup).not.toContain("Resolved context contract.");
		expect(markup).not.toContain("type Context");
	});

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
