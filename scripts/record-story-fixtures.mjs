// Offline-only recapture. Browser modules remain synchronous and import JSON only.
// The transform changes fixture declarations into awaitable capture requests; it
// never edits source files, durable records, provenance, or projected UI models.
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
// Isolated generator process only: seed nondurable runtime identity and time BEFORE
// execution. No emitted record is rewritten, including sessionId or coordinates.
const captureContext = {
	clock: Date.UTC(2026, 6, 14, 12),
	uuidSeed: "hyperchart-story-capture-v1",
	pipeline: "execution_loop -> explainReplay -> host adapter",
};
Date.now = () => captureContext.clock;
let uuidCounter = 0;
crypto.randomUUID = () => {
	const hex = crypto.createHash("sha256").update(`${captureContext.uuidSeed}:${++uuidCounter}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
globalThis.crypto.randomUUID = crypto.randomUUID;
syncBuiltinESMExports();
const root = fileURLToPath(new URL("../", import.meta.url));
const captureModule = `${root}scripts/story-fixtures/capture-story-schedule.ts`;
const families = [
	"packages/hyperchart/src/react/fixtures/hyperchart-fixtures.ts",
	"packages/hyperchart/src/react/fixtures/runtime-section-fixture.ts",
	"packages/hyperchart/src/react/fixtures/no-input-records-fixture.ts",
	"packages/hyperchart/src/react/fixtures/actor-runtime-fixtures.ts",
	"packages/hyperchart/src/react/fixtures/actor-fixtures.ts",
	"packages/hyperchart/src/react/stories/inspector-panel/specs.ts",
	".storybook/tui-production-fixture.ts",
];
function replaceRequired(source, before, after, filename) {
	if (source.split(before).length !== 2) {
		throw new Error(`Capture transform expected exactly one ${JSON.stringify(before)} in ${filename}`);
	}
	return source.replace(before, after);
}
const transformed = new Set();
const compiler = createJiti(import.meta.url, { fsCache: false });
const jiti = createJiti(import.meta.url, {
	fsCache: false,
	moduleCache: true,
	transform(options) {
		let source = options.source;
		if (families.some((family) => options.filename === `${root}${family}`)) {
			const imports = source.match(/import \{ capturedStorySchedule \} from "[^"]+";/g);
			if (imports?.length !== 1) {
				throw new Error(`Missing/ambiguous capture import in ${options.filename}`);
			}
			source = source
				.replace(imports[0], `import { captureStorySchedule } from ${JSON.stringify(captureModule)};`)
				.replaceAll("capturedStorySchedule(", "await captureStorySchedule(");
			transformed.add(options.filename);
			if (options.filename.endsWith("/actor-fixtures.ts")) {
				source = replaceRequired(source, "function buildRun(", "async function buildRun(", options.filename);
				source = replaceRequired(
					source,
					"): HyperchartRunInfo {",
					"): Promise<HyperchartRunInfo> {",
					options.filename,
				).replaceAll("= buildRun(", "= await buildRun(");
			}
			if (options.filename.endsWith("/specs.ts")) {
				source = replaceRequired(
					source,
					"inspectorPanelSpecInputs.map((spec) => {",
					"await Promise.all(inspectorPanelSpecInputs.map(async (spec) => {",
					options.filename,
				);
				source = replaceRequired(
					source,
					"records: () => captured } };\n});",
					"records: () => captured } };\n}));",
					options.filename,
				);
			}
		}
		return { code: compiler.transform({ ...options, source }) };
	},
});
for (const family of families) {
	await jiti.import(`${root}${family}`);
}
if (transformed.size !== families.length) {
	throw new Error("Not every named fixture family was transformed for real capture");
}
const { captures } = await jiti.import(captureModule);
const { captureRemovedValidatorHistory, captureReplayIncompatibleHistory } = await jiti.import(
	`${root}scripts/story-fixtures/validation-histories.ts`,
);
for (const [name, capture] of [
	["removed-validator-history", captureRemovedValidatorHistory],
	["replay-incompatible-history", captureReplayIncompatibleHistory],
]) {
	let seqId = 0;
	const { records } = await capture(async (drafts) =>
		drafts.map((draft) => ({
			...draft,
			parentId: seqId || null,
			seqId: ++seqId,
			branchId: "main",
			timestamp: captureContext.clock + seqId * 1_000,
		})),
	);
	captures.set(name, records);
}
if (captures.size === 0) {
	throw new Error("No story records captured; refusing to write an empty registry");
}
const output =
	JSON.stringify(
		{ captureContext, snapshots: Object.fromEntries([...captures].sort(([a], [b]) => a.localeCompare(b))) },
		null,
		"\t",
	) + "\n";
console.log(
	`${captures.size} captured snapshots, ${[...captures.values()].reduce((sum, records) => sum + records.length, 0)} records, ${Buffer.byteLength(output)} bytes`,
);
if (process.argv.includes("--write")) {
	writeFileSync(`${root}packages/hyperchart/src/react/fixtures/captured-story-records.json`, output);
	console.log("Wrote captured-story-records.json from execution-loop output.");
}
