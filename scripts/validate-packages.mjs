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
	execFileSync(process.execPath, ["scripts/sync-pi-docs.mjs", "--check"], {
		cwd: root,
		stdio: "inherit",
	});

	const packageSpecs = [
		{
			dir: "packages/hyperchart",
			expected: [
				"dist/index.js",
				"dist/index.d.ts",
				"dist/runtime/index.js",
				"dist/inspect/index.js",
				"dist/sessions/index.js",
				"dist/react/index.js",
				"dist/react/styles.css",
				"dist/inspector-web/client.js",
				"dist/inspector-web/styles.css",
				"LICENSE",
				"README.md",
			],
		},
		{
			dir: "packages/claude-hyperchart",
			expected: [
				"dist/index.js",
				"dist/index.d.ts",
				"dist/mcp/server.js",
				"dist/claude/hyperchart_runner.js",
				"src/claude/hyperchart_runner.mjs",
				"bin/hyperchart-mcp.mjs",
				".claude-plugin/plugin.json",
				"hooks/hooks.json",
				"hooks/session_start.mjs",
				"skills/hyperchart/SKILL.md",
				"LICENSE",
				"README.md",
			],
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
				"docs/api/dsl.md",
				"docs/api/pi.md",
				"docs/safety.md",
				"examples/quickstart.chart.ts",
				"assets/readme/architecture.svg",
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
	const claude = JSON.parse(readFileSync(resolve(root, "packages/claude-hyperchart/package.json"), "utf8"));
	for (const pkg of [core, pi, claude]) {
		if (pkg.private === true) throw new Error("publishable packages must not be private");
		if (pkg.version !== core.version) throw new Error("package versions must stay in lockstep");
	}
	for (const pkg of [pi, claude]) {
		if (pkg.dependencies?.[core.name] !== core.version) {
			throw new Error(`${pkg.name} must pin the matching core version`);
		}
	}
	const plugin = JSON.parse(
		readFileSync(resolve(root, "packages/claude-hyperchart/.claude-plugin/plugin.json"), "utf8"),
	);
	if (plugin.version !== claude.version) throw new Error("Claude plugin manifest version must match the package version");
	if (!pi.keywords?.includes("pi-package")) throw new Error("Pi package must include the pi-package keyword");
	if (!Array.isArray(pi.pi?.extensions) || !Array.isArray(pi.pi?.skills)) {
		throw new Error("Pi package must declare pi.extensions and pi.skills");
	}
	if (pi["pi-package"] !== undefined) throw new Error("pi-package is a keyword, not a manifest object");
}

function validateCrossPackageImports() {
	for (const dir of ["packages/pi-hyperchart", "packages/claude-hyperchart"]) {
		const sourceFiles = [];
		walk(resolve(root, dir), sourceFiles);
		for (const file of sourceFiles.filter((file) => /\.(?:ts|tsx|mjs)$/.test(file))) {
			const text = readFileSync(file, "utf8");
			if (/from\s+["'][.]{1,2}\/.*packages\/(?:hyperchart|pi-hyperchart|claude-hyperchart)/.test(text)) {
				throw new Error(`private cross-package relative import: ${file}`);
			}
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
		"packages/pi-hyperchart/docs",
		"packages/claude-hyperchart/README.md",
		"packages/claude-hyperchart/skills",
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
			"@earendil-works/pi-coding-agent@^0.81.1",
			"@earendil-works/pi-tui@^0.81.1",
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
import * as core from "@surprisal/hyperchart";
import * as host from "@surprisal/hyperchart/host";
import * as runtime from "@surprisal/hyperchart/runtime";
import * as inspect from "@surprisal/hyperchart/inspect";
import * as sessions from "@surprisal/hyperchart/sessions";
import * as coreReact from "@surprisal/hyperchart/react";
import * as claudeHost from "@surprisal/claude-hyperchart";
import * as command from "@surprisal/pi-hyperchart/command";
import * as piHost from "@surprisal/pi-hyperchart/pi-host";
import * as react from "@surprisal/pi-hyperchart/react";
if (typeof core.refs !== "function" || typeof core.start !== "function") throw new Error("core exports missing");
if (typeof host.hyperchartRunFromRuntime !== "function") throw new Error("host exports missing");
if (typeof runtime.ChartRuntime !== "function" || typeof runtime.JsonlLogStore !== "function") throw new Error("runtime exports missing");
if (typeof inspect.hyperchartRunFromRunDir !== "function" || typeof inspect.openRunInspector !== "function") throw new Error("inspect exports missing");
if (typeof sessions.updateSessionProgress !== "function" || typeof sessions.queueSessionSteering !== "function") throw new Error("sessions exports missing");
if (typeof command.requestHyperchartCommand !== "function") throw new Error("command exports missing");
if (typeof piHost.createPiHyperchartHost !== "function" || typeof piHost.piHyperchartHost?.readChartSnapshot !== "function" || typeof piHost.piHyperchartHost?.readRunSnapshot !== "function") throw new Error("Pi host exports missing");
if (typeof coreReact.HyperchartInspectorDialog !== "function") throw new Error("core React exports missing");
if (typeof claudeHost.resolveClaudeSubagentDefinitionDirs !== "function") throw new Error("Claude host exports missing");
if (typeof react.HyperchartInspectorDialog !== "function") throw new Error("React exports missing");
writeFileSync("external.chart.ts", \`import { chart, final } from "@surprisal/hyperchart";\nexport default chart({ kind: "chart", id: "external-smoke", args: { topic: { description: "Subject", default: "Hyperchart" } }, initial: "done", states: { done: final() } });\n\`);
const inspected = core.inspectChartModuleSync(resolve("external.chart.ts"));
if (inspected.chartId !== "external-smoke" || inspected.args?.topic?.default !== "Hyperchart") throw new Error("packed sync chart inspection failed");
const require = createRequire(import.meta.url);
const piRoot = dirname(require.resolve("@surprisal/pi-hyperchart/package.json"));
const extension = await createJiti(import.meta.url, { interopDefault: true }).import(join(piRoot, "extensions/hyperchart.ts"));
if (typeof extension !== "function" && typeof extension.default !== "function") throw new Error("packed Pi extension failed to load");
`,
	);
	execFileSync(process.execPath, ["smoke.mjs"], { cwd: consumer, stdio: "inherit" });

	writeFileSync(
		resolve(consumer, "smoke.ts"),
		`import { final, refs } from "@surprisal/hyperchart";
import type {
  ArtifactCst,
  ArtifactOfCst,
  ChartArgumentAst,
  ChartArgumentCst,
  JoinArtifactOfCst,
  MachineOutputError,
  MachineStartEvent,
  MapStateAst,
  MapStateCst,
  ParseChartModuleOptions,
  RenderedArtifact,
} from "@surprisal/hyperchart";
import type { GuardContext, Runtime, SchemaCheck } from "@surprisal/hyperchart/runtime";
import type {
  HyperchartHostAdapter,
  HyperchartLaunchArgumentInfo,
  HyperchartRunSummaryInfo,
  HyperchartSummaryInfo,
} from "@surprisal/hyperchart/host";
import type { HyperchartInspectorDialogProps, HyperchartRunStripProps } from "@surprisal/pi-hyperchart/react";
const { chart } = refs<{ topic: string }, Record<never, never>>();
export const definition = chart({ kind: "chart", id: "smoke", args: { topic: { description: "Subject", default: "Hyperchart" } }, initial: "done", states: { done: final() } });
declare const chartSummaries: HyperchartSummaryInfo[];
export const runStripProps: HyperchartRunStripProps = {
  hypercharts: chartSummaries,
  runs: [],
  onOpenDefinition(summary) {
    const optionalStateCount: number | undefined = summary.stateCount;
    void optionalStateCount;
  },
};
export type SmokeTypes =
  | Runtime
  | HyperchartHostAdapter
  | HyperchartLaunchArgumentInfo
  | HyperchartSummaryInfo
  | HyperchartRunSummaryInfo
  | HyperchartInspectorDialogProps
  | HyperchartRunStripProps
  | ArtifactCst
  | ArtifactOfCst
  | ChartArgumentAst
  | ChartArgumentCst
  | JoinArtifactOfCst
  | MachineOutputError
  | MachineStartEvent
  | MapStateAst
  | MapStateCst
  | ParseChartModuleOptions
  | RenderedArtifact
  | GuardContext
  | SchemaCheck;
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
	const piRoot = dirname(consumerRequire.resolve("@surprisal/pi-hyperchart/package.json"));
	for (const resource of [
		"extensions/hyperchart.ts",
		"skills/hyperchart/SKILL.md",
		"docs/api/dsl.md",
		"docs/api/pi.md",
		"docs/safety.md",
		"examples/quickstart.chart.ts",
	]) {
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
