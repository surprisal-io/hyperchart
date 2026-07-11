import { describe, expect, it } from "vitest";
import { validateLaunchArgsText } from "../packages/pi-hyperchart/src/react/components/launch/HyperchartLaunchDialogInner.js";

describe("validateLaunchArgsText", () => {
	it("accepts empty arguments and JSON objects", () => {
		expect(validateLaunchArgsText("")).toBeUndefined();
		expect(validateLaunchArgsText("  {\"goal\":\"ship\"}  ")).toBeUndefined();
	});

	it("rejects free-form text, arrays, and scalar JSON", () => {
		expect(validateLaunchArgsText("ship it")).toMatch(/JSON object/);
		expect(validateLaunchArgsText("[]")).toMatch(/JSON object/);
		expect(validateLaunchArgsText("42")).toMatch(/JSON object/);
	});
});
