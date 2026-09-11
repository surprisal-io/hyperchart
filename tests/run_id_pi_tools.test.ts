import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { register } from "../packages/pi-hyperchart/extensions/hyperchart.js";
import { initializeRun, saveRunMeta, deleteRunStorage } from "../packages/hyperchart/src/runtime/generic/run_dir.js";
import {
	resolveRunPaths,
	withRunStorage,
	type RunStorage,
} from "../packages/hyperchart/src/runtime/generic/run_paths.js";
import { closeRunInspectorServer } from "../packages/hyperchart/src/inspect/inspector_server.js";

type Tool = {
	parameters: { properties: Record<string, unknown> };
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		update: () => void,
		ctx: ExtensionCommandContext,
	): Promise<{ details: Record<string, unknown> }>;
};
const roots: string[] = [];
afterEach(async () => {
	await closeRunInspectorServer();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

for (const kind of ["jsonl", "postgres"] as const) {
	it.skipIf(kind === "postgres" && process.env.HYPERCHART_PG_DSN === undefined)(
		`Pi tools use the semantic ID in ${kind} hashed storage and preserve deferred inspector scope`,
		async () => {
			const root = mkdtempSync(join(tmpdir(), "hyperchart-pi-identity-"));
			roots.push(root);
			const dsn = process.env.HYPERCHART_PG_DSN;
			if (
				kind === "postgres" &&
				(dsn === undefined || !/^autodiscovery_(?:msagl_)?labnotes_test_\d+$/.test(new URL(dsn).pathname.slice(1)))
			)
				throw new Error("Approved isolated labnotes database required");
			const storage: RunStorage =
				kind === "jsonl"
					? { kind, rootDir: join(root, "runs"), layout: "sha256" }
					: { kind, dsn: dsn!, rootDir: join(root, "runs"), layout: "sha256" };
			const runId = `autodiscovery:pi-${randomUUID()}`;
			const chartPath = join(root, "chart.mjs");
			writeFileSync(
				chartPath,
				'export default {kind:"chart",id:"identity",initial:"done",states:{done:{kind:"final"}}};',
			);
			let tool: Tool | undefined;
			const transcriptReaderForRun = vi.fn(() => async () => []);
			const api = {
				registerCommand() {},
				registerTool(value: Tool) {
					tool = value;
				},
				on() {},
				events: { on() {}, emit() {} },
			} as unknown as ExtensionAPI;
			register(api, { storage, transcriptReaderForRun });
			const ctx = {
				cwd: root,
				mode: "print",
				sessionManager: { getSessionId: () => "session-a" },
				ui: { notify() {}, setWidget() {}, setStatus() {} },
			} as unknown as ExtensionCommandContext;
			const execute = (params: Record<string, unknown>, context = ctx) =>
				tool!.execute("test", params, new AbortController().signal, () => {}, context);
			const ambient = process.env.HYPERCHART_PG_DSN;
			try {
				await withRunStorage(storage, async () => {
					await initializeRun(runId);
					await saveRunMeta(runId, {
						chartPath,
						workDir: root,
						chartId: "identity",
						createdAt: new Date().toISOString(),
					});
				});
				expect(tool!.parameters.properties).toHaveProperty("runId");
				expect(tool!.parameters.properties).not.toHaveProperty("runDir");
				const inspected = await execute({ action: "run_inspect", runId });
				expect(inspected.details.runId).toBe(runId);
				expect(inspected.details).not.toHaveProperty("runDir");
				await expect(execute({ action: "run_inspect", runDir: resolveRunPaths(runId, storage).runDir })).rejects.toThrow(
					"runDir is not supported",
				);
				await expect(execute({ action: "run_inspect", runId: resolveRunPaths(runId, storage).runDir })).rejects.toThrow(
					"No Hyperchart run metadata",
				);
				await expect(execute({ action: "run_inspect", runId: "missing" })).rejects.toThrow("No Hyperchart run metadata");
				await expect(execute({ action: "run_inspect", runId }, { ...ctx, cwd: tmpdir() })).rejects.toThrow(
					"belongs to another working directory",
				);
				const view = await execute({ action: "view", runId, open: false });
				expect(transcriptReaderForRun).toHaveBeenCalledWith(runId);
				const url = new URL(view.details.url as string);
				const token = url.pathname.split("/").at(-1);
				const foreign: RunStorage = { kind: "jsonl", rootDir: join(root, "foreign"), layout: "run-id" };
				const response = await withRunStorage(foreign, () => fetch(`${url.origin}/api/runs/${token}`));
				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({ run: { runId } });
				const history = await fetch(`${url.origin}/api/runs/${token}/history`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ operation: "listBranches", input: { runId: "foreign" } }),
				});
				expect(history.status).toBe(200);
				expect(await history.json()).toMatchObject({ found: true, result: { items: [{ branchId: "main" }] } });
				expect(process.env.HYPERCHART_PG_DSN).toBe(ambient);
			} finally {
				await withRunStorage(storage, () => deleteRunStorage(runId));
			}
		},
		15000,
	);
}
