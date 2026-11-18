import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	agent,
	artifact,
	artifactVersion,
	ArtifactVersionSchema,
	chart,
	currentVersion,
	final,
	json,
	normalizeChartConfig,
	result,
	script,
	t,
	z,
} from "../packages/hyperchart/src/index.js";
import { ChartRuntime } from "../packages/hyperchart/src/runtime/generic/chart_runtime.js";
import { MemoryLogStore } from "../packages/hyperchart/src/runtime/generic/memory_log_store.js";
import { withRunStorage } from "../packages/hyperchart/src/runtime/generic/run_paths.js";
import { FakeAgentExecutor } from "./fake_agent_executor.js";
import { start } from "./helpers/execution.js";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it.each([
	"complete",
	"fail",
	"cancel",
	"dispose",
] as const)("uses accepted defaults at the next action, not cleanup after historical reads: %s", async (end) => {
	const workDir = await mkdtemp(join(tmpdir(), "version-read-lifecycle-"));
	directories.push(workDir);
	const parsed = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "version-read-lifecycle",
			recovery: "fail",
			initial: "seed",
			states: {
				seed: {
					kind: "state",
					action: script(process.execPath, ["-e", 'require("node:fs").writeFileSync("notes.md","old")'], {
						artifacts: { notes: artifact("notes.md") },
					}),
					transitions: { DONE: "capture" },
				},
				capture: {
					kind: "state",
					action: script(
						process.execPath,
						["-e", 'console.log(JSON.stringify({type:"DONE",output:{version:JSON.parse(process.env.VERSION)}}))'],
						{
							env: { VERSION: t`${json(currentVersion("notes.md"))}` },
							reply: z.object({ version: ArtifactVersionSchema }),
						},
					),
					transitions: { DONE: "mutate" },
				},
				mutate: {
					kind: "state",
					action: script(process.execPath, ["-e", 'require("node:fs").writeFileSync("notes.md","new")'], {
						artifacts: { notes: artifact("notes.md") },
					}),
					transitions: { DONE: "read" },
				},
				read: {
					kind: "state",
					action: agent("reader", { reads: [artifactVersion(result("capture", "version"))] }),
					transitions: { DONE: "observe" },
				},
				observe: {
					kind: "state",
					action: script(process.execPath, [
						"-e",
						'if(require("node:fs").readFileSync("notes.md","utf8")!=="new") process.exit(1)',
					]),
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		}),
	);
	if (!parsed.ok) {
		throw new Error(JSON.stringify(parsed.diagnostics));
	}
	const executor = new FakeAgentExecutor();
	let finish: Parameters<FakeAgentExecutor["start"]>[1] | undefined;
	const original = executor.start.bind(executor);
	executor.start = (effect, emit) => {
		finish = emit;
		original(effect, emit);
	};
	const runtime = withRunStorage(
		{ kind: "jsonl", rootDir: workDir, layout: "run-id" },
		() =>
			new ChartRuntime({
				ast: parsed.ast,
				branchId: "main",
				logStore: new MemoryLogStore(),
				agentExecutor: executor,
				workDir,
				chartDir: workDir,
				runId: "test",
			}),
	);
	const running = start(runtime);
	const settled = running.catch((error: unknown) => error);
	let expectedAfter = "temporary edit";
	try {
		await executor.waitForStart(1);
		expect(executor.starts[0]?.reads?.[0]?.path).toBe("notes.md");
		expect(await readFile(join(workDir, "notes.md"), "utf8")).toBe("old");
		// A read can damage only the workspace copy, not the immutable store.
		await writeFile(join(workDir, "notes.md"), "temporary edit");
		switch (end) {
			case "complete":
				expectedAfter = "new";
				finish?.({ kind: "completed", event: { type: "DONE" } });
				await running;
				break;
			case "fail":
				finish?.({ kind: "failed", failure: { kind: "explicit", retryable: false, message: "fixture failure" } });
				await settled;
				break;
			case "cancel": {
				const actionUid = executor.starts[0]?.actionUid;
				if (actionUid === undefined) {
					throw new Error("no started reader");
				}
				await runtime.runEffects([{ kind: "cancel", id: "cancel-read", actionUid }]);
				break;
			}
			case "dispose":
				await runtime.dispose();
				break;
		}
	} finally {
		await runtime.dispose();
		await settled;
	}
	expect(await readFile(join(workDir, "notes.md"), "utf8")).toBe(expectedAfter);
});
