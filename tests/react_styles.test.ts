import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("React stylesheet", () => {
	it("omits Tailwind Preflight so embedding does not reset host styles", () => {
		const css = readFileSync(fileURLToPath(new URL("../src/react/styles.css", import.meta.url)), "utf8");

		expect(css).not.toContain('@import "tailwindcss";');
		expect(css).toContain("tailwindcss/theme.css");
		expect(css).toContain("tailwindcss/utilities.css");
	});
});
