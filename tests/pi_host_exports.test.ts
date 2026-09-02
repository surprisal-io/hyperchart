import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPiHyperchartHost, piHyperchartHost } from "../packages/pi-hyperchart/src/runtime/pi/host_adapter.js";

describe("Pi host public surface", () => {
	it("provides the harness-specific implementation separately", () => {
		expect(typeof createPiHyperchartHost).toBe("function");
		expect(typeof piHyperchartHost.readSessionSnapshot).toBe("function");
		expect(typeof piHyperchartHost.readChartSnapshot).toBe("function");
		expect(typeof piHyperchartHost.readRunOverview).toBe("function");
		expect(piHyperchartHost).not.toHaveProperty("readRunSnapshot");
	});

	it("exports the implementation through pi-hyperchart/pi-host", () => {
		const packageJson = JSON.parse(
			readFileSync(fileURLToPath(new URL("../packages/pi-hyperchart/package.json", import.meta.url)), "utf8"),
		) as { exports?: Record<string, unknown> };

		expect(packageJson.exports).toHaveProperty("./pi-host");
	});
});
