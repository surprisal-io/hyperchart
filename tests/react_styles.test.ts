import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("React stylesheet", () => {
	it("scopes the required Preflight reset without resetting the host", () => {
		const css = readFileSync(fileURLToPath(new URL("../src/react/styles.css", import.meta.url)), "utf8");

		expect(css).not.toContain('@import "tailwindcss";');
		expect(css).not.toContain("tailwindcss/preflight.css");
		expect(css).toContain("tailwindcss/theme.css");
		expect(css).toContain("tailwindcss/utilities.css");
		expect(css).toContain("[data-hyperchart-root] button");
		expect(css).toContain("background-color: transparent");
		expect(css).toContain("box-sizing: border-box");
		expect(css).toContain("text-size-adjust: 100%");
	});
});
