import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HyperchartStateInfo } from "../packages/hyperchart/src/host/models.js";
import { AgentInfoCard } from "../packages/hyperchart/src/react/components/inspector/details/AgentInfoCard.js";
import { MapResolvedInputList } from "../packages/hyperchart/src/react/components/inspector/details/MapResolvedInputList.js";
import { MapVisitHistory } from "../packages/hyperchart/src/react/components/inspector/details/MapVisitHistory.js";
import { VisitHistory } from "../packages/hyperchart/src/react/components/inspector/details/VisitHistory.js";
import { RuntimeSection } from "../packages/hyperchart/src/react/components/inspector/details/RuntimeSection.js";
import { agentStatesForSelection } from "../packages/hyperchart/src/react/components/inspector/helpers/state.js";
import { createTextPreview } from "../packages/hyperchart/src/react/components/inspector/helpers/textPreview.js";
import { TemplateTextBlock } from "../packages/hyperchart/src/react/components/inspector/prompt/TemplateTextBlock.js";

const runtimeState: HyperchartStateInfo = {
	id: "work",
	type: "agent",
	status: "running",
	startedAt: 1000,
	visits: 1,
	visitHistory: [
		{
			visit: 1,
			invokeSeqId: 2,
			startedAt: 1000,
			status: "running",
			inputs: { feedback: "retry" },
			invocation: { kind: "agent", task: "Resolved runtime task" },
		},
	],
};

