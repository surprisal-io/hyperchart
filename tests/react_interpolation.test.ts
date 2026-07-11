import { describe, expect, it } from "vitest";
import type { HyperchartStateInfo } from "../src/host/models.js";
import {
	hasInterpolation,
	interpolationAction,
	isPromptInterpolationToken,
} from "../src/react/components/inspector/helpers/interpolation.js";

const sourceState: HyperchartStateInfo = {
	id: "work",
	type: "agent",
	status: "running",
};

describe("Inspector prompt interpolation", () => {
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
