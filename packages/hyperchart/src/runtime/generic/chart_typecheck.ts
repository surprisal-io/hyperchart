import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export type ChartTypecheckResult =
	| { ok: true; skipped: boolean; command?: string }
	| { ok: false; command: string; diagnostics: string };

export type ChartSourceLintDiagnostic = Readonly<{
	code: "DEPRECATED_ZOD_PASSTHROUGH" | "EXPLICIT_ANY" | "TS_SUPPRESSION";
	message: string;
	line: number;
	column: number;
	text: string;
}>;

export type ChartPreflightResult =
	| { ok: true; typecheck: ChartTypecheckResult; lint: readonly ChartSourceLintDiagnostic[] }
	| { ok: false; typecheck: ChartTypecheckResult; lint: readonly ChartSourceLintDiagnostic[]; diagnostics: string };

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

export async function preflightChartModule(chartPath: string): Promise<ChartPreflightResult> {
	const lint = lintChartModuleSource(chartPath);
	const typecheck = await typecheckChartModule(chartPath);
	if (lint.length === 0 && typecheck.ok) return { ok: true, lint, typecheck };
	return { ok: false, lint, typecheck, diagnostics: formatPreflightDiagnostics(chartPath, lint, typecheck) };
}

export async function assertChartPreflight(chartPath: string): Promise<void> {
	const result = await preflightChartModule(chartPath);
	if (!result.ok) {
		throw new Error(`Hyperchart preflight failed for ${chartPath}\n\n${result.diagnostics}`);
	}
}

