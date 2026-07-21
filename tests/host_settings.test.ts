import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadModelRoles } from "../packages/hyperchart/src/runtime/generic/host_settings.js";

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

describe("hypercharts settings model roles", () => {
	it("merges scopes with later directories winning per role key", async () => {
		const user = await makeChartsDir({ roles: { reviewer: "user/model", scout: "user/scout" } });
		const project = await makeChartsDir({ roles: { reviewer: "project/model" } });

		expect(loadModelRoles([user, project])).toEqual({ reviewer: "project/model", scout: "user/scout" });
	});

	it("treats missing files and settings without roles as empty", async () => {
		const empty = await makeChartsDir();
		const noRoles = await makeChartsDir({ other: true });
		const missing = join(empty, "does-not-exist");
		await mkdir(missing);

		expect(loadModelRoles([empty, noRoles, missing])).toEqual({});
	});

	it("fails loudly on malformed settings instead of dropping the mapping", async () => {
		const invalidJson = await makeChartsDir("{not json");
		const invalidRoles = await makeChartsDir({ roles: "reviewer" });
		const invalidModel = await makeChartsDir({ roles: { reviewer: 42 } });

		expect(() => loadModelRoles([invalidJson])).toThrow("Invalid hypercharts settings");
		expect(() => loadModelRoles([invalidRoles])).toThrow("'roles' must be an object");
		expect(() => loadModelRoles([invalidModel])).toThrow("role 'reviewer' must map to a model string");
	});
});
