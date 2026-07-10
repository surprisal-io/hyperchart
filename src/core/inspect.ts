import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { normalizeChartConfig } from "./normalize.js";
import { inspectChartAst, type HyperchartInspectResult, type InspectChartModuleOptions } from "./inspect_ast.js";
import type { ParsedChart } from "./types.js";

export * from "./inspect_ast.js";

export function parseChartModuleSync(filePath: string, options: InspectChartModuleOptions = {}): ParsedChart {
	const absolutePath = resolve(filePath);
	const jiti = createJiti(pathToFileURL(absolutePath).href, {
		interopDefault: true,
		alias: { "pi-hyperchart": selfEntryPath() },
	});
	try {
		const module = jiti(absolutePath) as Record<string, unknown>;
		const exportName = options.exportName ?? "default";
		return normalizeChartConfig(module[exportName], { path: absolutePath, exportName });
	} catch (cause) {
		return {
			ok: false,
			source: { path: absolutePath, exportName: options.exportName ?? "default" },
			diagnostics: [
				{
					code: "TS_MODULE_LOAD_FAILED",
					message: `Unable to load chart module: ${cause instanceof Error ? cause.message : String(cause)}`,
					source: { path: absolutePath, exportName: options.exportName ?? "default" },
				},
			],
		};
	}
}

function selfEntryPath(): string {
	const js = fileURLToPath(new URL("../index.js", import.meta.url));
	if (existsSync(js)) return js;
	return fileURLToPath(new URL("../index.ts", import.meta.url));
}

export function inspectChartModuleSync(filePath: string, options: InspectChartModuleOptions = {}): HyperchartInspectResult {
	const absolutePath = resolve(filePath);
	const parsed = parseChartModuleSync(absolutePath, options);
	if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	return inspectChartAst(parsed.ast, {
		chartPath: absolutePath,
		...(options.exportName === undefined ? {} : { exportName: options.exportName }),
		...(options.agentDefaults === undefined ? {} : { agentDefaults: options.agentDefaults }),
	});
}
