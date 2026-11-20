import { hyperchartRunFromInspectResult } from "../packages/hyperchart/src/host/adapters.js";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	agent,
	artifact,
	artifactOf,
	chart,
	compound,
	explainReplay,
	final,
	hyperchartSource,
	inspectChartAst,
	joinArtifactOf,
	map,
	normalizeChartConfig,
	parallel,
	script,
	t,
	tsAction,
	tsImport,
	z,
	type ChartCst,
} from "../packages/hyperchart/src/index.js";
import { actionUidKey } from "../packages/hyperchart/src/core/action_uid.js";
import { renderRead, type RenderedArtifact } from "../packages/hyperchart/src/core/machine.js";
import { arg, key, visit } from "../packages/hyperchart/src/core/dsl.js";
import { createBranchProjection, projectBranch } from "../packages/hyperchart/src/core/projection.js";
import {
	decodeCheckpoint,
	prepareProjectionCheckpoint,
	projectionContractForAst,
} from "../packages/hyperchart/src/execution/projection_restore.js";
import { ChartRuntime } from "../packages/hyperchart/src/runtime/generic/chart_runtime.js";
import { ArtifactStore } from "../packages/hyperchart/src/runtime/generic/artifact_store.js";
import { JsonlLogStore } from "../packages/hyperchart/src/runtime/generic/log_store.js";
import { resolveRunPaths, withRunStorage } from "../packages/hyperchart/src/runtime/generic/run_paths.js";
import { FakeAgentExecutor } from "./fake_agent_executor.js";
import { start } from "./helpers/execution.js";
import { collectHistoryRecords } from "./helpers/history.js";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const pin = (text: string) => ({
	hash: createHash("sha256").update(text).digest("hex"),
	size: Buffer.byteLength(text),
});
async function stored(store: ArtifactStore, root: string, text: string) {
	const source = join(root, `source-${pin(text).hash}`);
	await writeFile(source, text);
	return store.put(source);
}
async function directory() {
	const path = await mkdtemp(join(tmpdir(), "borrowed-artifacts-"));
	directories.push(path);
	return path;
}
function produce(text: string) {
	return script(process.execPath, ["-e", `require('node:fs').writeFileSync('notes.md',${JSON.stringify(text)})`], {
		artifacts: { notes: artifact("notes.md") },
	});
}
function parse(definition: ChartCst) {
	const parsed = normalizeChartConfig(definition);
	if (!parsed.ok) {
		throw new Error(JSON.stringify(parsed.diagnostics));
	}
	return parsed.ast;
}
async function runtimeAt(root: string, definition: ChartCst, executor = new FakeAgentExecutor()) {
	const ast = parse(definition);
	const storage = { kind: "jsonl" as const, rootDir: root, layout: "sha256" as const };
	const store = new JsonlLogStore(join(root, "log.jsonl"));
	await store.initializeRootBranch();
	const paths = withRunStorage(storage, () => resolveRunPaths("run"));
	const runtime = withRunStorage(
		storage,
		() =>
			new ChartRuntime({
				ast,
				branchId: "main",
				logStore: store,
				agentExecutor: executor,
				workDir: root,
				chartDir: root,
				runId: "run",
			}),
	);
	return { ast, store, runtime, paths };
}
async function run(
	root: string,
	definition: ChartCst,
	executor = new FakeAgentExecutor(),
	args?: Record<string, unknown>,
) {
	const f = await runtimeAt(root, definition, executor);
	try {
		const state = await start(f.runtime, args);
		const records = await collectHistoryRecords(f.store, "main");
		expect(explainReplay(f.ast, records)).toMatchObject({ stale: [], skipped: [] });
		expect(explainReplay(f.ast, records).broken).toBeUndefined();
		const restored = projectBranch(createBranchProjection(f.ast), f.ast, records);
		expect(restored.artifactVersions).toEqual(state.projection.artifactVersions);
		// Every intermediate projection, including pending borrowed/empty bindings, survives a checkpoint.
		for (let end = 1; end <= records.length; end++) {
			const projection = projectBranch(createBranchProjection(f.ast), f.ast, records.slice(0, end));
			const envelope = prepareProjectionCheckpoint(projection, projectionContractForAst(f.ast));
			expect(decodeCheckpoint(envelope, f.ast)?.projection).toEqual(projection);
		}
		return { ...f, state, records };
	} finally {
		await f.runtime.dispose();
	}
}
const uid = (action: string) => ({ chart: "effects", state: action, action });
const borrow = (action: string, artifacts: RenderedArtifact[]) => ({
	kind: "borrow" as const,
	id: `borrow:${action}`,
	actionUid: uid(action),
	artifacts,
});
const restore = (action: string, artifacts: RenderedArtifact[]) => ({
	kind: "restore" as const,
	id: `restore:${action}`,
	actionUid: uid(action),
	artifacts,
});
/** A runtime driven directly with borrow/restore/cancel effects, as the machine emits them. */
async function effectRuntime() {
	const root = await directory();
	const f = await runtimeAt(root, chart({ kind: "chart", id: "effects", initial: "done", states: { done: final() } }));
	return { ...f, root, store: new ArtifactStore(f.paths.runDir) };
}
async function writeReader(root: string) {
	await writeFile(
		join(root, "reader.mjs"),
		`import {readFileSync} from 'node:fs'; import {join} from 'node:path';
export function read(p,c) { return {type:'DONE',output:{snapshot:readFileSync(p.NOTES,'utf8'),live:readFileSync(join(c.workDir,'notes.md'),'utf8'),path:p.NOTES}}; }
export function select(p) { return {type:'DONE',output:{selected:p.VALUE}}; }
export function joinFiles(p) { return {type:'DONE',output:JSON.parse(p.PARTS).map(path=>readFileSync(path,'utf8'))}; }
export function guard(event,c,invocation) { if(readFileSync(invocation.env.OWN,'utf8')!=='edited') throw Error('guard did not see working bytes'); return event.output.approved || {ok:false,reason:'Try again'}; }
`,
	);
}

