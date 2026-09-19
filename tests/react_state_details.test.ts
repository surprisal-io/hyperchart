/** @vitest-environment jsdom */
import { z } from "zod";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { agent, chart, final, script } from "../packages/hyperchart/src/core/dsl.js";
import { storyScenario } from "../packages/hyperchart/src/react/fixtures/story-scenario.js";
import { RunOverview } from "../packages/hyperchart/src/react/components/inspector/details/RunOverview.js";
import { StateDetails } from "../packages/hyperchart/src/react/components/inspector/details/StateDetails.js";
import { TemplateTextBlock } from "../packages/hyperchart/src/react/components/inspector/prompt/TemplateTextBlock.js";
import { runningRun } from "../packages/hyperchart/src/react/fixtures/hyperchart-fixtures.js";
import { emitStoryRun, pendingGateRun } from "../packages/hyperchart/src/react/fixtures/gate-emit-fixtures.js";
import { stateKindMeta } from "../packages/hyperchart/src/react/components/inspector/helpers/state.js";
import type { HyperchartStateInfo } from "../packages/hyperchart/src/host/models.js";

afterEach(cleanup);

describe("StateDetails", () => {
	it("keeps Overview focused on arguments and metadata without duplicating graph activity", () => {
		const markup = renderToStaticMarkup(createElement(RunOverview, { run: runningRun }));
		expect(markup).toContain("Run arguments");
		expect(markup).toContain("Run metadata");
		expect(markup).not.toContain("Current activity");
		expect(markup).not.toContain("No state running right now");
	});

	it("distinguishes the owning repository from the selected branch action workspace", () => {
		const markup = renderToStaticMarkup(
			createElement(RunOverview, {
				run: { ...runningRun, cwd: "/project/repo", branchWorkspace: "/runs/example/workspaces/main" },
			}),
		);
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
			artifacts: [
				{
					name: "context",
					path: "artifacts/context.json",
					schema: { schema: { type: "object", properties: { title: { type: "string" } } } },
				},
			],
		};
		const reader: HyperchartStateInfo = {
			id: "write",
			type: "agent",
			status: "running",
			agent: "writer",
			reads: ['artifactOf("prepare", { artifact: "context" })'],
			readArtifacts: [
				{
					name: "context",
					sourceState: "prepare",
					path: "artifacts/context.json",
					schema: { schema: { type: "object", properties: { title: { type: "string" } } } },
				},
			],
			refs: { artifact: ['artifactOf("prepare", { artifact: "context" })'] },
		};
		const markup = renderToStaticMarkup(
			createElement(StateDetails, {
				state: reader,
				allStates: [producer, reader],
				highlightedArtifact: { stateId: "prepare", name: "context" },
				revealedArtifactStateIds: ["prepare"],
				onHighlightArtifact: () => undefined,
			}),
		);
		expect(markup).toContain("prepare → context");
		expect(markup).toContain('id="artifact-contract-prepare-context"');
		expect(markup).toContain("Contracts in scope");
		expect(markup).not.toContain(">Refs<");
	});

	it("does not fade or expand a prompt that fits", () => {
		const state: HyperchartStateInfo = {
			id: "write",
			type: "agent",
			status: "running",
			agent: "writer",
			taskPrompt: "Short prompt.",
		};
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

	it("renders a pending host gate with its own badge and without agent-only validation details", () => {
		const state = pendingGateRun.states.find((candidate) => candidate.id === "release-gate");
		expect(state).toBeDefined();
		if (state === undefined) {
			return;
		}
		expect(state).toMatchObject({ type: "gate", status: "waiting" });
		expect(state.validationPolicy).toBeUndefined();
		expect(state.validationAttempts).toBeUndefined();
		const meta = stateKindMeta(state);
		expect(meta.label).toBe("gate");
		expect(meta.className).toContain("yellow");
		expect(meta.Icon).not.toBe(stateKindMeta({ ...state, type: "agent" }).Icon);
		expect(meta.Icon).not.toBe(stateKindMeta({ ...state, type: "user" }).Icon);

		expect(state).toMatchObject({
			gateEvent: "release.approval-requested",
			gatePayload: {
				releaseId: { kind: "arg", name: "releaseId", preview: 'arg("releaseId")' },
				environment: { kind: "arg", name: "environment", preview: 'arg("environment")' },
			},
		});
		const onHighlightRef = vi.fn();
		render(
			createElement(StateDetails, {
				state,
				allStates: pendingGateRun.states,
				...(pendingGateRun.launchArgs === undefined ? {} : { launchArgs: pendingGateRun.launchArgs }),
				onHighlightRef,
			}),
		);

		expect(screen.getByText("gate", { selector: "span" })).toBeTruthy();
		expect(screen.getByText("Gate request")).toBeTruthy();
		expect(screen.getByText("release.approval-requested", { selector: "code" })).toBeTruthy();
		const releaseArg = screen.getAllByRole("button", { name: 'arg("releaseId")' }).at(0);
		if (releaseArg === undefined) {
			throw new Error("releaseId argument chip missing");
		}
		fireEvent.pointerEnter(releaseArg);
		expect(screen.getByRole("tooltip").textContent).toContain("string");
		fireEvent.click(releaseArg);
		expect(onHighlightRef).toHaveBeenCalledWith('arg("releaseId")');
		expect(screen.queryByText("Validation guard")).toBeNull();
		expect(screen.queryByText("Agent")).toBeNull();
	});

	it("renders declared emit payload sources and schemas as contracts", () => {
		const state = emitStoryRun.states.find((candidate) => candidate.id === "publish");
		expect(state).toBeDefined();
		if (state === undefined) {
			return;
		}

		expect(state.emits?.[0]?.payload).toMatchObject({
			release: {
				environment: { kind: "arg", name: "environment" },
				state: {
					nestedPath: { kind: "result", state: "publish", path: "state.nested.path" },
				},
			},
			metrics: { attempts: 2, verified: true, absent: null },
		});
		const entries = (state.emits?.[0]?.payload as { entries?: unknown[] } | undefined)?.entries;
		expect(entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "result",
					label: expect.objectContaining({ kind: "result", path: "state.nested.path" }),
				}),
				expect.objectContaining({
					type: "input",
					label: expect.objectContaining({ kind: "input", name: "request", path: "path" }),
				}),
			]),
		);
		const markup = renderToStaticMarkup(
			createElement(StateDetails, {
				state,
				allStates: emitStoryRun.states,
				...(emitStoryRun.launchArgs === undefined ? {} : { launchArgs: emitStoryRun.launchArgs }),
			}),
		);

		expect(markup).toContain("Contracts");
		expect(markup).toContain("emits");
		expect(markup).toContain("release.published");
		expect(markup).toContain("&quot;nestedPath&quot;");
		expect(markup).toContain("result(&quot;publish&quot;, &quot;state.nested.path&quot;)");
		expect(markup).toContain("inline-flex whitespace-nowrap");
		expect(markup).toContain("ReleasePublishedPayload");
		expect(markup).toContain("release.metrics-recorded");
		expect(markup).not.toContain("ReleaseMetricsRecordedPayload");

		const onHighlightReply = vi.fn();
		render(
			createElement(StateDetails, {
				state,
				allStates: emitStoryRun.states,
				...(emitStoryRun.launchArgs === undefined ? {} : { launchArgs: emitStoryRun.launchArgs }),
				onHighlightReply,
			}),
		);
		const nestedRef = screen.getAllByRole("button", { name: 'result("publish", "state.nested.path")' }).at(0);
		if (nestedRef === undefined) {
			throw new Error("nested result chip missing");
		}
		fireEvent.pointerEnter(nestedRef);
		expect(screen.getByRole("tooltip").textContent).toContain("string");
		fireEvent.click(nestedRef);
		expect(onHighlightReply).toHaveBeenCalledWith("publish", "state.nested.path");
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
					artifacts: [
						{
							name: "report",
							sourceState: "prepare",
							path: "artifacts/final-report.json",
							schema: { schema: { type: "object" } },
						},
					],
				},
			},
		};
		const markup = renderToStaticMarkup(
			createElement(StateDetails, {
				state: terminal,
				allStates: [producer, terminal],
				onHighlightReply: () => undefined,
				onHighlightArtifact: () => undefined,
			}),
		);
		expect(markup).toContain("Final outcome");
		expect(markup).toContain("complete");
		expect(markup).toContain("notification prompt");
		expect(markup).toContain("scope prepare");
		expect(markup).toContain("prepare → report");
		expect(markup).toContain("artifacts/final-report.json");
	});

	it("renders script template refs with the shared interpolation renderer", () => {
		const run = storyScenario(
			chart({
				kind: "chart",
				id: "script-result-link",
				initial: "prepare-data",
				states: {
					"prepare-data": {
						kind: "state",
						action: agent("producer", { reply: z.object({ title: z.string() }) }),
						transitions: { DONE: "render" },
					},
					render: { kind: "state", action: script("node", []), transitions: { DONE: "done" } },
					done: final(),
				},
			}),
		).staticRun();
		const scriptState = run.states.find((state) => state.id === "render")!;
		const onHighlightReply = vi.fn();
		render(
			createElement(TemplateTextBlock, {
				text: '{json(result("prepare-data"))}',
				state: scriptState,
				allStates: run.states,
				compact: true,
				onHighlightReply,
			}),
		);
		const link = screen.getByRole("button", { name: '${json(result("prepare-data"))}' });
		fireEvent.click(link);
		expect(onHighlightReply).toHaveBeenCalledExactlyOnceWith("prepare-data", "");
	});

	it("renders transition target inputs as one object type", () => {
		const source: HyperchartStateInfo = {
			id: "review",
			type: "agent",
			status: "done",
			completedEvent: "REVIEW_REQUIRED",
			transitions: [
				{
					event: "REVIEW_REQUIRED",
					target: "review-follow-up",
					input: { draft: "event:draft", score: "event:score" },
				},
			],
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
