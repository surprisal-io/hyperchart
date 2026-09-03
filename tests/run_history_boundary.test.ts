import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { BranchId, DurableLogRecord } from "../packages/hyperchart/src/core/durable_events.js";
import { terminalStateForFinalMachine } from "../packages/hyperchart/src/execution/run_outcome.js";
import { MemoryLogStore } from "../packages/hyperchart/src/runtime/generic/memory_log_store.js";
import type { PostgresLogStore, PostgresRunTransaction, SqlTransactionalRunLogStore } from "../packages/hyperchart/src/runtime/generic/postgres_log_store.js";
import {
	HISTORY_READ_ITEMS,
	type HistoryChunk,
	type RunLogStore,
} from "../packages/hyperchart/src/runtime/generic/log_store.js";
import { EXECUTION_REPLAY_BATCH_RECORDS } from "../packages/hyperchart/src/execution/projection_restore.js";

const packageRoot = fileURLToPath(new URL("../packages", import.meta.url));
const runtimeIndex = fileURLToPath(new URL("../packages/hyperchart/src/runtime/index.ts", import.meta.url));
const runnerIndex = fileURLToPath(new URL("../packages/hyperchart/src/runner/index.ts", import.meta.url));
const runtimeSources = fileURLToPath(new URL("../packages/hyperchart/src/runtime", import.meta.url));
const hostIndex = fileURLToPath(new URL("../packages/hyperchart/src/host/index.ts", import.meta.url));
const reactIndex = fileURLToPath(new URL("../packages/hyperchart/src/react/index.ts", import.meta.url));
const inspectIndex = fileURLToPath(new URL("../packages/hyperchart/src/inspect/index.ts", import.meta.url));
const inspectRun = fileURLToPath(new URL("../packages/hyperchart/src/inspect/run_inspect.ts", import.meta.url));

function sourcesUnder(path: string): string {
	return readdirSync(path).flatMap((name) => {
		const child = join(path, name);
		if (statSync(child).isDirectory()) return sourcesUnder(child);
		return /\.(?:ts|tsx)$/.test(name) ? [readFileSync(child, "utf8")] : [];
	}).join("\n");
}

describe("bounded run-history API boundary", () => {
	it("does not expose deleted materialized-log methods or replay streams", () => {
		expectTypeOf<RunLogStore>().not.toHaveProperty("readAncestry");
		expectTypeOf<RunLogStore>().not.toHaveProperty("readAll");
		expectTypeOf<RunLogStore>().not.toHaveProperty("snapshot");
		expectTypeOf<RunLogStore>().not.toHaveProperty("respondToUserInteraction");
		expectTypeOf<MemoryLogStore>().not.toHaveProperty("storageEntries");
		expectTypeOf<MemoryLogStore>().not.toHaveProperty("respondToUserInteraction");
		expectTypeOf<PostgresLogStore>().not.toHaveProperty("respondToUserInteraction");
		expectTypeOf<PostgresRunTransaction>().not.toHaveProperty("respondToUserInteraction");
		expectTypeOf<PostgresRunTransaction>().not.toHaveProperty("commitPreparedUserInteraction");
		expectTypeOf<SqlTransactionalRunLogStore>().not.toHaveProperty("commitUserInteraction");
		expectTypeOf<RunLogStore>().not.toHaveProperty("appendDraftsWithCheckpoint");
		expectTypeOf<RunLogStore>().not.toHaveProperty("createBranchWithCheckpoint");
		expectTypeOf<RunLogStore>().not.toHaveProperty("moveBranchWithCheckpoint");
		expectTypeOf<ConstructorParameters<typeof MemoryLogStore>>().toEqualTypeOf<[branchId?: BranchId]>();
		expectTypeOf<HistoryChunk<DurableLogRecord>["items"]>().toEqualTypeOf<readonly DurableLogRecord[]>();
		expectTypeOf<Parameters<typeof terminalStateForFinalMachine>>().toEqualTypeOf<[state: Parameters<typeof terminalStateForFinalMachine>[0]]>();

		const entrypoint = readFileSync(runtimeIndex, "utf8");
		expect(entrypoint).not.toMatch(/openExecutionReplay|EXECUTION_REPLAY_BATCH_RECORDS|NormalizedRunLog|RunLogReader|collectBranches|RespondToUserInteractionInput/);
		expect(entrypoint).not.toMatch(/\b(?:latestPinsByPath|materializeWorkspace|finalMachineFailureMessage|listHyperchartBranches|loadBranchProjection|projectBranch|ProjectionContract|PROJECTOR_VERSION|listHyperchartBranchPage)\b/);
		expect(entrypoint).toMatch(/materializeWorkspaceFromPins|OpaqueCheckpointEnvelope|PrepareStampedCommit/);
		expect(readFileSync(runnerIndex, "utf8")).toMatch(/listHyperchartBranchPage|createHyperchartRunnerController/);
	});

	it("does not export materialized-record host or inspect compatibility surfaces", () => {
		expect(readFileSync(hostIndex, "utf8")).not.toMatch(/hyperchartRunFromRuntime|HyperchartRunFromRuntimeOptions/);
		expect(readFileSync(reactIndex, "utf8")).not.toContain("hyperchartRunFromRuntime");
		expect(readFileSync(inspectIndex, "utf8")).not.toContain("records");
		expect(readFileSync(inspectRun, "utf8")).not.toMatch(/records\?:\s*readonly DurableLogRecord\[\]/);
		expect(sourcesUnder(join(packageRoot, "hyperchart/src/host"))).not.toContain("readRunSnapshot");
	});

	it("keeps public chunks and private replay batches capped", () => {
		expect(HISTORY_READ_ITEMS).toBe(100);
		expect(EXECUTION_REPLAY_BATCH_RECORDS).toBe(500);
	});

	it("prevents host and UI layers from importing the private replay stream", () => {
		const consumers = [
			join(packageRoot, "hyperchart/src/host"),
			join(packageRoot, "hyperchart/src/react"),
			join(packageRoot, "hyperchart/src/inspect"),
			join(packageRoot, "pi-hyperchart"),
			join(packageRoot, "claude-hyperchart"),
		].map(sourcesUnder).join("\n");
		expect(consumers).not.toContain("openExecutionReplay");
		expect(consumers).not.toContain("listHyperchartBranches");
	});

	it("keeps runtime and storage independent from projection and execution internals", () => {
		const runtime = sourcesUnder(runtimeSources);
		expect(runtime).not.toMatch(/from ["'][^"']*(?:core\/projection|projection_retention|execution\/)/);
		expect(runtime).not.toMatch(/\b(?:BranchProjection|projectBranch|loadBranchProjection|projectorVersion|astDigest|ProjectionContract)\b/);
		const postgres = readFileSync(join(packageRoot, "hyperchart/src/runtime/generic/postgres_log_store.ts"), "utf8");
		expect(postgres).toContain("selector_key");
		expect(postgres).toContain("blob jsonb");
		expect(postgres).not.toMatch(/projector_version|ast_digest|projection jsonb|hyperchart_projection_checkpoint/);
	});

	it("keeps storage independent from AST, projection, and host layers", () => {
		const storage = [
			"log_store.ts",
			"memory_log_store.ts",
			"postgres_log_store.ts",
		].map((name) => readFileSync(join(packageRoot, "hyperchart/src/runtime/generic", name), "utf8")).join("\n");
		expect(storage).not.toMatch(/core\/(?:projection|normalize|inspect)|\/host\/|user_interaction_admission/);
	});
});