describe("accepted producer snapshots", () => {
	it("artifactOf reads the producer's saved bytes after another action rewrites the same path", async () => {
		const root = await directory();
		await writeReader(root);
		const { state, paths } = await run(
			root,
			chart({
				kind: "chart",
				id: "snapshot-read",
				initial: "score",
				states: {
					score: { kind: "state", action: produce("old experiment"), transitions: { DONE: "generate" } },
					generate: { kind: "state", action: produce("new generator observation"), transitions: { DONE: "context" } },
					context: {
						kind: "state",
						action: tsAction("./reader.mjs", "read", { env: { NOTES: artifactOf("score", { artifact: "notes" }) } }),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
		);
		const output = state.projection.results.context as { snapshot: string; live: string; path: string };
		expect(output).toMatchObject({ snapshot: "old experiment", live: "new generator observation" });
		expect(output.path).toContain(join(paths.runDir, "artifact_store", "objects"));

		// The path remains valid after screening_context exits (including the oversized-notebook fallback).
		expect(await readFile(output.path, "utf8")).toBe("old experiment");
		expect(state.projection.artifactVersions.score?.notes).toEqual({ path: "notes.md", snapshot: pin("old experiment") });
	});

	it("select reads and validates JSON from the saved snapshot, not the working file", async () => {
		const root = await directory();
		await writeReader(root);
		const shape = z.object({ value: z.number() });
		const { state } = await run(
			root,
			chart({
				kind: "chart",
				id: "snapshot-select",
				initial: "source",
				states: {
					source: {
						kind: "state",
						action: script(process.execPath, ["-e", `require('node:fs').writeFileSync('notes.md','{"value":1}')`], {
							artifacts: { notes: artifact("notes.md", shape) },
						}),
						transitions: { DONE: "rewrite" },
					},
					rewrite: { kind: "state", action: produce('{"value":2}'), transitions: { DONE: "read" } },
					read: {
						kind: "state",
						action: tsAction("./reader.mjs", "select", {
							env: { VALUE: artifactOf("source", { artifact: "notes", select: "value" }) },
						}),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
		);
		expect(state.projection.results.read).toEqual({ selected: 1 });
	});

	it("joins each accepted map instance even after another state overwrites their paths", async () => {
		const root = await directory();
		await writeReader(root);
		const f = await runtimeAt(
			root,
			chart({
				kind: "chart",
				id: "snapshot-join",
				initial: "parts",
				states: {
					parts: map({
						over: arg("items"),
						concurrency: 2,
						initial: "write",
						onDone: "rewrite",
						states: {
							write: {
								kind: "state",
								action: script(
									process.execPath,
									[
										"-e",
										`const fs=require('node:fs');fs.mkdirSync('parts',{recursive:true});fs.writeFileSync('parts/'+process.env.KEY+'.txt',process.env.KEY)`,
									],
									{ env: { KEY: t`${key()}` }, artifacts: { part: artifact(t`parts/${key()}.txt`) } },
								),
								transitions: { DONE: "done" },
							},
							done: final(),
						},
					}),
					rewrite: {
						kind: "state",
						action: script(
							process.execPath,
							[
								"-e",
								`const fs=require('node:fs');fs.writeFileSync('parts/0.txt','NEW');fs.writeFileSync('parts/1.txt','NEW')`,
							],
							{ artifacts: { a: artifact("parts/0.txt"), b: artifact("parts/1.txt") } },
						),
						transitions: { DONE: "gather" },
					},
					gather: {
						kind: "state",
						action: tsAction("./reader.mjs", "joinFiles", {
							env: { PARTS: joinArtifactOf("parts.write", { artifact: "part" }) },
						}),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
		);
		const dispatch = f.runtime.runEffects.bind(f.runtime);
		let joinedPaths: string[] | undefined;
		f.runtime.runEffects = async (effects) => {
			for (const effect of effects) {
				if (effect.kind === "tsImport" && effect.actionUid.state === "gather") {
					const value = effect.env?.PARTS;
					if (!Array.isArray(value)) {
						throw new Error("Expected joined artifacts");
					}
					joinedPaths = value.map((artifact: RenderedArtifact) => artifact.path);
					expect(joinedPaths).toEqual(["parts/0.txt", "parts/1.txt"]);
				}
			}
			await dispatch(effects);
		};
		try {
			const state = await start(f.runtime, { items: [0, 1] });
			expect(state.projection.results.gather).toEqual(["0", "1"]);
			expect(joinedPaths).toHaveLength(2);
		} finally {
			await f.runtime.dispose();
		}
	});
});

describe("temporary borrowed artifacts", () => {
	it("restores the previous working file and never publishes temporary edits", async () => {
		const root = await directory();
		const executor = new FakeAgentExecutor();
		executor.start = (effect, emit) => {
			void (async () => {
				// Source snapshot and rollback target are distinct pins fixed at invoke.
				expect(effect.artifacts?.find((artifact) => artifact.name === "notes")).toMatchObject({
					snapshot: pin("old experiment"),
					rollback: { to: pin("current notes") },
				});
				expect(await readFile(join(root, "notes.md"), "utf8")).toBe("old experiment");
				await writeFile(join(root, "notes.md"), "discard this edit");
				await writeFile(join(root, "answer.txt"), "keep this output");
				emit({ kind: "completed", event: { type: "DONE" } });
			})();
		};
		const { state, paths } = await run(
			root,
			chart({
				kind: "chart",
				id: "rollback",
				initial: "score",
				states: {
					score: { kind: "state", action: produce("old experiment"), transitions: { DONE: "generate" } },
					generate: { kind: "state", action: produce("current notes"), transitions: { DONE: "prior" } },
					prior: {
						kind: "state",
						action: agent("reader", {
							artifacts: {
								notes: artifact({ from: "score", artifact: "notes", rollback: true }),
								answer: artifact("answer.txt"),
							},
						}),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
			executor,
		);
		expect(await readFile(join(root, "notes.md"), "utf8")).toBe("current notes");
		expect(state.projection.artifactPins["notes.md"]).toEqual(pin("current notes"));
		expect(state.projection.artifactPins["answer.txt"]).toEqual(pin("keep this output"));
		expect(state.projection.artifactVersions.prior).toEqual({
			answer: { path: "answer.txt", snapshot: pin("keep this output") },
		});
		expect(() =>
			renderRead(state, { kind: "artifactOf", state: "prior", artifact: "notes", ifMissing: "empty" }, "done"),
		).toThrow("no accepted artifact");
		const dirty = pin("discard this edit").hash;
		await expect(
			access(join(paths.runDir, "artifact_store", "objects", dirty.slice(0, 2), dirty.slice(2))),
		).rejects.toThrow();
	});

	it("provides empty initial memory without exposing the current generator's notes", async () => {
		const root = await directory();
		await writeReader(root);
		const executor = new FakeAgentExecutor();
		executor.start = (effect, emit) => {
			expect(effect.reads?.map((read) => read.path)).toEqual([join(root, "notes.md")]);
			void readFile(join(root, "notes.md"), "utf8").then((text) => {
				expect(text).toBe("");
				emit({ kind: "completed", event: { type: "DONE" } });
			});
		};
		const { state } = await run(
			root,
			chart({
				kind: "chart",
				id: "empty-initial-memory",
				initial: "generate",
				states: {
					generate: { kind: "state", action: produce("CURRENT OBSERVATION"), transitions: { DONE: "context" } },
					context: {
						kind: "state",
						action: tsAction("./reader.mjs", "read", {
							env: { NOTES: artifactOf("score", { artifact: "notes", ifMissing: "empty" }) },
						}),
						transitions: { DONE: "prior" },
					},
					prior: {
						kind: "state",
						action: agent("reader", {
							reads: ["notes.md"],
							artifacts: { notes: artifact({ from: "score", artifact: "notes", rollback: true, ifMissing: "empty" }) },
						}),
						transitions: { DONE: "done" },
					},
					score: { kind: "state", action: produce("not executed"), transitions: { DONE: "done" } },
					done: final(),
				},
			}),
			executor,
		);
		expect(state.projection.results.context).toMatchObject({ snapshot: "", live: "CURRENT OBSERVATION" });
		expect(await readFile(join(root, "notes.md"), "utf8")).toBe("CURRENT OBSERVATION");
		expect(state.projection.artifactPins["notes.md"]).toEqual(pin("CURRENT OBSERVATION"));
		const initial = renderRead(
			state,
			{ kind: "artifactOf", state: "score", artifact: "notes", ifMissing: "empty" },
			"done",
		);
		expect(initial.snapshot).toBe("empty");
		expect(state.projection.artifactVersions.prior).toEqual({});
	});

	it("keeps the temporary view through guard rejection, then restores it after acceptance", async () => {
		const root = await directory();
		await writeReader(root);
		let attempt = 0;
		const executor = new FakeAgentExecutor();
		executor.start = (_effect, emit) => {
			void (async () => {
				expect(await readFile(join(root, "notes.md"), "utf8")).toBe(attempt === 0 ? "old" : "edited");
				await writeFile(join(root, "notes.md"), "edited");
				emit({ kind: "completed", event: { type: "DONE", output: { approved: attempt++ > 0 } } });
			})();
		};
		const { state } = await run(
			root,
			chart({
				kind: "chart",
				id: "guarded-rollback",
				initial: "score",
				states: {
					score: { kind: "state", action: produce("old"), transitions: { DONE: "generate" } },
					generate: { kind: "state", action: produce("current"), transitions: { DONE: "prior" } },
					prior: {
						kind: "state",
						action: agent("reader", {
							artifacts: { notes: artifact({ from: "score", artifact: "notes", rollback: true }) },
							validation: {
								guard: tsImport("./reader.mjs", "guard", { env: { OWN: artifactOf("prior", { artifact: "notes" }) } }),
								onFail: { nudge: 1, restart: 0 },
							},
						}),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
			executor,
		);
		expect(attempt).toBe(2);
		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(await readFile(join(root, "notes.md"), "utf8")).toBe("current");
		expect(state.projection.artifactPins["notes.md"]).toEqual(pin("current"));
	});

	it("restores a borrowed view on cancellation/disposal", async () => {
		const root = await directory();
		const executor = new FakeAgentExecutor();
		const f = await runtimeAt(
			root,
			chart({
				kind: "chart",
				id: "cancel-rollback",
				initial: "score",
				states: {
					score: { kind: "state", action: produce("old"), transitions: { DONE: "generate" } },
					generate: { kind: "state", action: produce("current"), transitions: { DONE: "prior" } },
					prior: {
						kind: "state",
						action: agent("reader", {
							artifacts: { notes: artifact({ from: "score", artifact: "notes", rollback: true }) },
						}),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
			executor,
		);
		const running = start(f.runtime);
		try {
			await executor.waitForStart(1);
			expect(await readFile(join(root, "notes.md"), "utf8")).toBe("old");
		} finally {
			await f.runtime.dispose();
			await expect(running).rejects.toThrow("Event queue closed before reaching a final state");
		}
		expect(await readFile(join(root, "notes.md"), "utf8")).toBe("current");
	});

	it.each([
		"missing",
		"corrupt",
	])("fails closed on a %s selected CAS object and restores the accepted working revision", async (mode) => {
		const f = await effectRuntime();
		const old = await stored(f.store, f.root, "old");
		const accepted = await stored(f.store, f.root, "accepted");
		if (mode === "missing") {
			await rm(f.store.objectPath(old.hash));
		} else {
			await writeFile(f.store.objectPath(old.hash), "BROKEN");
		}
		await writeFile(join(f.root, "notes.md"), "unaccepted edit");
		const view = { path: "notes.md", snapshot: old, rollback: { to: accepted } };
		await expect(f.runtime.runEffects([borrow("owner", [view])])).rejects.toThrow();
		await f.runtime.dispose();
		expect(await readFile(join(f.root, "notes.md"), "utf8")).toBe("accepted");
	});

	it("restores accepted bytes, not differing working bytes, and fails closed on a corrupt restore revision", async () => {
		const f = await effectRuntime();
		const old = await stored(f.store, f.root, "old");
		const accepted = await stored(f.store, f.root, "accepted");
		await writeFile(join(f.root, "notes.md"), "unaccepted edit");
		const view = { path: "notes.md", snapshot: old, rollback: { to: accepted } };
		await f.runtime.runEffects([borrow("owner", [view])]);
		expect(await readFile(join(f.root, "notes.md"), "utf8")).toBe("old");
		await f.runtime.runEffects([restore("owner", [view])]);
		expect(await readFile(join(f.root, "notes.md"), "utf8")).toBe("accepted");

		await f.runtime.runEffects([borrow("owner", [view])]);
		await writeFile(f.store.objectPath(accepted.hash), "BROKEN");
		await expect(f.runtime.runEffects([restore("owner", [view])])).rejects.toThrow("corrupt");
		await expect(access(join(f.root, "notes.md"))).rejects.toThrow();
		// The path stays held after a failed restore, and disposal reports it instead of hiding it.
		await expect(f.runtime.dispose()).rejects.toThrow();
	});

	it("removes the working file when the path had no accepted revision, even if an untracked file existed", async () => {
		const f = await effectRuntime();
		const old = await stored(f.store, f.root, "old");
		await writeFile(join(f.root, "notes.md"), "untracked");
		const view = { path: "notes.md", snapshot: old, rollback: {} };
		await f.runtime.runEffects([borrow("owner", [view])]);
		expect(await readFile(join(f.root, "notes.md"), "utf8")).toBe("old");
		await f.runtime.runEffects([restore("owner", [view])]);
		await expect(access(join(f.root, "notes.md"))).rejects.toThrow();
		await f.runtime.dispose();
	});
});

it("round-trips borrowed source declarations and rejects unknown/cyclic sources", () => {
	const definition = chart({
		kind: "chart",
		id: "borrowed-source",
		initial: "source",
		states: {
			source: { kind: "state", action: produce("old"), transitions: { DONE: "read" } },
			read: {
				kind: "state",
				action: agent("reader", {
					artifacts: { notes: artifact({ from: "source", artifact: "notes", rollback: true, ifMissing: "empty" }) },
				}),
				transitions: { DONE: "done" },
			},
			done: final(),
		},
	});
	const ast = parse(definition);
	const source = hyperchartSource(ast);
	const inspected = inspectChartAst(ast);
	const view = hyperchartRunFromInspectResult(inspected).states.find((state) => state.id === "read");
	expect(view?.artifacts).toMatchObject([
		{ sourceState: "source", sourceArtifact: "notes", rollback: true, ifMissing: "empty" },
	]);
	expect(inspected.states.find((state) => state.id === "read")?.refs).toMatchObject([
		expect.objectContaining({ kind: "artifactOf", state: "source" }),
	]);
	expect(source).toContain('from: "source"');
	expect(source).toContain("rollback: true");
	expect(source).toContain('ifMissing: "empty"');
	expect(hyperchartSource(ast, "read")).toContain('from: "source"');
	const invalid = chart({
		kind: "chart",
		id: "bad-source",
		initial: "read",
		states: {
			read: {
				kind: "state",
				action: agent("reader", { artifacts: { notes: artifact({ from: "missing", artifact: "notes" }) } }),
				transitions: { DONE: "done" },
			},
			done: final(),
		},
	});
	expect(normalizeChartConfig(invalid).ok).toBe(false);
});

it("uses the accepted producer path even when its current visit counter advances", async () => {
	const root = await directory();
	const executor = new FakeAgentExecutor({ decide: [{ type: "AGAIN" }, { type: "DONE" }] });
	const f = await run(
		root,
		chart({
			kind: "chart",
			id: "last-accepted-visit",
			initial: "write",
			states: {
				write: {
					kind: "state",
					action: script(
						process.execPath,
						["-e", `require('node:fs').writeFileSync('note-'+process.env.N+'.txt',process.env.N)`],
						{ env: { N: t`${visit()}` }, artifacts: { notes: artifact(t`note-${visit()}.txt`) } },
					),
					transitions: { DONE: "decide" },
				},
				decide: { kind: "state", action: agent("decider"), transitions: { AGAIN: "write", DONE: "read" } },
				read: {
					kind: "state",
					action: script(
						process.execPath,
						[
							"-e",
							`console.log(JSON.stringify({type:'DONE',output:require('node:fs').readFileSync(process.env.NOTES,'utf8')}))`,
						],
						{ env: { NOTES: artifactOf("write", { artifact: "notes" }) } },
					),
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		}),
		executor,
	);
	expect(f.state.projection.results.read).toBe("2");
	const writer = f.ast.states.write;
	if (writer?.kind !== "state") {
		throw Error("Missing writer");
	}
	f.state.projection.stateVisits[actionUidKey(writer.action.uid)] = 99;
	expect(renderRead(f.state, { kind: "artifactOf", state: "write", artifact: "notes" }, "read")).toMatchObject({
		path: "note-2.txt",
		snapshot: pin("2"),
	});
});

it("rejects overlapping borrowers and restores a cancelled view before a later borrower reuses the path", async () => {
	const f = await effectRuntime();
	const old = await stored(f.store, f.root, "old");
	const current = await stored(f.store, f.root, "current");
	await writeFile(join(f.root, "notes.md"), "current");
	const view = { path: "notes.md", snapshot: old, rollback: { to: current } };
	await f.runtime.runEffects([borrow("first", [view])]);
	// A restart of the same action may mount its source again; another action may not.
	await f.runtime.runEffects([borrow("first", [view])]);
	await expect(f.runtime.runEffects([borrow("conflict", [view])])).rejects.toThrow("serialize access");
	await writeFile(join(f.root, "notes.md"), "first edit");
	await f.runtime.runEffects([
		{ kind: "cancel", id: "cancel:first", actionUid: uid("first"), restore: [view] },
		borrow("next", [view]),
	]);
	expect(await readFile(join(f.root, "notes.md"), "utf8")).toBe("old");
	await f.runtime.runEffects([restore("next", [view])]);
	expect(await readFile(join(f.root, "notes.md"), "utf8")).toBe("current");
	await f.runtime.dispose();
});

it("ignores a late guard verdict of a cancelled invocation without touching the re-entered view", async () => {
	const root = await directory();
	await writeFile(
		join(root, "gate.mjs"),
		`export function wait() {
	const shared = globalThis.__borrowedGuard;
	shared.calls += 1;
	if (shared.calls > 1) return true;
	shared.entered();
	return shared.verdict;
}`,
	);
	let entered: () => void = () => {};
	let release: (outcome: boolean) => void = () => {};
	const shared = {
		calls: 0,
		entered: () => entered(),
		verdict: new Promise<boolean>((resolve) => {
			release = resolve;
		}),
	};
	const guardEntered = new Promise<void>((resolve) => {
		entered = resolve;
	});
	(globalThis as { __borrowedGuard?: typeof shared }).__borrowedGuard = shared;
	const views: string[] = [];
	let readers = 0;
	let watchers = 0;
	const executor = new FakeAgentExecutor();
	executor.start = (effect, emit) => {
		void (async () => {
			if (effect.actionUid.state === "again") {
				emit({ kind: "completed", event: { type: "DONE" } });
				return;
			}
			if (effect.actionUid.state === "audit.b.watch") {
				// The first watch exits the parallel while the reader's guard is still running.
				if (watchers++ === 0) {
					await guardEntered;
					emit({ kind: "completed", event: { type: "ESCALATE" } });
				} else {
					emit({ kind: "completed", event: { type: "OK" } });
				}
				return;
			}
			views.push(await readFile(join(root, "notes.md"), "utf8"));
			if (readers++ === 0) {
				await writeFile(join(root, "notes.md"), "abandoned edit");
			} else {
				release(true);
				await new Promise((resolve) => setTimeout(resolve, 50));
				views.push(await readFile(join(root, "notes.md"), "utf8"));
			}
			emit({ kind: "completed", event: { type: "DONE" } });
		})();
	};
	const reader = compound({
		initial: "prior",
		states: {
			prior: {
				kind: "state",
				action: agent("reader", {
					artifacts: { notes: artifact({ from: "score", artifact: "notes", rollback: true }) },
					validation: { guard: tsImport("./gate.mjs", "wait") },
				}),
				transitions: { DONE: "finished" },
			},
			finished: final(),
		},
	});
	const watcher = compound({
		initial: "watch",
		states: {
			watch: { kind: "state", action: agent("watcher"), transitions: { OK: "finished" } },
			finished: final(),
		},
	});
	const { state } = await run(
		root,
		chart({
			kind: "chart",
			id: "late-guard",
			initial: "score",
			states: {
				score: { kind: "state", action: produce("old"), transitions: { DONE: "generate" } },
				generate: { kind: "state", action: produce("current"), transitions: { DONE: "audit" } },
				audit: parallel({ states: { a: reader, b: watcher }, onDone: "done", transitions: { ESCALATE: "again" } }),
				again: { kind: "state", action: agent("router"), transitions: { DONE: "audit" } },
				done: final(),
			},
		}),
		executor,
	);
	expect(state.projection.activeLeaves).toEqual(["done"]);
	expect(shared.calls).toBe(2);
	// Re-entry mounted the source again; the old verdict arrived while it was open and changed nothing.
	expect(views).toEqual(["old", "old", "old"]);
	expect(await readFile(join(root, "notes.md"), "utf8")).toBe("current");
});

it("mounts the selected source again for a restarted session", async () => {
	const root = await directory();
	await writeReader(root);
	const views: string[] = [];
	const executor = new FakeAgentExecutor();
	executor.start = (_effect, emit) => {
		void (async () => {
			views.push(await readFile(join(root, "notes.md"), "utf8"));
			await writeFile(join(root, "notes.md"), "edited");
			emit({ kind: "completed", event: { type: "DONE", output: { approved: views.length > 1 } } });
		})();
	};
	await run(
		root,
		chart({
			kind: "chart",
			id: "restart-rollback",
			initial: "score",
			states: {
				score: { kind: "state", action: produce("old"), transitions: { DONE: "generate" } },
				generate: { kind: "state", action: produce("current"), transitions: { DONE: "prior" } },
				prior: {
					kind: "state",
					action: agent("reader", {
						artifacts: { notes: artifact({ from: "score", artifact: "notes", rollback: true }) },
						validation: {
							guard: tsImport("./reader.mjs", "guard", { env: { OWN: artifactOf("prior", { artifact: "notes" }) } }),
							onFail: { nudge: 0, restart: 1 },
						},
					}),
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		}),
		executor,
	);
	expect(views).toEqual(["old", "old"]);
	expect(await readFile(join(root, "notes.md"), "utf8")).toBe("current");
});

it("reports restoration failure without hanging completion or saving temporary bytes", async () => {
	const root = await directory();
	const executor = new FakeAgentExecutor();
	executor.start = (_effect, emit) => {
		void (async () => {
			const path = join(root, "notes.md");
			await rm(path);
			await mkdir(path);
			emit({ kind: "completed", event: { type: "DONE" } });
		})();
	};
	const f = await runtimeAt(
		root,
		chart({
			kind: "chart",
			id: "failed-restore",
			initial: "source",
			states: {
				source: { kind: "state", action: produce("old"), transitions: { DONE: "prior" } },
				prior: {
					kind: "state",
					action: agent("reader", {
						artifacts: { notes: artifact({ from: "source", artifact: "notes", rollback: true }) },
					}),
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		}),
		executor,
	);
	await expect(start(f.runtime)).rejects.toThrow();
	const records = await collectHistoryRecords(f.store, "main");
	await expect(f.runtime.dispose()).rejects.toThrow();
	expect(
		records.some(
			(record) => record.type === "state_action" && record.kind === "complete" && record.actionUid.state === "prior",
		),
	).toBe(false);
});
