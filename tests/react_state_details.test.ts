import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunOverview } from "../packages/hyperchart/src/react/components/inspector/details/RunOverview.js";
import { StateDetails } from "../packages/hyperchart/src/react/components/inspector/details/StateDetails.js";
import { TemplateTextBlock } from "../packages/hyperchart/src/react/components/inspector/prompt/TemplateTextBlock.js";
import { runningRun } from "../packages/hyperchart/src/react/fixtures/hyperchart-fixtures.js";
import type { HyperchartStateInfo } from "../packages/hyperchart/src/host/models.js";

describe("StateDetails", () => {
	it("keeps Overview focused on arguments and metadata without duplicating graph activity", () => {
		const markup = renderToStaticMarkup(createElement(RunOverview, { run: runningRun }));
		expect(markup).toContain("Run arguments");
		expect(markup).toContain("Run metadata");
		expect(markup).not.toContain("Current activity");
		expect(markup).not.toContain("No state running right now");
	});

	it("distinguishes the owning repository from the selected branch action workspace", () => {
		const markup = renderToStaticMarkup(createElement(RunOverview, {
			run: { ...runningRun, cwd: "/project/repo", branchWorkspace: "/runs/example/workspaces/main" },
		}));
		expect(markup).toContain("project / repository");
		expect(markup).toContain("/project/repo");
		expect(markup).toContain("branch workspace (action cwd)");
		expect(markup).toContain("/runs/example/workspaces/main");
		expect(markup).toContain("not in the project repository");
	});

	it("reveals an artifact contract contextually without a generic Refs section", () => {
		const producer: HyperchartStateInfo = {
			id: "prepare",
			type: "script",
			status: "done",
			artifacts: [{ name: "context", path: "artifacts/context.json", schema: { schema: { type: "object", properties: { title: { type: "string" } } } } }],
		};
		const reader: HyperchartStateInfo = {
			id: "write",
			type: "agent",
			status: "running",
			agent: "writer",
			reads: ['artifactOf("prepare", { artifact: "context" })'],
			readArtifacts: [{ name: "context", sourceState: "prepare", path: "artifacts/context.json", schema: { schema: { type: "object", properties: { title: { type: "string" } } } } }],
			refs: { artifact: ['artifactOf("prepare", { artifact: "context" })'] },
		};
		const markup = renderToStaticMarkup(createElement(StateDetails, {
			state: reader,
			allStates: [producer, reader],
			highlightedArtifact: { stateId: "prepare", name: "context" },
			revealedArtifactStateIds: ["prepare"],
			onHighlightArtifact: () => undefined,
		}));
		expect(markup).toContain("prepare → context");
		expect(markup).toContain('id="artifact-contract-prepare-context"');
		expect(markup).toContain("Contracts in scope");
		expect(markup).not.toContain(">Refs<");
	});

	it("does not fade or expand a prompt that fits", () => {
		const state: HyperchartStateInfo = { id: "write", type: "agent", status: "running", agent: "writer", taskPrompt: "Short prompt." };
		const markup = renderToStaticMarkup(createElement(StateDetails, { state, allStates: [state] }));
		expect(markup).toContain("Short prompt.");
		expect(markup).not.toContain("after:bg-gradient-to-t");
		expect(markup).not.toContain("Open full</button>");
	});

	it("wraps prompts, buffers oversized DOM text, and exposes expansion", () => {
		const state: HyperchartStateInfo = {
			id: "write",
			type: "agent",
			status: "running",
			agent: "writer",
			taskPrompt: "A very long prompt ".repeat(500),
		};
		const markup = renderToStaticMarkup(createElement(StateDetails, { state, allStates: [state] }));
		expect(markup).toContain("max-h-[calc(2.9em+1rem)]");
		expect(markup).toContain("whitespace-normal");
		expect(markup).toContain("Open full</button>");
		expect(markup).toContain("…");
		expect(markup).toContain("A very long prompt A very long prompt");
	});

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

	it("renders final outcome and terminal notification parameters", () => {
		const producer: HyperchartStateInfo = {
			id: "prepare",
			type: "agent",
			status: "done",
			replySchema: { schema: { type: "object", properties: { summary: { type: "string" } } } },
			artifacts: [{ name: "report", path: "artifacts/final-report.json", schema: { schema: { type: "object" } } }],
		};
		const terminal: HyperchartStateInfo = {
			id: "final",
			type: "final",
			final: true,
			status: "done",
			finalConfig: {
				outcome: "complete",
				notify: {
					prompt: 'Report completed: {result("prepare", "summary")}',
					scope: "prepare",
					artifacts: [{ name: "report", sourceState: "prepare", path: "artifacts/final-report.json", schema: { schema: { type: "object" } } }],
				},
			},
		};
		const markup = renderToStaticMarkup(createElement(StateDetails, {
			state: terminal,
			allStates: [producer, terminal],
			onHighlightReply: () => undefined,
			onHighlightArtifact: () => undefined,
		}));
		expect(markup).toContain("Final outcome");
		expect(markup).toContain("complete");
		expect(markup).toContain("notification prompt");
		expect(markup).toContain("scope prepare");
		expect(markup).toContain("prepare → report");
		expect(markup).toContain("artifacts/final-report.json");
	});

	it("renders script template refs with the shared interpolation renderer", () => {
		const producer: HyperchartStateInfo = {
			id: "prepare-data",
			type: "agent",
			status: "done",
			replySchema: { schema: { type: "object", properties: { title: { type: "string" } } } },
		};
		const scriptState: HyperchartStateInfo = { id: "render", type: "script", status: "pending" };
		const markup = renderToStaticMarkup(createElement(TemplateTextBlock, {
			text: '{json(result("prepare-data"))}',
			state: scriptState,
			allStates: [producer, scriptState],
			compact: true,
			onHighlightReply: () => undefined,
		}));
		expect(markup).toContain('json(result(&quot;');
		expect(markup).toContain("prepare-data");
		expect(markup).toContain("text-[var(--hc-cyan-text)]");
		expect(markup).toContain("${json(result(");
	});

	it("renders transition target inputs as one object type", () => {
		const source: HyperchartStateInfo = {
			id: "review",
			type: "agent",
			status: "done",
			completedEvent: "REVIEW_REQUIRED",
			transitions: [{
				event: "REVIEW_REQUIRED",
				target: "review-follow-up",
				input: { draft: "event:draft", score: "event:score" },
			}],
		};
		const target: HyperchartStateInfo = {
			id: "review-follow-up",
			type: "agent",
			status: "running",
			inputs: [
				{ name: "draft", schema: { schema: { type: "string" } }, required: true },
				{ name: "score", schema: { schema: { type: "number" } }, required: true },
			],
		};
		const markup = renderToStaticMarkup(createElement(StateDetails, { state: source, allStates: [source, target] }));
		expect(markup.match(/target input type/g)).toHaveLength(1);
		expect(markup).toContain("ReviewFollowUpInput");
		expect(markup).toContain("draft");
		expect(markup).toContain("score");
		expect(markup).not.toContain("DraftInput");
		expect(markup).not.toContain("ScoreInput");
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
