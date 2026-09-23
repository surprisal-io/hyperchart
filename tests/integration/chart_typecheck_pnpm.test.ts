import { execFile } from "node:child_process";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import ts from "typescript";

const require = createRequire(import.meta.url);
const run = promisify(execFile);

it("chart_typecheck resolves its own package when TypeScript occupies a separate pnpm virtual-store entry", async () => {
	const root = mkdtempSync(join(tmpdir(), "hyperchart-pnpm-typecheck-"));
	try {
		const modules = join(root, "node_modules");
		const pkg = join(modules, ".pnpm/hyperchart/node_modules/@surprisal/hyperchart");
		const compiler = join(modules, ".pnpm/typescript/node_modules/typescript");
		mkdirSync(join(pkg, "src/runtime/generic"), { recursive: true });
		mkdirSync(join(pkg, "dist"), { recursive: true });
		mkdirSync(join(pkg, "node_modules/@types"), { recursive: true });
		mkdirSync(join(compiler, "bin"), { recursive: true });
		writeFileSync(
			join(pkg, "package.json"),
			JSON.stringify({
				name: "@surprisal/hyperchart",
				type: "module",
				exports: { ".": { types: "./dist/index.d.ts" }, "./package.json": "./package.json" },
			}),
		);
		writeFileSync(join(pkg, "dist/index.d.ts"), 'export declare const marker: "self-package";\n');
		const source = readFileSync(resolve("packages/hyperchart/src/runtime/generic/chart_typecheck.ts"), "utf8");
		writeFileSync(
			join(pkg, "src/runtime/generic/chart_typecheck.js"),
			ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
				.outputText,
		);
		writeFileSync(join(compiler, "package.json"), JSON.stringify({ name: "typescript", version: "5.9.3" }));
		// Invoke the real compiler while preserving a distinct physical package root.
		writeFileSync(join(compiler, "bin/tsc"), `require(${JSON.stringify(require.resolve("typescript/bin/tsc"))});\n`);
		symlinkSync(compiler, join(pkg, "node_modules/typescript"), "dir");
		symlinkSync(dirname(require.resolve("@types/node/package.json")), join(pkg, "node_modules/@types/node"), "dir");
		const chart = join(root, "example.chart.ts");
		writeFileSync(join(root, "package.json"), '{"type":"module"}');
		writeFileSync(
			chart,
			'import { marker } from "@surprisal/hyperchart";\nconst checked: "self-package" = marker;\nexport default checked;\n',
		);
		const moduleUrl = pathToFileURL(join(pkg, "src/runtime/generic/chart_typecheck.js")).href;
		const { stdout } = await run(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`
			import { typecheckChartModule } from ${JSON.stringify(moduleUrl)};
			console.log(JSON.stringify(await typecheckChartModule(${JSON.stringify(chart)})));
		`,
			],
			{ cwd: root },
		);
		expect(JSON.parse(stdout)).toMatchObject({ ok: true, skipped: false });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 15_000);
