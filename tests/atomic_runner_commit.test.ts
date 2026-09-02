import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEffect, RejectedEffect } from "../packages/hyperchart/src/core/machine.js";
import type { ActionUID, ChartEvent } from "../packages/hyperchart/src/core/types.js";
import { parseChartModuleSync } from "../packages/hyperchart/src/core/inspect.js";
import { createBranchProjection } from "../packages/hyperchart/src/core/projection.js";
import { prepareProjectionCheckpoint, projectionContractForAst } from "../packages/hyperchart/src/runtime/generic/projection_loader.js";
import { PostgresLogStore } from "../packages/hyperchart/src/runtime/generic/postgres_log_store.js";
import {
  createHyperchartRunnerController,
  type SteerableAgentExecutor,
} from "../packages/hyperchart/src/runtime/generic/runner_main.js";

const dsn = process.env.HYPERCHART_PG_DSN;
const describePg = dsn === undefined ? describe.skip : describe;
const roots: string[] = [];
const runIds: string[] = [];

class NoopExecutor implements SteerableAgentExecutor {
  start(_effect: AgentEffect, _emit: (event: ChartEvent) => void): void {}
  reject(_effect: RejectedEffect, emit: (event: ChartEvent) => void): void {
    emit({ type: "FAILED", error: "rejected" });
  }
  async cancel(_actionUid: ActionUID): Promise<void> {}
  async dispose(): Promise<void> {}
  async steer(): Promise<boolean> {
    return false;
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (dsn === undefined || runIds.length === 0) return;
  const { Client } = await import("pg");
  const client = new Client({ connectionString: dsn });
  await client.connect();
  const ids = runIds.splice(0);
  await client.query("delete from hyperchart_projection_checkpoint where run_id = any($1)", [ids]);
  await client.query("delete from hyperchart_journal where run_id = any($1)", [
    ids,
  ]);
  await client
    .query("delete from hyperchart_test_claims where run_id = any($1)", [ids])
    .catch(() => {});
  await client.end();
});

