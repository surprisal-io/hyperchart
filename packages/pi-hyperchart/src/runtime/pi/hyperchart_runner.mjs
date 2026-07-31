#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createJiti } from "jiti";

const configPath = process.argv[2];
if (configPath === undefined) throw new Error("hyperchart runner requires a config path");

const rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
const piModules = rawConfig?.piModules;
const codingAgent = requiredModulePath(piModules?.codingAgent, "piModules.codingAgent");
const typebox = requiredModulePath(piModules?.typebox, "piModules.typebox");

const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": codingAgent,
		typebox,
	},
});
const mod = await jiti.import("./hyperchart_runner.ts");
await mod.main(process.argv.slice(2));

function requiredModulePath(value, field) {
	if (typeof value !== "string" || !isAbsolute(value) || !existsSync(value)) {
		throw new Error(`Invalid hyperchart runner config: ${field} must be an existing absolute path`);
	}
	return value;
}
