import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ImportedActionEffect } from "../../packages/hyperchart/src/index.js";
import { createHyperchartRunnerController } from "../../packages/hyperchart/src/runner/runner_main.js";
import { FunctionRunner } from "../../packages/hyperchart/src/runtime/generic/function_runner.js";
import { initializeRun } from "../../packages/hyperchart/src/runtime/generic/run_dir.js";
import { type RunStorage, withRunStorage } from "../../packages/hyperchart/src/runtime/generic/run_paths.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	process.exitCode = 0;
});

type HostCall = { by: "guard" | "action"; workDir: string; value?: unknown };

/** What a host hands its run: here a service that records who called it and from which branch workspace. */
function recordingHost() {
	const calls: HostCall[] = [];
	return {
		calls,
		check(event: { output?: { n?: number } }, workDir: string) {
			calls.push({ by: "guard", workDir, value: event.output?.n });
			return event.output?.n === 21;
		},
		double(n: number, workDir: string) {
			calls.push({ by: "action", workDir, value: n });
			return n * 2;
		},
	};
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "hyperchart-host-services-"));
	roots.push(root);
	const storage: RunStorage = { kind: "jsonl", rootDir: join(root, "runs"), layout: "sha256" };
	const chartPath = join(root, "chart.ts");
	writeFileSync(
		join(root, "guard.mjs"),
		"export function check(event, ctx) { return ctx.hostServices.check(event, ctx.workDir) ? true : { ok: false, reason: 'rejected by host' }; }\n",
	);
	writeFileSync(
		join(root, "compute.mjs"),
		"export function compute(_params, ctx) { return { type: 'DONE', output: { doubled: ctx.hostServices.double(ctx.input.n, ctx.workDir) } }; }\n",
	);
	writeFileSync(
		chartPath,
		`import { chart, agent, final, tsAction, tsImport, event, z } from "@surprisal/hyperchart";
export default chart({ kind: "chart", id: "host-services", initial: "work", states: {
  work: { kind: "state", action: agent("worker", { validation: { guard: tsImport("./guard.mjs", "check") } }),
    transitions: { DONE: { target: "compute", input: { n: event("n") } } } },
  compute: { kind: "state", input: { n: z.number() }, action: tsAction("./compute.mjs", "compute"),
    transitions: { DONE: "done" } },
  done: final() } });`,
	);
	return { root, storage, chartPath, runId: "host-services:run" };
}

describe("host services for imported functions", () => {
	it("hands the runner host's services to imported guards and actions, with the branch workspace", async () => {
		const f = fixture();
		await withRunStorage(f.storage, () => initializeRun(f.runId));
		const host = recordingHost();
		const controller = await createHyperchartRunnerController(
			{
				runId: f.runId,
				storage: f.storage,
				chartId: "host-services",
				chartPath: f.chartPath,
				workDir: f.root,
				branchId: "main",
				hostServices: host,
			},
			() => ({
				start(_effect, emit) {
					emit({ kind: "completed", event: { type: "DONE", output: { n: 21 } } });
				},
				async cancel() {},
				async dispose() {},
				async steer() {
					return false;
				},
			}),
		);
		const outcome = await controller.start();
		expect(outcome.state).toBe("complete");
		expect(outcome.branches[0]?.results?.compute).toEqual({ doubled: 42 });
		expect(host.calls.map(({ by, value }) => [by, value])).toEqual([
			["guard", 21],
			["action", 21],
		]);
		// Both reached the host from the branch's isolated workspace, not from the project directory.
		const workDirs = new Set(host.calls.map((call) => call.workDir));
		expect(workDirs.size).toBe(1);
		expect([...workDirs][0]).not.toBe(f.root);
		expect([...workDirs][0]).toContain(join("workspaces", "main"));
	});

	it("leaves context.hostServices out when the host passes none", async () => {
		const root = await mkdtemp(join(tmpdir(), "hyperchart-host-absent-"));
		roots.push(root);
		await writeFile(
			join(root, "probe.mjs"),
			"export function probe(_params, ctx) { return { type: 'DONE', output: { hasHost: 'hostServices' in ctx } }; }\n",
		);
		const actionUid = { chart: "host-unit", state: "work", action: "tsImport" };
		const effect: Omit<ImportedActionEffect, "env"> = {
			kind: "tsImport",
			id: "function:work:1",
			actionUid,
			action: { kind: "tsImport", uid: actionUid, module: "./probe.mjs", export: "probe" },
			module: "./probe.mjs",
			export: "probe",
			events: ["DONE", "FAILED"],
		};
		const bare = new FunctionRunner({ chartDir: root, workDir: root });
		await expect(bare.run(effect)).resolves.toEqual({ type: "DONE", output: { hasHost: false } });
		await bare.dispose();
		const hosted = new FunctionRunner({ chartDir: root, workDir: root, hostServices: { any: "service" } });
		await expect(hosted.run(effect)).resolves.toEqual({ type: "DONE", output: { hasHost: true } });
		await hosted.dispose();
	});
});