async function fixture(cadenceBoundary = false) {
  const root = mkdtempSync(join(tmpdir(), "hyperchart-atomic-controller-"));
  roots.push(root);
  const workDir = join(root, "work");
  const runDir = join(root, `run-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const runId = basename(runDir);
  runIds.push(runId);
  const chartPath = join(workDir, "chart.ts");
  writeFileSync(
    chartPath,
    `import { chart, final, user } from "@surprisal/hyperchart";
     export default chart({ kind: "chart", id: "atomic-controller", initial: "ask", states: {
       ask: { kind: "state", action: user({ prompt: "Select", options: ["SELECTED"] }), transitions: { SELECTED: "done" } },
       done: final(),
     } });`,
  );
  const parsed = parseChartModuleSync(chartPath);
  if (!parsed.ok)
    throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  const state = parsed.ast.states.ask;
  if (state?.kind !== "state" || state.action.kind !== "user")
    throw new Error("invalid fixture chart");

  const store = await PostgresLogStore.open({
    dsn: dsn as string,
    runId,
    access: "writer",
  });
  const contract = projectionContractForAst(parsed.ast);
  await store.initializeRootBranchWithCheckpoint(undefined, prepareProjectionCheckpoint(createBranchProjection(parsed.ast), contract, null));
  await store.appendDrafts(Array.from({ length: cadenceBoundary ? 509 : 1 }, (_, index) => ({ type: "args", args: { index } })));
  const [invoke] = await store.appendDrafts([
    {
      type: "state_action",
      kind: "invoke",
			sessionId: "session-id",
      actionUid: state.action.uid,
      definition: state.action,
    },
  ]);
  const [opened] = await store.appendDrafts([
    {
      type: "user_interaction",
      kind: "opened",
      actionUid: state.action.uid,
      phaseSeqId: invoke!.seqId,
      prompt: "Select",
      options: ["SELECTED"],
      events: ["SELECTED"],
    },
  ]);
  await store.transaction(async (tx) => {
    await tx.query(`create table if not exists hyperchart_test_claims (
      run_id text not null,
      candidate integer not null,
      branch_id text not null,
      primary key (run_id, candidate)
    )`);
  });
  await store.close();
  return { runId, runDir, workDir, chartPath, gateSeqId: opened!.seqId };
}

describePg("atomic runner interaction commit", () => {
  it("serializes a live response with executor construction and completes without restart", async () => {
    const f = await fixture();
    let entered!: () => void; const constructionEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const constructionGate = new Promise<void>((resolve) => { release = resolve; });
    const controller = await createHyperchartRunnerController(
      { runId: f.runId, runDir: f.runDir, chartPath: f.chartPath, chartId: "atomic-controller", workDir: f.workDir, branchId: "main" },
      async () => { entered(); await constructionGate; return new NoopExecutor(); },
    );
    const aggregate = controller.start();
    await constructionEntered;
    const responding = controller.respondToUserInteraction("main", f.gateSeqId, { type: "SELECTED" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    expect((await responding).idempotent).toBe(false);
    await aggregate;
  }, 30_000);

  it("serializes an atomic fork response on its live source with executor construction", async () => {
    const f = await fixture();
    let entered!: () => void; const constructionEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const constructionGate = new Promise<void>((resolve) => { release = resolve; });
    const controller = await createHyperchartRunnerController(
      { runId: f.runId, runDir: f.runDir, chartPath: f.chartPath, chartId: "atomic-controller", workDir: f.workDir, branchId: "main" },
      async () => { entered(); await constructionGate; return new NoopExecutor(); },
    );
    const aggregate = controller.start();
    await constructionEntered;
    const committing = controller.forkAndCommitUserInteraction(
      {
        branchId: "experiment", sourceBranchId: "main", fromSeqId: f.gateSeqId,
        responseBranchId: "main", gateSeqId: f.gateSeqId, event: { type: "SELECTED" },
      },
      async () => "atomic-source-response",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    expect((await committing).participant).toBe("atomic-source-response");
    await aggregate;
  }, 30_000);

  it("commits an ordinary 511-to-512 response with its due checkpoint", async () => {
    const f = await fixture(true);
    let built!: () => void; const runtimeBuilt = new Promise<void>((resolve) => { built = resolve; });
    const controller = await createHyperchartRunnerController(
      { runId: f.runId, runDir: f.runDir, chartPath: f.chartPath, chartId: "atomic-controller", workDir: f.workDir, branchId: "main" },
      () => { built(); return new NoopExecutor(); },
    );
    const aggregate = controller.start(); await runtimeBuilt; await new Promise((resolve) => setTimeout(resolve, 25));
    const committed = await controller.respondToUserInteraction("main", f.gateSeqId, { type: "SELECTED" });
    const { Client } = await import("pg"); const client = new Client({ connectionString: dsn as string }); await client.connect();
    const checkpoint = await client.query("select 1 from hyperchart_projection_checkpoint where run_id = $1 and head_seq_id = $2", [f.runId, committed.record.seqId]);
    await client.end(); expect(checkpoint.rows).toHaveLength(1); await aggregate;
  }, 30_000);

  it("rolls back both a due response checkpoint and response when its participant fails", async () => {
    const f = await fixture(true);
    let built!: () => void; const runtimeBuilt = new Promise<void>((resolve) => { built = resolve; });
    const controller = await createHyperchartRunnerController(
      { runId: f.runId, runDir: f.runDir, chartPath: f.chartPath, chartId: "atomic-controller", workDir: f.workDir, branchId: "main" },
      () => { built(); return new NoopExecutor(); },
    );
    const aggregate = controller.start(); await runtimeBuilt; await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(controller.commitUserInteraction({ branchId: "main", gateSeqId: f.gateSeqId, event: { type: "SELECTED" } }, async () => { throw new Error("participant rollback"); })).rejects.toThrow(/participant rollback/);
    const { Client } = await import("pg"); const client = new Client({ connectionString: dsn as string }); await client.connect();
    const rows = await client.query("select record_type from hyperchart_journal where run_id = $1 and record_type = 'user_interaction' and payload->>'kind' = 'resolved'", [f.runId]);
    const checkpoints = await client.query("select 1 from hyperchart_projection_checkpoint where run_id = $1 and head_seq_id is not null", [f.runId]);
    await client.end(); expect(rows.rows).toHaveLength(0); expect(checkpoints.rows).toHaveLength(0);
    await controller.stopAndDrain("main"); await aggregate;
  }, 30_000);

  it("drains only after an already tracked participant response is acknowledged and checkpointed", async () => {
    const f = await fixture(true);
    let built!: () => void; const runtimeBuilt = new Promise<void>((resolve) => { built = resolve; });
    const controller = await createHyperchartRunnerController(
      { runId: f.runId, runDir: f.runDir, chartPath: f.chartPath, chartId: "atomic-controller", workDir: f.workDir, branchId: "main" },
      () => { built(); return new NoopExecutor(); },
    );
    const aggregate = controller.start(); await runtimeBuilt; await new Promise((resolve) => setTimeout(resolve, 25));
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void; const participantEntered = new Promise<void>((resolve) => { entered = resolve; });
    const committing = controller.commitUserInteraction({ branchId: "main", gateSeqId: f.gateSeqId, event: { type: "SELECTED" } }, async () => {
      entered(); await gate; return "participant";
    });
    await participantEntered;
    const drain = controller.stopAndDrain("main");
    await expect(controller.respondToUserInteraction("main", f.gateSeqId, { type: "SELECTED" })).rejects.toThrow(/draining/);
    release(); expect((await committing).participant).toBe("participant");
    expect((await drain).outcome).toBe("drained"); await aggregate;

    const { Client } = await import("pg"); const client = new Client({ connectionString: dsn as string }); await client.connect();
    const rows = await client.query("select max(seq) as head_seq_id from hyperchart_journal where run_id = $1 and kind = 'record' and branch_id = 'main'", [f.runId]);
    const head = rows.rows[0]?.head_seq_id;
    const checkpoint = await client.query("select 1 from hyperchart_projection_checkpoint where run_id = $1 and head_seq_id = $2", [f.runId, head]);
    await client.end(); expect(checkpoint.rows).toHaveLength(1);
  }, 30_000);

  it("exposes one controller commit for fork, response, and application SQL", async () => {
    const f = await fixture();
    const controller = await createHyperchartRunnerController(
      {
        runId: f.runId,
        runDir: f.runDir,
        chartPath: f.chartPath,
        chartId: "atomic-controller",
        workDir: f.workDir,
        branchId: "main",
      },
      () => new NoopExecutor(),
    );
    expect(await controller.durableBranchIds()).toEqual(["main"]);
    expect(controller.liveBranchIds).toEqual(["main"]);
    expect(await controller.activeBranchIds()).toEqual([]);

    const committed = await controller.forkAndCommitUserInteraction(
      {
        branchId: "experiment",
        sourceBranchId: "main",
        fromSeqId: f.gateSeqId,
        responseBranchId: "experiment",
        gateSeqId: f.gateSeqId,
        event: { type: "SELECTED" },
        reason: "atomic-test",
      },
      async (tx) => {
        await tx.query(
          "insert into hyperchart_test_claims (run_id, candidate, branch_id) values ($1, 1, 'experiment')",
          [f.runId],
        );
        return "claim-committed";
      },
    );
    expect(committed.participant).toBe("claim-committed");
    expect(committed.branch.branchId).toBe("experiment");
    const retried = await controller.forkAndCommitUserInteraction(
      {
        branchId: "experiment", sourceBranchId: "main", fromSeqId: f.gateSeqId,
        responseBranchId: "experiment", gateSeqId: f.gateSeqId,
        event: { type: "SELECTED" }, reason: "atomic-test",
      },
      async (tx) => {
        const result = await tx.query("select branch_id from hyperchart_test_claims where run_id = $1 and candidate = 1", [f.runId]);
        return result.rows[0]?.branch_id;
      },
    );
    expect(retried.response.idempotent).toBe(true);
    expect(retried.participant).toBe("experiment");
    expect(await controller.durableBranchIds()).toEqual(["main", "experiment"]);
    // The commit is durable before admission; a restart may safely admit this exact branch.
    const aggregate = controller.start();
    const outcome = await controller.startBranch("experiment");
    expect(outcome).toMatchObject({ branchId: "experiment", outcome: "complete" });
    await controller.stop();
    await aggregate;

    const reader = await PostgresLogStore.open({
      dsn: dsn as string,
      runId: f.runId,
      branchId: "experiment",
    });
    const ancestry = await reader.readAncestry(reader.branchId);
    expect(ancestry.at(-1)).toMatchObject({
      type: "user_interaction",
      kind: "resolved",
      gateSeqId: f.gateSeqId,
      event: { type: "SELECTED" },
    });
    await reader.close();
  }, 30_000);
});
