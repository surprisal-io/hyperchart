import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEffect, RejectedEffect } from "../packages/hyperchart/src/core/machine.js";
import type { ActionUID, ChartEvent } from "../packages/hyperchart/src/core/types.js";
import { parseChartModuleSync } from "../packages/hyperchart/src/core/inspect.js";
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
  await client.query("delete from hyperchart_journal where run_id = any($1)", [
    ids,
  ]);
  await client
    .query("delete from hyperchart_test_claims where run_id = any($1)", [ids])
    .catch(() => {});
  await client.end();
});

async function fixture() {
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
  await store.initializeRootBranch();
  await store.appendDrafts([{ type: "args", args: {} }]);
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
  });
});