describe("Runtime inspector section", () => {
	it("renders pinned deliverables with path, hash, and size", () => {
		const state: HyperchartStateInfo = {
			...runtimeState,
			artifacts: [{
				name: "report",
				path: "artifacts/report.md",
				schema: { schema: { type: "object", properties: { title: { type: "string" } } } },
			}],
		};
		const markup = renderToStaticMarkup(
			createElement(VisitHistory, {
				state,
				allStates: [state],
				visits: [
					{
						visit: 1,
						invokeSeqId: 2,
						startedAt: 1000,
						endedAt: 2000,
						status: "done",
						completedEvent: "DONE",
						artifactPins: [{ path: "artifacts/report.md", hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", size: 18324 }],
						invocation: { kind: "agent", task: "Write the report" },
					},
				],
			}),
		);
		expect(markup).toContain("pinned deliverables");
		expect(markup).toContain("artifacts/report.md");
		expect(markup).toContain("sha256:9f86d081884c");
		expect(markup).toContain("17.9 KB");
		// TypeTooltip content is portal-rendered on hover and intentionally absent from SSR.
	});

	it("is collapsed by default and hides verbose visit data", () => {
		const markup = renderToStaticMarkup(createElement(RuntimeSection, { state: runtimeState }));
		expect(markup).toContain("Runtime");
		expect(markup).toContain('aria-expanded="false"');
		expect(markup).not.toContain("Visit history");
		expect(markup).not.toContain("Resolved runtime task");
	});

	it("owns the run-specific live session instead of the static agent card", () => {
		const state: HyperchartStateInfo = {
			...runtimeState,
			agent: "worker",
			session: {
				actionKey: "chart:work:agent",
				status: "running",
				role: "worker",
				model: "provider/model",
				thinking: "xhigh",
				toolset: "researching",
				tools: ["read", "browser", "finish"],
				turnCount: 3,
				toolCount: 5,
			},
		};
		const runtimeMarkup = renderToStaticMarkup(createElement(RuntimeSection, { state }));
		expect(runtimeMarkup).toContain('aria-expanded="true"');
		expect(runtimeMarkup).toContain("Agent session");
		expect(runtimeMarkup).toContain("View session");
		expect(runtimeMarkup).toContain("role worker");
		expect(runtimeMarkup).toContain("provider/model");
		expect(runtimeMarkup).toContain("think xhigh");
		expect(runtimeMarkup).toContain("toolset researching");
		expect(runtimeMarkup).toContain("3 enabled tools");
		expect(runtimeMarkup).toContain("3 turns");
		expect(runtimeMarkup).toContain("5 tools");

		const agentMarkup = renderToStaticMarkup(
			createElement(AgentInfoCard, { state, allStates: [state] }),
		);
		expect(agentMarkup).toContain("@worker");
		expect(agentMarkup).not.toContain("View session");
	});

	it("renders a session control for every durable visit while keeping the latest-session card", () => {
		const firstSession = {
			actionKey: "chart:work:agent",
			status: "completed",
			startedAt: 1000,
			model: "provider/first-model",
		};
		const secondSession = {
			actionKey: "chart:work:agent",
			status: "running",
			startedAt: 2000,
			model: "provider/second-model",
		};
		const state: HyperchartStateInfo = {
			...runtimeState,
			agent: "worker",
			visits: 2,
			session: secondSession,
			visitHistory: [
				{
					visit: 1,
					invokeSeqId: 2,
					startedAt: 1000,
					endedAt: 1500,
					status: "done",
					invocation: { kind: "agent", task: "First task" },
					session: firstSession,
				},
				{
					visit: 2,
					invokeSeqId: 5,
					startedAt: 2000,
					status: "running",
					invocation: { kind: "agent", task: "Second task" },
					session: secondSession,
				},
			],
		};

		const markup = renderToStaticMarkup(createElement(RuntimeSection, { state }));
		expect(markup).toContain("Agent session");
		expect(markup).toContain('aria-label="View session for visit 1"');
		expect(markup).toContain('aria-label="View session for visit 2"');
	});

	it("includes materialized map agents in the selected map scope", () => {
		const map: HyperchartStateInfo = { id: "workers", type: "map", status: "done" };
		const worker: HyperchartStateInfo = {
			id: "workers#alpha.work",
			type: "agent",
			status: "done",
			agent: "writer",
			model: "provider/model",
		};
		expect(agentStatesForSelection(map, [map, worker])).toEqual([worker]);
	});

	it("keeps one in-scope state per agent name in source order", () => {
		const map: HyperchartStateInfo = { id: "workers", type: "map", status: "running" };
		const firstWriter: HyperchartStateInfo = {
			id: "workers#alpha.work",
			type: "agent",
			status: "running",
			agent: "writer",
		};
		const reviewer: HyperchartStateInfo = {
			id: "workers#alpha.review",
			type: "agent",
			status: "running",
			agent: "reviewer",
		};
		const secondWriter: HyperchartStateInfo = {
			id: "workers#beta.work",
			type: "agent",
			status: "running",
			agent: "writer",
		};

		expect(agentStatesForSelection(map, [map, firstWriter, reviewer, secondWriter])).toEqual([
			firstWriter,
			reviewer,
		]);
	});

	it("renders fitting map values without a full-content control", () => {
		const state: HyperchartStateInfo = {
			id: "items",
			type: "map",
			status: "running",
			mapConfig: {
				items: [
					{
						key: "short",
						label: "A short map item",
						value: { body: "wall of text" },
					},
				],
			},
		};
		const markup = renderToStaticMarkup(createElement(MapResolvedInputList, { state }));
		expect(markup).not.toContain("Open full");
		expect(markup).toContain("wall of text");
	});

	it("renders map visit generations and item membership", () => {
		const historyMarkup = renderToStaticMarkup(
			createElement(MapVisitHistory, {
				onReenter: { mode: "resume", messagePreview: "Continue map work with updated feedback." },
				visits: [
					{ visit: 1, spawnSeqId: 2, startedAt: 1000, instances: { a: { title: "Alpha" } } },
					{ visit: 2, spawnSeqId: 9, startedAt: 2000, instances: { a: { title: "Alpha v2" } } },
				],
			}),
		);
		expect(historyMarkup).toContain("Map visit history");
		expect(historyMarkup).toContain("Visit 1");
		expect(historyMarkup).toContain("Visit 2");
		expect(historyMarkup).toContain("on re-enter: resume");
		expect(historyMarkup).toContain("resume re-entry");
		expect(historyMarkup).toContain("Continue map work with updated feedback.");
		expect(historyMarkup).toContain("spawn seq 9");
		const itemMarkup = renderToStaticMarkup(
			createElement(MapResolvedInputList, {
				state: {
					id: "items",
					type: "map",
					status: "done",
					mapConfig: { items: [{ key: "a", label: "Alpha", visits: [1, 2] }] },
				},
			}),
		);
		expect(itemMarkup).toContain("map visits: 1, 2");
	});

	it("does not put clipped map content in the initial DOM", () => {
		const state: HyperchartStateInfo = {
			id: "items",
			type: "map",
			status: "running",
			mapConfig: {
				items: [
					{
						key: "long",
						label: "A long map item",
						value: {
							entries: Array.from({ length: 20 }, (_, index) => ({
								id: `entry-${index + 1}`,
								note: index === 19 ? "MUST_NOT_RENDER_IN_PREVIEW" : `note-${index + 1}`,
							})),
						},
					},
				],
			},
		};
		const markup = renderToStaticMarkup(createElement(MapResolvedInputList, { state }));
		expect(markup).toContain("Open full");
		expect(markup).not.toContain(">More<");
		expect(markup).toContain("entry-1");
		expect(markup).not.toContain("MUST_NOT_RENDER_IN_PREVIEW");
	});

	it("does not put clipped interpolated prompts in the initial DOM", () => {
		const text = [
			'Use {input("topic")} for the report.',
			"Keep the verified facts.",
			"MUST_NOT_RENDER_IN_PREVIEW",
		].join("\n");
		const markup = renderToStaticMarkup(
			createElement(TemplateTextBlock, {
				text,
				state: runtimeState,
				allStates: [runtimeState],
				collapsedLines: 2,
			}),
		);
		expect(markup).toContain("Open full");
		expect(markup).toContain("topic");
		expect(markup).not.toContain("MUST_NOT_RENDER_IN_PREVIEW");
	});

	it("bounds previews by both lines and characters", () => {
		expect(createTextPreview("one\ntwo\nthree", 2)).toEqual({ text: "one\ntwo\n…", truncated: true });
		expect(createTextPreview("123456789", 10, 5)).toEqual({ text: "12345\n…", truncated: true });
		expect(createTextPreview("one\ntwo", 2)).toEqual({ text: "one\ntwo", truncated: false });
	});
});
