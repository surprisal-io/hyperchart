import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	agent,
	artifact,
	artifactVersion,
	ArtifactVersionSchema,
	chart,
	currentVersion,
	final,
	explainReplay,
	hyperchartSource,
	inspectChartAst,
	json,
	normalizeChartConfig,
	result,
	script,
	tsAction,
	z,
	type ChartCst,
	type StateActionCst,
} from "../packages/hyperchart/src/index.js";
import { renderPendingActionInvocation, renderRead } from "../packages/hyperchart/src/core/machine.js";
import { createBranchProjection, projectBranch, resolveRef } from "../packages/hyperchart/src/core/projection.js";
import { ArtifactStore } from "../packages/hyperchart/src/runtime/generic/artifact_store.js";
import { ChartRuntime } from "../packages/hyperchart/src/runtime/generic/chart_runtime.js";
import { JsonlLogStore } from "../packages/hyperchart/src/runtime/generic/log_store.js";
import { withRunStorage, resolveRunPaths } from "../packages/hyperchart/src/runtime/generic/run_paths.js";
import { FakeAgentExecutor } from "./fake_agent_executor.js";
import { start } from "./helpers/execution.js";
import { collectHistoryRecords } from "./helpers/history.js";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
function readerExecutor(workDir: string): FakeAgentExecutor {
	const executor = new FakeAgentExecutor();
	executor.start = (effect, emit) => {
		const path = effect.reads?.[0]?.path;
		if (path === undefined) {
			throw new Error("missing historical agent read");
		}
		void Promise.all([readFile(resolve(workDir, path), "utf8"), readFile(join(workDir, "notes.md"), "utf8")]).then(
			([old, live]) => {
				emit({ kind: "completed", event: { type: "DONE", output: { old, live, path: resolve(workDir, path) } } });
			},
		);
	};
	return executor;
}

const node = process.execPath;
const pin = (text: string) => ({
	hash: createHash("sha256").update(text).digest("hex"),
	size: Buffer.byteLength(text),
});
const parse = (definition: ChartCst) => {
	const parsed = normalizeChartConfig(definition);
	if (!parsed.ok) {
		throw new Error(JSON.stringify(parsed.diagnostics));
	}
	return parsed.ast;
};
const single = (action: ReturnType<typeof agent>) =>
	chart({
		kind: "chart",
		id: "versions",
		initial: "read",
		states: {
			read: { kind: "state", action, transitions: { DONE: "done" } },
			done: final(),
		},
	});

describe("artifact revision refs", () => {
	it("resolves accepted branch pins and rejects untracked/missing artifacts", () => {
		const ast = parse(single(agent("reader")));
		const projection = createBranchProjection(ast);
		const state = { ast, projection };
		expect(() => resolveRef(state, currentVersion("notes.md"), "read")).toThrow("no accepted revision");
		projection.artifactPins["notes.md"] = pin("old");
		expect(resolveRef(state, currentVersion("notes.md"), "read")).toEqual({ path: "notes.md", ...pin("old") });
		const version = resolveRef(state, currentVersion("notes.md"), "read");
		projection.artifactPins["notes.md"] = pin("new");
		expect(version).toEqual({ path: "notes.md", ...pin("old") });
	});

	it.each([
		"/absolute",
		"../escape",
		"x/../escape",
		"x/./alias",
		"C:\\escape",
		"https://host/a",
		"",
	])("rejects unsafe paths: %s", (path) => {
		const parsed = normalizeChartConfig(
			single(agent("reader", { task: { kind: "template", strings: ["", ""], refs: [json(currentVersion(path))] } })),
		);
		expect(parsed.ok).toBe(false);
		expect(ArtifactVersionSchema.safeParse({ path, ...pin("old") }).success).toBe(false);
	});

	it("validates result dependencies inside artifactVersion", () => {
		const parsed = normalizeChartConfig(single(agent("reader", { reads: [artifactVersion(result("absent"))] })));
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) {
			expect(parsed.diagnostics.some((entry) => entry.code === "UNKNOWN_INPUT_RESULT")).toBe(true);
		}
	});

	it("renders source and inspector metadata without losing revision identity", () => {
		const ast = parse(
			single(
				agent("reader", {
					task: { kind: "template", strings: ["", ""], refs: [json(currentVersion("notes.md"))] },
					reads: [artifactVersion(currentVersion("notes.md"))],
				}),
			),
		);
		const source = hyperchartSource(ast);
		expect(source).toContain('currentVersion("notes.md")');
		expect(source).toContain('artifactVersion(currentVersion("notes.md"))');
		const inspected = inspectChartAst(ast).states.find((state) => state.id === "read");
		expect(inspected?.refs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "currentVersion", path: "notes.md" }),
				expect.objectContaining({ kind: "artifactVersion" }),
			]),
		);
	});

	it("resolves currentVersion from current pins when a pending action is rendered again", () => {
		const ast = parse(
			single(
				agent("reader", {
					task: { kind: "template", strings: ["", ""], refs: [json(currentVersion("notes.md"))] },
				}),
			),
		);
		const projection = createBranchProjection(ast);
		projection.artifactPins["notes.md"] = pin("old");
		const action = ast.states.read;
		if (action?.kind !== "state") {
			throw new Error("missing action");
		}
		const next = projectBranch(projection, ast, [
			{
				type: "state_action",
				kind: "invoke",
				actionUid: action.action.uid,
				definition: action.action,
				sessionId: "session",
				seqId: 1,
				parentId: null,
				branchId: "main",
				timestamp: 1,
			},
		]);
		next.artifactPins["notes.md"] = pin("new");
		const pending = next.pendingActions[0];
		if (pending?.phase !== "running") {
			throw new Error("no pending action");
		}
		const restored = renderPendingActionInvocation(ast, structuredClone(next), pending);
		if (restored.kind !== "agent") {
			throw new Error("not agent");
		}
		expect(JSON.parse(restored.task ?? "")).toEqual({ path: "notes.md", ...pin("new") });
	});
});

