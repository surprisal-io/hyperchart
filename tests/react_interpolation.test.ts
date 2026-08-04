import { describe, expect, it } from "vitest";
import type { HyperchartStateInfo } from "../packages/hyperchart/src/host/models.js";
import {
	hasInterpolation,
	interpolationAction,
	interpolationTokenClass,
	isPromptInterpolationToken,
} from "../packages/hyperchart/src/react/components/inspector/helpers/interpolation.js";

const sourceState: HyperchartStateInfo = {
	id: "work",
	type: "agent",
	status: "running",
};

describe("Inspector prompt interpolation", () => {
	it("uses the same explicit inline geometry for clickable and informational tokens", () => {
		const clickable = interpolationTokenClass("input", true);
		const informational = interpolationTokenClass("visit", false);
		for (const className of [clickable, informational]) {
			expect(className).toContain("inline-flex");
			expect(className).toContain("py-0.5");
			expect(className).toContain("leading-[1.35]");
		}
	});

	it("renders json-wrapped result references as source types instead of raw DSL", () => {
		const screenshotState: HyperchartStateInfo = {
			id: "screenshot-report",
			type: "script",
			status: "done",
			replySchema: {
				schema: {
					type: "object",
					properties: { screenshots: { type: "array", items: { type: "string" } }, html_path: { type: "string" } },
					required: ["screenshots", "html_path"],
				},
			},
		};
		const prepareState: HyperchartStateInfo = {
			id: "prepare-chapter-work",
			type: "script",
			status: "done",
			replySchema: {
				schema: {
					type: "object",
					properties: { items: { type: "object", additionalProperties: { type: "string" } } },
					required: ["items"],
				},
			},
		};
		const allStates = [sourceState, screenshotState, prepareState];
		const whole = interpolationAction('json(result("screenshot-report"))', sourceState, allStates, {});
		const field = interpolationAction(
			'json(result("prepare-chapter-work", "items"))',
			sourceState,
			allStates,
			{},
		);

		expect(whole.tone).toBe("result");
		expect(whole.title).toContain("screenshots: Array<string>");
		expect(whole.title).toContain("html_path: string");
		expect(whole.title).not.toContain("result(");
		expect(field).toMatchObject({ title: "Record<string, string>", tone: "result" });
		expect(isPromptInterpolationToken("reason,instructions,redo_items")).toBe(false);
		expect(hasInterpolation("output {reason,instructions,redo_items}")).toBe(false);
	});
});
