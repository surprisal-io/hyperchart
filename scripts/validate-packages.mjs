import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "hyperchart-pack-"));

try {
	const packageSpecs = [
		{
			dir: "packages/hyperchart",
			expected: ["dist/index.js", "dist/index.d.ts", "dist/runtime/index.js", "LICENSE", "README.md"],
		},
		{
			dir: "packages/pi-hyperchart",
			expected: [
				"dist/command.js",
				"dist/runtime/pi/host_adapter.js",
				"dist/react/index.js",
				"dist/react/styles.css",
				"extensions/hyperchart.ts",
				"skills/hyperchart/SKILL.md",
				"skills/hyperchart/references/authoring.md",
				"LICENSE",
				"README.md",
			],
		},
	];

	const tarballs = [];
	for (const item of packageSpecs) {
		const output = execFileSync(
			"npm",
			["pack", "--json", "--pack-destination", temp, `./${item.dir}`],
			{ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
		);
		const report = JSON.parse(output)[0];
		const names = new Set(report.files.map((file) => file.path));
		for (const expected of item.expected) {
			if (!names.has(expected)) throw new Error(`${item.dir} tarball missing ${expected}`);
		}
		for (const forbidden of ["tests/", "node_modules/", "storybook-static/", ".pi/", "tla/"]) {
			if ([...names].some((name) => name.startsWith(forbidden))) {
				throw new Error(`${item.dir} tarball unexpectedly contains ${forbidden}`);
			}
		}
		tarballs.push(resolve(temp, report.filename));
		console.log(`${report.name}@${report.version}: ${report.entryCount} files, ${report.size} packed bytes`);
	}

	validateManifests();
	validateCrossPackageImports();
	validateMarkdownLinks();
	validateCleanConsumer(tarballs);
} finally {
	rmSync(temp, { recursive: true, force: true });
}

function validateManifests() {
	const core = JSON.parse(readFileSync(resolve(root, "packages/hyperchart/package.json"), "utf8"));
	const pi = JSON.parse(readFileSync(resolve(root, "packages/pi-hyperchart/package.json"), "utf8"));
	if (core.private === true || pi.private === true) throw new Error("publishable packages must not be private");
	if (core.version !== pi.version) throw new Error("core and Pi package versions must match");
	if (pi.dependencies?.[core.name] !== core.version) throw new Error("Pi package must pin the matching core version");
	if (!pi.keywords?.includes("pi-package")) throw new Error("Pi package must include the pi-package keyword");
	if (!Array.isArray(pi.pi?.extensions) || !Array.isArray(pi.pi?.skills)) {
		throw new Error("Pi package must declare pi.extensions and pi.skills");
	}
	if (pi["pi-package"] !== undefined) throw new Error("pi-package is a keyword, not a manifest object");
}

function validateCrossPackageImports() {
	const sourceFiles = [];
	walk(resolve(root, "packages/pi-hyperchart"), sourceFiles);
	for (const file of sourceFiles.filter((file) => /\.(?:ts|tsx|mjs)$/.test(file))) {
		const text = readFileSync(file, "utf8");
		if (/from\s+["'][.]{1,2}\/.*packages\/hyperchart/.test(text)) {
			throw new Error(`private cross-package relative import: ${file}`);
		}
	}
}

function validateMarkdownLinks() {
	const markdown = [];
	for (const base of [
		"README.md",
		"docs",
		"packages/hyperchart/README.md",
		"packages/pi-hyperchart/README.md",
		"packages/pi-hyperchart/skills",
	]) {
		const path = resolve(root, base);
		if (statSync(path).isDirectory()) walkMarkdown(path, markdown);
		else markdown.push(path);
	}
	for (const file of markdown) {
		const text = readFileSync(file, "utf8");
		for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
			const target = match[1].split("#")[0];
			if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
			if (!existsSync(resolve(dirname(file), decodeURIComponent(target)))) {
				throw new Error(`broken link in ${file}: ${match[1]}`);
			}
		}
	}
	console.log(`Validated ${markdown.length} Markdown files and package boundaries.`);
}

function validateCleanConsumer(tarballs) {
	const consumer = resolve(temp, "consumer");
	writeFileSync(
		resolve(temp, "consumer-package.json"),
		JSON.stringify({ name: "hyperchart-pack-smoke", private: true, type: "module" }),
	);
	execFileSync("mkdir", ["-p", consumer]);
	writeFileSync(resolve(consumer, "package.json"), readFileSync(resolve(temp, "consumer-package.json")));
	execFileSync(
		"npm",
		[
			"install",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			...tarballs,
			"@earendil-works/pi-coding-agent@^0.80.3",
			"@earendil-works/pi-tui@^0.80.3",
			"typebox@^1.3.3",
			"react@^19.0.0",
			"react-dom@^19.0.0",
			"@xyflow/react@^12.11.1",
			"elkjs@^0.11.1",
			"react-syntax-highlighter@^16.1.1",
		],
		{ cwd: consumer, stdio: "ignore" },
	);

	writeFileSync(
		resolve(consumer, "smoke.mjs"),
		`import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createJiti } from "jiti";
import * as core from "@surprisal-io/hyperchart";
import * as host from "@surprisal-io/hyperchart/host";
import * as runtime from "@surprisal-io/hyperchart/runtime";
import * as command from "@surprisal-io/pi-hyperchart/command";
import * as piHost from "@surprisal-io/pi-hyperchart/pi-host";
import * as react from "@surprisal-io/pi-hyperchart/react";
if (typeof core.refs !== "function" || typeof core.start !== "function") throw new Error("core exports missing");
if (typeof host.hyperchartRunFromRuntime !== "function") throw new Error("host exports missing");
if (typeof runtime.ChartRuntime !== "function" || typeof runtime.JsonlLogStore !== "function") throw new Error("runtime exports missing");
if (typeof command.requestHyperchartCommand !== "function") throw new Error("command exports missing");
if (typeof piHost.createPiHyperchartHost !== "function") throw new Error("Pi host exports missing");
if (typeof react.HyperchartInspectorDialog !== "function") throw new Error("React exports missing");
writeFileSync("external.chart.ts", \`import { chart, final } from "@surprisal-io/hyperchart";\nexport default chart({ kind: "chart", id: "external-smoke", initial: "done", states: { done: final() } });\n\`);
const inspected = core.inspectChartModuleSync(resolve("external.chart.ts"));
if (inspected.chartId !== "external-smoke") throw new Error("packed sync chart inspection failed");
const require = createRequire(import.meta.url);
const piRoot = dirname(require.resolve("@surprisal-io/pi-hyperchart/package.json"));
const extension = await createJiti(import.meta.url, { interopDefault: true }).import(join(piRoot, "extensions/hyperchart.ts"));
if (typeof extension !== "function" && typeof extension.default !== "function") throw new Error("packed Pi extension failed to load");
`,
	);
	execFileSync(process.execPath, ["smoke.mjs"], { cwd: consumer, stdio: "inherit" });

	writeFileSync(
		resolve(consumer, "smoke.ts"),
		`import { final, refs } from "@surprisal-io/hyperchart";
import type { Runtime } from "@surprisal-io/hyperchart/runtime";
import type { HyperchartHostAdapter } from "@surprisal-io/hyperchart/host";
import type { HyperchartInspectorDialogProps } from "@surprisal-io/pi-hyperchart/react";
const { chart } = refs<Record<string, never>, Record<never, never>>();
export const definition = chart({ kind: "chart", id: "smoke", initial: "done", states: { done: final() } });
export type SmokeTypes = Runtime | HyperchartHostAdapter | HyperchartInspectorDialogProps;
`,
	);
	writeFileSync(
		resolve(consumer, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				target: "ES2022",
				module: "NodeNext",
				moduleResolution: "NodeNext",
				strict: true,
				noEmit: true,
				skipLibCheck: true,
			},
			include: ["smoke.ts"],
		}),
	);
	execFileSync(resolve(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], {
		cwd: consumer,
		stdio: "inherit",
	});

	const consumerRequire = createRequire(resolve(consumer, "package.json"));
	const piRoot = dirname(consumerRequire.resolve("@surprisal-io/pi-hyperchart/package.json"));
	for (const resource of ["extensions/hyperchart.ts", "skills/hyperchart/SKILL.md"]) {
		if (!existsSync(resolve(piRoot, resource))) throw new Error(`clean Pi install missing ${resource}`);
	}
	console.log("Clean tarball runtime and type imports passed.");
}

function walk(path, output) {
	for (const name of readdirSync(path)) {
		const child = resolve(path, name);
		statSync(child).isDirectory() ? walk(child, output) : output.push(child);
	}
}

function walkMarkdown(path, output) {
	for (const name of readdirSync(path)) {
		const child = resolve(path, name);
		statSync(child).isDirectory() ? walkMarkdown(child, output) : child.endsWith(".md") && output.push(child);
	}
}