it.each([
	"script",
	"function",
	"agent",
] as const)("reads a saved revision after live mutation and replay (%s capture)", async (captureKind) => {
	const directory = await mkdtemp(join(tmpdir(), "hyperchart-version-"));
	directories.push(directory);
	await writeFile(
		join(directory, "capture.mjs"),
		`import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
export function capture(p) { return {type:"DONE",output:{notesVersion:JSON.parse(p.VERSION)}}; }
export function consume(p, ctx) {
  return {type:"DONE", output:{old:readFileSync(p.NOTES,"utf8"),live:readFileSync(join(ctx.workDir,"notes.md"),"utf8"),path:p.NOTES}};
}`,
	);
	const captureOptions = {
		env: { VERSION: { kind: "template" as const, strings: ["", ""], refs: [json(currentVersion("notes.md"))] } },
		reply: z.object({ notesVersion: ArtifactVersionSchema }),
	};
	const captureAction = (): StateActionCst => {
		switch (captureKind) {
			case "script":
				return script(
					node,
					["-e", 'console.log(JSON.stringify({type:"DONE",output:{notesVersion:JSON.parse(process.env.VERSION)}}))'],
					captureOptions,
				);
			case "function":
			case "agent":
				return tsAction("./capture.mjs", "capture", captureOptions);
		}
	};
	const readAction = (): StateActionCst => {
		const revision = artifactVersion(result("capture", "notesVersion"));
		switch (captureKind) {
			case "agent":
				return agent("reader", { reads: [revision] });
			case "function":
				return tsAction("./capture.mjs", "consume", { env: { NOTES: revision } });
			case "script":
				return script(
					node,
					[
						"-e",
						'const fs=require("node:fs"); console.log(JSON.stringify({type:"DONE",output:{old:fs.readFileSync(process.env.NOTES,"utf8"),live:fs.readFileSync("notes.md","utf8"),path:process.env.NOTES}}))',
					],
					{ env: { NOTES: revision } },
				);
		}
	};
	const ast = parse(
		chart({
			kind: "chart",
			id: "version-roundtrip",
			initial: "seed",
			states: {
				seed: {
					kind: "state",
					action: script(node, ["-e", 'require("node:fs").writeFileSync("notes.md","old")'], {
						artifacts: { notes: artifact("notes.md") },
					}),
					transitions: { DONE: "capture" },
				},
				capture: {
					kind: "state",
					action: captureAction(),
					transitions: { DONE: "mutate" },
				},
				mutate: {
					kind: "state",
					action: script(node, ["-e", 'require("node:fs").writeFileSync("notes.md","new")'], {
						artifacts: { notes: artifact("notes.md") },
					}),
					transitions: { DONE: "read" },
				},
				read: {
					kind: "state",
					action: readAction(),
					transitions: { DONE: "observe" },
				},
				observe: {
					kind: "state",
					action: script(node, [
						"-e",
						'console.log(JSON.stringify({type:"DONE",output:{notes:require("node:fs").readFileSync("notes.md","utf8")}}))',
					]),
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		}),
	);
	const storage = { kind: "jsonl" as const, rootDir: directory, layout: "sha256" as const };
	const store = new JsonlLogStore(join(directory, "log.jsonl"));
	await store.initializeRootBranch();
	const runtime = withRunStorage(
		storage,
		() =>
			new ChartRuntime({
				ast,
				branchId: "main",
				logStore: store,
				agentExecutor: readerExecutor(directory),
				workDir: directory,
				chartDir: directory,
				runId: "run",
			}),
	);
	try {
		await start(runtime);
	} finally {
		await runtime.dispose();
	}
	const records = await collectHistoryRecords(store, "main");
	const replay = explainReplay(ast, records);
	expect(replay.broken).toBeUndefined();
	expect(replay.stale).toEqual([]);
	expect(replay.skipped).toEqual([]);
	const changedMode = structuredClone(records);
	for (const record of changedMode) {
		if (record.type !== "state_action" || record.kind !== "invoke" || record.actionUid.state !== "read") {
			continue;
		}
		const action = record.definition;
		const read =
			action.kind === "agent"
				? action.reads?.[0]
				: action.kind === "script" || action.kind === "tsImport"
					? action.env?.NOTES
					: undefined;
		if (typeof read === "object" && read.kind === "artifactVersion") {
			delete (read as { mode?: string }).mode;
		}
	}
	expect(explainReplay(ast, changedMode).stale).toEqual(
		expect.arrayContaining([expect.objectContaining({ state: "read", reason: "action_definition_changed" })]),
	);
	const projection = projectBranch(createBranchProjection(ast), ast, records);
	expect(projection.results.read).toMatchObject({ old: "old", live: "old" });
	expect(await readFile(join(directory, "notes.md"), "utf8")).toBe("new");
	expect(projection.results.observe).toEqual({ notes: "new" });
	const saved = projection.results.capture as { notesVersion: z.infer<typeof ArtifactVersionSchema> };
	expect(saved.notesVersion).toEqual({ path: "notes.md", ...pin("old") });
	// A second workspace/branch may read the saved reference without the live file.
	const other = structuredClone(projection);
	other.results.saved = saved;
	const rendered = renderRead(
		{ ast, projection: other } as Parameters<typeof renderRead>[0],
		artifactVersion(result("saved", "notesVersion")),
		"read",
	);
	expect(rendered).toMatchObject({ path: "notes.md", versioned: true, pin: pin("old") });
	const objects = new ArtifactStore(resolveRunPaths("run", storage).runDir);
	expect(await readFile(await objects.get(saved.notesVersion.hash), "utf8")).toBe("old");
	expect(projection.results.read).toMatchObject({ path: join(directory, "notes.md") });
	await expect(access(join(directory, ".hyperchart", "artifact-versions"))).rejects.toThrow();
	const boundary = records.find(
		(record) => record.type === "state_action" && record.kind === "complete" && record.actionUid.state === "mutate",
	);
	if (boundary === undefined) {
		throw new Error("missing fork boundary");
	}
	// A real fork inherits the captured result, not the current pin for notes.md.
	await store.createBranch("fork", boundary.seqId);
	const forkDir = join(directory, "fork-workspace");
	await mkdir(forkDir);
	await writeFile(join(forkDir, "notes.md"), "fork live");
	const forkStore = store.forBranch("fork");
	const forkRuntime = withRunStorage(
		storage,
		() =>
			new ChartRuntime({
				ast,
				branchId: "fork",
				logStore: forkStore,
				agentExecutor: readerExecutor(forkDir),
				workDir: forkDir,
				chartDir: directory,
				runId: "run",
			}),
	);
	try {
		await start(forkRuntime);
	} finally {
		await forkRuntime.dispose();
	}
	const forkRecords = await collectHistoryRecords(forkStore, "fork");
	const forkProjection = projectBranch(createBranchProjection(ast), ast, forkRecords);
	expect(forkProjection.results.read).toMatchObject({ old: "old", live: "old" });
	expect(explainReplay(ast, forkRecords).broken).toBeUndefined();
	expect(await readFile(join(forkDir, "notes.md"), "utf8")).toBe("new");
	// Rewinding the source branch reuses the same saved result too.
	await store.moveBranch("main", boundary.seqId);
	await writeFile(join(directory, "notes.md"), "rewound live");
	const rewound = withRunStorage(
		storage,
		() =>
			new ChartRuntime({
				ast,
				branchId: "main",
				logStore: store,
				agentExecutor: readerExecutor(directory),
				workDir: directory,
				chartDir: directory,
				runId: "run",
			}),
	);
	try {
		await start(rewound);
	} finally {
		await rewound.dispose();
	}
	const rewindRecords = await collectHistoryRecords(store, "main");
	expect(projectBranch(createBranchProjection(ast), ast, rewindRecords).results.read).toMatchObject({
		old: "old",
		live: "old",
	});
	// A fresh workspace cannot silently fall back to live bytes on store corruption.
	await store.createBranch("corrupt", boundary.seqId);
	await writeFile(await objects.get(saved.notesVersion.hash), "tampered");
	const corruptDir = join(directory, "corrupt-workspace");
	await mkdir(corruptDir);
	await writeFile(join(corruptDir, "notes.md"), "must not read this");
	const corruptStore = store.forBranch("corrupt");
	const corruptRuntime = withRunStorage(
		storage,
		() =>
			new ChartRuntime({
				ast,
				branchId: "corrupt",
				logStore: corruptStore,
				agentExecutor: readerExecutor(corruptDir),
				workDir: corruptDir,
				chartDir: directory,
				runId: "run",
			}),
	);
	try {
		await start(corruptRuntime);
	} finally {
		await corruptRuntime.dispose();
	}
	const corruptProjection = projectBranch(
		createBranchProjection(ast),
		ast,
		await collectHistoryRecords(corruptStore, "corrupt"),
	);
	expect(corruptProjection.failure).toBeDefined();
	expect(corruptProjection.results.read).toBeUndefined();
	await store.close();
});
