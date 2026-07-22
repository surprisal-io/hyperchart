import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadHostSettings } from "../packages/hyperchart/src/runtime/generic/host_settings.js";

const tempDirs: string[] = [];

async function makeChartsDir(settings?: unknown): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hyperchart-settings-"));
	tempDirs.push(dir);
	if (settings !== undefined) {
		await writeFile(
			join(dir, "settings.json"),
			typeof settings === "string" ? settings : JSON.stringify(settings),
			"utf8",
		);
	}
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("hypercharts host settings", () => {
	it("merges scopes with later directories winning per key", async () => {
		const user = await makeChartsDir({
			roles: { reviewer: "user/model", scout: "user/scout" },
			toolsets: { coding: ["read", "bash"], research: ["fetch"] },
		});
		const project = await makeChartsDir({
			roles: { reviewer: "project/model" },
			toolsets: { coding: ["read", "grep"] },
		});

		expect(loadHostSettings([user, project])).toEqual({
			modelRoles: { reviewer: "project/model", scout: "user/scout" },
			toolsets: { coding: ["read", "grep"], research: ["fetch"] },
		});
	});

	it("prefers the requested host section over flat keys within one file", async () => {
		const shared = await makeChartsDir({
			roles: { reviewer: "flat/model" },
			toolsets: { reading: ["flat"] },
			pi: { roles: { reviewer: "pi/model" }, toolsets: { reading: ["read"] } },
			claude: { roles: { reviewer: "claude/model", extra: "claude/extra" } },
		});

		expect(loadHostSettings([shared], "pi")).toEqual({
			modelRoles: { reviewer: "pi/model" },
			toolsets: { reading: ["read"] },
		});
		expect(loadHostSettings([shared], "claude")).toEqual({
			modelRoles: { reviewer: "claude/model", extra: "claude/extra" },
			toolsets: { reading: ["flat"] },
		});
		expect(loadHostSettings([shared])).toEqual({
			modelRoles: { reviewer: "flat/model" },
			toolsets: { reading: ["flat"] },
		});
		expect(() => loadHostSettings([shared], "other")).not.toThrow();
	});

	it("treats missing files and settings without sections as empty", async () => {
		const empty = await makeChartsDir();
		const noSections = await makeChartsDir({ other: true });
		const missing = join(empty, "does-not-exist");
		await mkdir(missing);

		expect(loadHostSettings([empty, noSections, missing])).toEqual({ modelRoles: {}, toolsets: {} });
	});

	it("fails loudly on malformed settings instead of dropping a mapping", async () => {
		const invalidJson = await makeChartsDir("{not json");
		const invalidRoles = await makeChartsDir({ roles: "reviewer" });
		const invalidModel = await makeChartsDir({ roles: { reviewer: 42 } });
		const invalidToolsets = await makeChartsDir({ toolsets: ["read"] });
		const invalidTools = await makeChartsDir({ toolsets: { coding: "read" } });

		expect(() => loadHostSettings([invalidJson])).toThrow("Invalid hypercharts settings");
		expect(() => loadHostSettings([invalidRoles])).toThrow("'roles' must be an object");
		expect(() => loadHostSettings([invalidModel])).toThrow("role 'reviewer' must map to a model string");
		expect(() => loadHostSettings([invalidToolsets])).toThrow("'toolsets' must be an object");
		expect(() => loadHostSettings([invalidTools])).toThrow("toolset 'coding' must map to an array of tool names");
	});
});
