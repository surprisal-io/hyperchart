import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Resolve relative chart-owned modules exactly once; bare package specifiers pass to import(). */
export function importedModuleSpecifier(module: string, chartDir: string): string {
	return module.startsWith("./") || module.startsWith("../")
		? pathToFileURL(resolve(chartDir, module)).href
		: module;
}
