import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname } from "node:path";
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
	const args = [
		"--noEmit",
		"--pretty",
		"false",
		"--skipLibCheck",
		"--strict",
		"--noUncheckedIndexedAccess",
		"--exactOptionalPropertyTypes",
		"--target",
		"ES2022",
		"--module",
		"NodeNext",
		"--moduleResolution",
		"NodeNext",
		"--types",
		"node",
		chartPath,
	];
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
		sections.push(`TypeScript typecheck failed:\n${typecheck.diagnostics}\n\nCommand:\n${typecheck.command}`);
	}
	return sections.join("\n\n");
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