export function lintChartModuleSource(chartPath: string): ChartSourceLintDiagnostic[] {
	if (!TYPESCRIPT_EXTENSIONS.has(extname(chartPath))) return [];
	const source = readFileSync(chartPath, "utf8");
	const diagnostics: ChartSourceLintDiagnostic[] = [];
	const lines = source.split(/\r?\n/);
	for (const [index, line] of lines.entries()) {
		addMatches(diagnostics, line, index + 1, /\.passthrough\s*\(/g, "DEPRECATED_ZOD_PASSTHROUGH", "Zod .passthrough() is deprecated; use z.looseObject(...) or .loose() instead.");
		addMatches(diagnostics, line, index + 1, /\b(?:as\s+any|:\s*any\b|<any>|Record\s*<[^\n>]*,\s*any\b|Array\s*<\s*any\s*>)/g, "EXPLICIT_ANY", "Explicit any in chart modules hides schema/registry drift; use exported CST types, unknown, or a concrete z.infer type.");
		addMatches(diagnostics, line, index + 1, /@ts-(?:ignore|expect-error|nocheck)/g, "TS_SUPPRESSION", "TypeScript suppression comments are not allowed in hyperchart modules.");
	}
	return diagnostics;
}

export async function typecheckChartModule(chartPath: string): Promise<ChartTypecheckResult> {
	if (!TYPESCRIPT_EXTENSIONS.has(extname(chartPath))) return { ok: true, skipped: true };
	const tscPath = resolveTypeScriptCompiler();
	const nodeTypeRoot = resolveNodeTypeRoot();
	const tempDir = mkdtempSync(join(tmpdir(), "hyperchart-typecheck-"));
	const configPath = join(tempDir, "tsconfig.json");
	const hyperchartEntry = resolveHyperchartTypeEntry();
	writeFileSync(configPath, JSON.stringify({
		compilerOptions: {
			noEmit: true,
			pretty: false,
			skipLibCheck: true,
			strict: true,
			noUncheckedIndexedAccess: true,
			exactOptionalPropertyTypes: true,
			target: "ES2022",
			module: "NodeNext",
			moduleResolution: "NodeNext",
			baseUrl: dirname(chartPath),
			paths: { "@surprisal/hyperchart": [hyperchartEntry] },
			typeRoots: [nodeTypeRoot],
			types: ["node"],
		},
		files: [resolve(chartPath)],
	}, null, 2));
	const args = ["--project", configPath];
	const command = `${process.execPath} ${tscPath} ${args.map(shellQuote).join(" ")}`;
	try {
		await execFileAsync(process.execPath, [tscPath, ...args], { maxBuffer: 4 * 1024 * 1024 });
		return { ok: true, skipped: false, command };
	} catch (error) {
		const output = compilerOutput(error);
		return {
			ok: false,
			command,
			diagnostics: output.length === 0 ? "TypeScript exited with a non-zero status and no diagnostics." : output,
		};
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

export async function assertChartTypechecks(chartPath: string): Promise<void> {
	const result = await typecheckChartModule(chartPath);
	if (!result.ok) {
		throw new Error(`Hyperchart TypeScript typecheck failed for ${chartPath}\n\n${result.diagnostics}\n\nCommand:\n${result.command}`);
	}
}

function addMatches(
	diagnostics: ChartSourceLintDiagnostic[],
	line: string,
	lineNumber: number,
	pattern: RegExp,
	code: ChartSourceLintDiagnostic["code"],
	message: string,
): void {
	for (const match of line.matchAll(pattern)) {
		diagnostics.push({
			code,
			message,
			line: lineNumber,
			column: (match.index ?? 0) + 1,
			text: line.trim(),
		});
	}
}

function formatPreflightDiagnostics(
	chartPath: string,
	lint: readonly ChartSourceLintDiagnostic[],
	typecheck: ChartTypecheckResult,
): string {
	const sections: string[] = [];
	if (lint.length > 0) {
		sections.push([
			"Chart source lint failed:",
			...lint.map((diagnostic) =>
				`${chartPath}:${diagnostic.line}:${diagnostic.column} ${diagnostic.code}: ${diagnostic.message}\n  ${diagnostic.text}`,
			),
		].join("\n"));
	}
	if (!typecheck.ok) {
		const registryHints = registryMismatchHints(typecheck.diagnostics);
		sections.push([
			...(registryHints.length === 0 ? [] : [`Hyperchart registry guidance:\n${registryHints.join("\n")}`]),
			`TypeScript typecheck failed:\n${typecheck.diagnostics}`,
			`Command:\n${typecheck.command}`,
		].join("\n\n"));
	}
	return sections.join("\n\n");
}

function registryMismatchHints(diagnostics: string): string[] {
	const hints: string[] = [];
	if (diagnostics.includes("files registry is out of sync with the chart")) {
		hints.push("- Artifact output types come from the schema declared on the chart action or validator. An omitted schema is inferred as unknown, so a concrete files-registry type (for example string) is incompatible. Declare the artifact schema on the chart action, or make the registry entry unknown if the output is intentionally untyped.");
	}
	if (diagnostics.includes("results registry is out of sync with the chart")) {
		hints.push("- Results-registry entries come only from actions that declare a reply schema. Declare the action reply schema with the intended output type, or remove the state from the results registry if it produces no structured result.");
	}
	if (diagnostics.includes("maps registry is out of sync with the chart")) {
		hints.push("- Map item types come from the mapped source schema. An untyped source is inferred as unknown; declare its schema or use unknown in the maps registry.");
	}
	return hints;
}

function resolveTypeScriptCompiler(): string {
	try {
		return require.resolve("typescript/bin/tsc");
	} catch (error) {
		throw new Error(
			`Hyperchart TypeScript typecheck requires the 'typescript' package, but it could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function resolveHyperchartTypeEntry(): string {
	try {
		const nodeModules = resolve(dirname(require.resolve("typescript/package.json")), "..");
		const entry = join(nodeModules, "@surprisal", "hyperchart", "dist", "index.d.ts");
		if (existsSync(entry)) return entry;
		throw new Error(`missing ${entry}`);
	} catch (error) {
		throw new Error(
			`Hyperchart TypeScript typecheck could not resolve its core package: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function resolveNodeTypeRoot(): string {
	try {
		return dirname(dirname(require.resolve("@types/node/package.json")));
	} catch (error) {
		throw new Error(
			`Hyperchart TypeScript typecheck requires the '@types/node' package, but it could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function compilerOutput(error: unknown): string {
	if (isExecError(error)) return [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
	return error instanceof Error ? error.message : String(error);
}

function isExecError(error: unknown): error is { stdout?: string; stderr?: string } {
	return typeof error === "object" && error !== null && ("stdout" in error || "stderr" in error);
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, "'\\''")}'`;
}
