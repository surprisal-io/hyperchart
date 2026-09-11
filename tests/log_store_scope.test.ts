import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { JsonlLogStore } from "../packages/hyperchart/src/runtime/generic/log_store.js";
import { openRunLogStore, withRunLogStorage } from "../packages/hyperchart/src/runtime/generic/log_store_factory.js";
import { readRunnerConfig } from "../packages/hyperchart/src/runner/runner_main.js";

const roots: string[] = [];
function fixtureStorage() {
	const rootDir = mkdtempSync(join(tmpdir(), "hyperchart-storage-scope-"));
	roots.push(rootDir);
	return { kind: "jsonl" as const, rootDir, layout: "run-id" as const };
}
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});
it("uses an explicit scoped backend/root/layout instead of process-wide PostgreSQL", async () => {
	vi.stubEnv("HYPERCHART_PG_DSN", "postgres://leaked.invalid/example");
	const storage = fixtureStorage();
	const store = await withRunLogStorage(storage, () => openRunLogStore("semantic:run"));
	expect(store).toBeInstanceOf(JsonlLogStore);
	await store.close();
	expect(process.env.HYPERCHART_PG_DSN).toBe("postgres://leaked.invalid/example");
});
it("preserves the complete explicit storage scope in runner configuration", () => {
	const storage = fixtureStorage();
	const configPath = join(storage.rootDir, "runner.config.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			runId: "run",
			chartPath: join(storage.rootDir, "chart.ts"),
			chartId: "chart",
			workDir: storage.rootDir,
			branchId: "main",
			storage,
		}),
	);
	expect(readRunnerConfig(configPath).storage).toEqual(storage);
});
it("rejects malformed declared configuration rather than inferring per-run paths", () => {
	const storage = fixtureStorage();
	const configPath = join(storage.rootDir, "runner.config.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			runId: "run",
			chartPath: "chart.ts",
			chartId: "chart",
			workDir: storage.rootDir,
			branchId: "main",
			storage: { kind: "postgres" },
		}),
	);
	expect(() => readRunnerConfig(configPath)).toThrow(/storage must select/);
});
it("never lets a per-run config override the host's selected backend", async () => {
	const storage = fixtureStorage();
	mkdirSync(join(storage.rootDir, "run"));
	writeFileSync(
		join(storage.rootDir, "run", "runner.config.json"),
		JSON.stringify({
			storage: {
				kind: "postgres",
				dsn: "postgres://foreign.invalid/example",
				rootDir: storage.rootDir,
				layout: "run-id",
			},
		}),
	);
	const store = await withRunLogStorage(storage, () => openRunLogStore("run"));
	expect(store).toBeInstanceOf(JsonlLogStore);
	await store.close();
	await expect(openRunLogStore("run")).rejects.toThrow(/storage scope is required/);
});
