import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HyperchartStateInfo } from "../src/host/models.js";
import { MapResolvedInputList } from "../src/react/components/inspector/details/MapResolvedInputList.js";
import { RuntimeSection } from "../src/react/components/inspector/details/RuntimeSection.js";
import { createTextPreview } from "../src/react/components/inspector/helpers/textPreview.js";
import { TemplateTextBlock } from "../src/react/components/inspector/prompt/TemplateTextBlock.js";

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
	it("is collapsed by default and hides verbose visit data", () => {
		const markup = renderToStaticMarkup(createElement(RuntimeSection, { state: runtimeState }));
		expect(markup).toContain("Runtime");
		expect(markup).toContain('aria-expanded="false"');
		expect(markup).not.toContain("Visit history");
		expect(markup).not.toContain("Resolved runtime task");
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
