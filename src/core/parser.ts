import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { normalizeChartConfig } from "./normalize.js";
import type { ChartSource, ParsedChart } from "./types.js";

export type ParseChartModuleOptions = {
	exportName?: string;
	cacheBust?: boolean;
};

export class ChartParseError extends Error {
	readonly result: ParsedChart;

	constructor(result: ParsedChart) {
		super(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
		this.name = "ChartParseError";
		this.result = result;
	}
}

export async function parseChartModule(
	filePath: string,
	options: ParseChartModuleOptions = {},
): Promise<ParsedChart> {
	const absolutePath = resolve(filePath);
	const source: ChartSource = { path: absolutePath, exportName: options.exportName ?? "default" };
	try {
		const url = pathToFileURL(absolutePath);
		if (options.cacheBust ?? true) {
			url.searchParams.set("t", Date.now().toString(36));
		}
		const module = (await import(url.href)) as Record<string, unknown>;
		const exportName = options.exportName ?? "default";
		return parseChartExport(module[exportName], source);
	} catch (cause) {
		return {
			ok: false,
			source,
			diagnostics: [
				{
					code: "TS_MODULE_LOAD_FAILED",
					message: `Unable to load chart module: ${cause instanceof Error ? cause.message : String(cause)}`,
					source,
				},
			],
		};
	}
}

export function parseChartExport(value: unknown, source: ChartSource = {}): ParsedChart {
	return normalizeChartConfig(value, source);
}

export async function parseChartModuleAst(
	filePath: string,
	options: ParseChartModuleOptions = {},
): Promise<Extract<ParsedChart, { ok: true }>> {
	const result = await parseChartModule(filePath, options);
	if (result.ok) return result;
	throw new ChartParseError(result);
}
