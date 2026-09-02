import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { normalizeChartConfig, type ChartAst, type ChartCst, type DurableRecordDraft } from "../packages/hyperchart/src/index.js";
import { chart, final, user } from "../packages/hyperchart/src/core/dsl.js";
import { HISTORY_READ_ITEMS, HistoryCursorError, openProjectionReplay } from "../packages/hyperchart/src/runtime/generic/log_store.js";
import {
	JOURNAL_CHANNEL,
	JOURNAL_TABLE,
	PostgresLogStore,
	RUN_META_TABLE,
} from "../packages/hyperchart/src/runtime/generic/postgres_log_store.js";
import { deleteRunStorage, initializeRunDir, loadRunMeta, saveRunMeta } from "../packages/hyperchart/src/runtime/generic/run_dir.js";
import { patchRunStatus } from "../packages/hyperchart/src/runtime/generic/run_status.js";
import { createPiHyperchartHost } from "../packages/pi-hyperchart/src/runtime/pi/host_adapter.js";

const dsn = process.env.HYPERCHART_PG_DSN;
const describePg = dsn === undefined ? describe.skip : describe;

const openStores: PostgresLogStore[] = [];
const usedRunIds: string[] = [];

async function openWriter(runId: string): Promise<PostgresLogStore> {
	const store = await PostgresLogStore.open({ dsn: dsn as string, runId, access: "writer" });
	openStores.push(store);
	return store;
}

async function openReader(runId: string): Promise<PostgresLogStore> {
	const store = await PostgresLogStore.open({ dsn: dsn as string, runId });
	openStores.push(store);
	return store;
}

function newRunId(): string {
	const runId = `test-${randomUUID()}`;
	usedRunIds.push(runId);
	return runId;
}

function argsDraft(args: Readonly<Record<string, unknown>> = { topic: "test" }): DurableRecordDraft {
	return { type: "args", args };
}

function invokeDraft(): DurableRecordDraft {
	const actionUid = { chart: "chart", state: "work", action: "agent" };
	return { type: "state_action", kind: "invoke", sessionId: "session-id", actionUid, definition: { kind: "agent", uid: actionUid, name: "worker" } };
}

function userAst(): ChartAst {
	const config: ChartCst = chart({
		kind: "chart",
		id: "postgres-user",
		initial: "ask",
		states: {
			ask: { kind: "state", action: user({ prompt: "Select", options: ["SELECTED"] }), transitions: { SELECTED: "done" } },
			done: final(),
		},
	});
	const result = normalizeChartConfig(config);
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.ast;
}

async function appendOpenGate(store: PostgresLogStore, ast: ChartAst): Promise<number> {
	const state = ast.states.ask;
	if (state?.kind !== "state" || state.action.kind !== "user") throw new Error("invalid user chart fixture");
	await store.appendDrafts([{ type: "args", args: {} }]);
	const [invoke] = await store.appendDrafts([{ type: "state_action", kind: "invoke", sessionId: "session-id", actionUid: state.action.uid, definition: state.action }]);
	const [opened] = await store.appendDrafts([{
		type: "user_interaction",
		kind: "opened",
		actionUid: state.action.uid,
		phaseSeqId: invoke!.seqId,
		prompt: "Select",
		options: ["SELECTED"],
		events: ["SELECTED"],
	}]);
	return opened!.seqId;
}

async function journalStats(store: PostgresLogStore, runId: string): Promise<{ count: number; maxSeq: number }> {
	const result = await store.transaction((tx) => tx.query(`SELECT COUNT(*)::int AS count, COALESCE(MAX(seq), 0)::int AS max_seq FROM ${JOURNAL_TABLE} WHERE run_id = $1`, [runId]));
	return { count: Number(result.rows[0]?.count), maxSeq: Number(result.rows[0]?.max_seq) };
}

async function ensureClaimTable(store: PostgresLogStore): Promise<void> {
	await store.transaction(async (tx) => {
		await tx.query(`CREATE TABLE IF NOT EXISTS hyperchart_test_claims (
		  run_id text NOT NULL,
		  candidate integer NOT NULL,
		  branch_id text NOT NULL,
		  PRIMARY KEY (run_id, candidate)
		)`);
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(openStores.splice(0).map((store) => store.close().catch(() => {})));
});

afterAll(async () => {
	if (dsn === undefined || usedRunIds.length === 0) return;
	const { Client } = await import("pg");
	const client = new Client({ connectionString: dsn });
	await client.connect();
	await client.query(`DELETE FROM ${JOURNAL_TABLE} WHERE run_id = ANY($1)`, [usedRunIds]).catch(() => {});
	await client.query(`DELETE FROM ${RUN_META_TABLE} WHERE run_id = ANY($1)`, [usedRunIds]).catch(() => {});
	await client.query("DELETE FROM hyperchart_test_claims WHERE run_id = ANY($1)", [usedRunIds]).catch(() => {});
	await client.end();
});

describePg("PostgresLogStore", () => {
	it("stores run metadata in PostgreSQL without requiring meta.json", async () => {
		const runId = newRunId();
		const runDir = join(tmpdir(), runId);
		await mkdir(runDir, { recursive: true });
		await initializeRunDir(runDir);
		const meta = {
			chartPath: join(runDir, "workflow.chart.ts"),
			workDir: runDir,
			chartId: "postgres-meta",
			createdAt: new Date().toISOString(),
			originSessionId: "session-meta",
		};
		try {
			await saveRunMeta(runDir, meta);
			expect(existsSync(join(runDir, "meta.json"))).toBe(false);
			expect(await loadRunMeta(runDir)).toEqual(meta);
			await deleteRunStorage(runDir);
			await expect(loadRunMeta(runDir)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await (await openReader(runId)).listBranches()).toEqual({ items: [], totalCount: 0 });
		} finally {
			await rm(runDir, { recursive: true, force: true });
		}
	});

	it("discovers a PostgreSQL-backed run without meta.json through the Pi host", async () => {
		const runId = newRunId();
		const root = join(tmpdir(), `postgres-meta-host-${randomUUID()}`);
		const agentDir = join(root, "agent");
		const workDir = join(root, "project");
		const runDir = join(agentDir, "hypercharts", "runs", runId);
		const chartPath = join(workDir, "postgres-meta.chart.ts");
		await mkdir(workDir, { recursive: true });
		await writeFile(chartPath, `import { chart, final } from "@surprisal/hyperchart";\nexport default chart({ kind: "chart", id: "postgres-meta-host", initial: "done", states: { done: final() } });\n`);
		try {
			await initializeRunDir(runDir);
			await saveRunMeta(runDir, { chartPath, workDir, chartId: "postgres-meta-host", createdAt: new Date().toISOString(), originSessionId: "session-host" });
			patchRunStatus(runDir, { runId, chartId: "postgres-meta-host", state: "stopped", branchIds: ["main"] });
			expect(existsSync(join(runDir, "meta.json"))).toBe(false);
			const snapshot = await createPiHyperchartHost({ agentDir }).readSessionSnapshot(workDir);
			expect(snapshot.runs).toEqual([expect.objectContaining({ runId, chartName: "postgres-meta-host", cwd: workDir, originSessionId: "session-host" })]);
		} finally {
			await deleteRunStorage(runDir).catch(() => {});
			await rm(root, { recursive: true, force: true });
		}
	});

	it("loads metadata without hydrating or validating the PostgreSQL journal", async () => {
		const runId = newRunId();
		const runDir = join(tmpdir(), runId);
		await mkdir(runDir, { recursive: true });
		const meta = { chartPath: join(runDir, "chart.ts"), workDir: runDir, chartId: "metadata-only", createdAt: new Date().toISOString() };
		try {
			await initializeRunDir(runDir);
			const writer = await openWriter(runId);
			await writer.appendDrafts([argsDraft()]);
			await writer.close();
			await saveRunMeta(runDir, meta);
			const { Client } = await import("pg");
			const client = new Client({ connectionString: dsn });
			await client.connect();
			await client.query(`DELETE FROM ${JOURNAL_TABLE} WHERE run_id = $1 AND seq = 1`, [runId]);
			await client.end();
			expect(await loadRunMeta(runDir)).toEqual(meta);
		} finally {
			await deleteRunStorage(runDir).catch(() => {});
			await rm(runDir, { recursive: true, force: true });
		}
	});

	it("rejects conflicting PostgreSQL metadata for the same run id", async () => {
		const runId = newRunId();
		const runDir = join(tmpdir(), runId);
		await mkdir(runDir, { recursive: true });
		const meta = { chartPath: join(runDir, "one.chart.ts"), workDir: runDir, chartId: "one", createdAt: new Date().toISOString() };
		try {
			await saveRunMeta(runDir, meta);
			await expect(saveRunMeta(runDir, { ...meta, chartId: "two" })).rejects.toThrow(/Conflicting metadata/);
		} finally {
			await rm(runDir, { recursive: true, force: true });
		}
	});

	it("rejects append before explicit root-branch initialization", async () => {
		const store = await openWriter(newRunId());
		await expect(store.appendDrafts([argsDraft()])).rejects.toThrow(/Unknown Hyperchart branch 'main'/);
	});

	it("atomically commits records as independent universal-sequence rows", async () => {
		const runId = newRunId();
		const store = await openWriter(runId);
		await store.initializeRootBranch();
		const records = await store.appendDrafts([argsDraft(), invokeDraft()]);

		expect((await store.getBranch("main")).headSeqId).toBe(3);
		expect((await journalStats(store, runId)).maxSeq + 1).toBe(4);
		expect(await store.readAncestry("main")).toEqual(records);
		const relational = await store.transaction((tx) => tx.query(
			`SELECT seq, kind, branch_id, parent_id, head_seq_id,
			        record_type, payload, metadata
			   FROM ${JOURNAL_TABLE}
			  WHERE run_id = $1
			  ORDER BY seq`,
			[runId],
		));
		expect(relational.rows).toEqual([
			{
				seq: "1", kind: "branch_create", branch_id: "main",
				parent_id: null, head_seq_id: null, record_type: null, payload: null,
				metadata: { name: "main" },
			},
			{
				seq: "2", kind: "record", branch_id: "main",
				parent_id: null, head_seq_id: null, record_type: "args",
				payload: { args: { topic: "test" }, timestamp: records[0]?.timestamp }, metadata: null,
			},
			{
				seq: "3", kind: "record", branch_id: "main",
				parent_id: "2", head_seq_id: null, record_type: "state_action",
				payload: expect.objectContaining({ kind: "invoke", sessionId: "session-id", timestamp: records[1]?.timestamp }), metadata: null,
			},
		]);
		const columns = await store.transaction((tx) => tx.query(
			`SELECT column_name FROM information_schema.columns
			  WHERE table_schema = 'public' AND table_name = $1
			  ORDER BY ordinal_position`,
			[JOURNAL_TABLE],
		));
		expect(columns.rows.map((row) => row.column_name)).toEqual([
			"run_id", "seq", "kind", "branch_id", "parent_id", "head_seq_id",
			"record_type", "payload", "metadata", "committed_at_ms",
		]);
	});

	it("opens and appends without selecting the whole journal", async () => {
		const runId = newRunId();
		const seed = await openWriter(runId);
		await seed.initializeRootBranch();
		for (let index = 0; index < 20; index++) await seed.appendDrafts([argsDraft({ index })]);
		await seed.close();

		const { Client } = await import("pg");
		const originalQuery = Client.prototype.query;
		const queries: string[] = [];
		vi.spyOn(Client.prototype, "query").mockImplementation(function (this: InstanceType<typeof Client>, ...args: unknown[]) {
			const query = args[0];
			queries.push(typeof query === "string" ? query : typeof query === "object" && query !== null && "text" in query ? String(query.text) : "");
			return Reflect.apply(originalQuery, this, args) as never;
		} as typeof originalQuery);

		const writer = await openWriter(runId);
		const [record] = await writer.appendDrafts([argsDraft({ final: true })]);
		expect(record?.seqId).toBe(22);
		const normalized = queries.map((query) => query.replace(/\s+/g, " ").trim().toLowerCase());
		expect(normalized.some((query) => query.includes("max(seq)"))).toBe(false);
		expect(normalized.some((query) => query.includes("update hyperchart_run_meta") && query.includes("returning next_seq - $2"))).toBe(true);
		expect(normalized.some((query) => query.includes("record_type, payload") && query.includes("order by seq"))).toBe(false);
	});

	it("reloads identical targeted views after reopening the run", async () => {
		const runId = newRunId();
		const writer = await openWriter(runId);
		await writer.initializeRootBranch();
		await writer.appendDrafts([argsDraft(), invokeDraft()]);
		await writer.createBranch("experiment", 2, { reason: "sibling", sourceBranchId: "main", sourceSeqId: 2 });
		const before = {
			branches: await writer.listBranches(),
			main: await writer.readAncestry("main"),
			experiment: await writer.readAncestry("experiment"),
			count: await writer.countRecords(),
		};
		await writer.close();

		const reopened = await openReader(runId);
		expect(await reopened.listBranches()).toEqual(before.branches);
		expect(await reopened.readAncestry("main")).toEqual(before.main);
		expect(await reopened.readAncestry("experiment")).toEqual(before.experiment);
		expect(await reopened.countRecords()).toBe(before.count);
		expect((await reopened.getBranch("experiment")).headSeqId).toBe(2);
	});

	it("shares one journal across branch handles", async () => {
		const store = await openWriter(newRunId());
		await store.initializeRootBranch();
		await store.appendDrafts([argsDraft()]);
		await store.createBranch("experiment", 2);

		const experiment = store.forBranch("experiment");
		const forked = await experiment.appendDrafts([invokeDraft()]);

		expect(forked[0]?.parentId).toBe(2);
		expect((await store.getBranch("experiment")).headSeqId).toBe(4);
		expect((await store.getBranch("main")).headSeqId).toBe(2);
		expect(await experiment.readAncestry("experiment")).toHaveLength(2);
	});

	it("moves a named head without deleting records", async () => {
		const runId = newRunId();
		const store = await openWriter(runId);
		await store.initializeRootBranch();
		await store.appendDrafts([argsDraft(), invokeDraft()]);
		await store.moveBranch("main", 2);

		expect((await store.getBranch("main")).headSeqId).toBe(2);
		expect(await store.countRecords()).toBe(2);
		expect((await journalStats(store, runId)).maxSeq + 1).toBe(5);
	});

	it("rejects a second live writer for the same run", async () => {
		const runId = newRunId();
		const first = await openWriter(runId);
		await first.initializeRootBranch();
		await expect(PostgresLogStore.open({ dsn: dsn as string, runId, access: "writer" })).rejects.toThrow(/Another live writer/);
	});

	it("rolls journal writes back with host-domain SQL failure", async () => {
		const store = await openWriter(newRunId());
		await store.initializeRootBranch();
		await expect(store.transaction(async (tx) => {
			await tx.appendDrafts("main", [argsDraft()]);
			await tx.query("SELECT * FROM hyperchart_table_that_does_not_exist");
		})).rejects.toBeDefined();
		expect(await store.countRecords()).toBe(0);
		const [record] = await store.appendDrafts([argsDraft()]);
		expect(record?.seqId).toBe(2);
	});

	it("atomically commits a fork, response, and participating SQL", async () => {
		const runId = newRunId();
		const store = await openWriter(runId);
		await store.initializeRootBranch();
		await ensureClaimTable(store);
		const ast = userAst();
		const gateSeqId = await appendOpenGate(store, ast);

		const committed = await store.forkAndCommitUserInteraction({
			sourceBranchId: "main",
			newBranchId: "experiment",
			fromSeqId: gateSeqId,
			responseBranchId: "experiment",
			metadata: { name: "experiment", sourceBranchId: "main", sourceSeqId: gateSeqId },
			response: { ast, gateSeqId, event: { type: "SELECTED" } },
		}, async (tx) => {
			await tx.query("INSERT INTO hyperchart_test_claims (run_id, candidate, branch_id) VALUES ($1, $2, $3)", [runId, 1, "experiment"]);
			return "claimed";
		});

		expect(committed.participant).toBe("claimed");
		expect(committed.response.idempotent).toBe(false);
		expect((await store.getBranch("experiment")).headSeqId).toBe(committed.response.record.seqId);
		expect((await store.readAncestry("experiment")).at(-1)).toEqual(committed.response.record);
		expect(await store.findUserInteractionResponse({ headSeqId: committed.response.record.seqId, gateSeqId })).toEqual(committed.response.record);
		const claims = await store.transaction((tx) => tx.query("SELECT branch_id FROM hyperchart_test_claims WHERE run_id = $1 AND candidate = 1", [runId]));
		expect(claims.rows).toEqual([{ branch_id: "experiment" }]);

		const retried = await store.forkAndCommitUserInteraction({
			sourceBranchId: "main",
			newBranchId: "experiment",
			fromSeqId: gateSeqId,
			responseBranchId: "experiment",
			metadata: { name: "experiment", sourceBranchId: "main", sourceSeqId: gateSeqId },
			response: { ast, gateSeqId, event: { type: "SELECTED" } },
		}, async (tx) => {
			await tx.query("INSERT INTO hyperchart_test_claims (run_id, candidate, branch_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [runId, 1, "experiment"]);
			return "existing";
		});
		expect(retried.response.idempotent).toBe(true);
		expect(retried.branch.branchId).toBe("experiment");
	});

	it("forks atomically from a historical gate after the source branch advances", async () => {
		const runId = newRunId();
		const store = await openWriter(runId);
		await store.initializeRootBranch();
		await ensureClaimTable(store);
		const ast = userAst();
		const gateSeqId = await appendOpenGate(store, ast);
		await store.respondToUserInteraction({ ast, gateSeqId, event: { type: "SELECTED" } });
		expect((await store.getBranch("main")).headSeqId).not.toBe(gateSeqId);

		const committed = await store.forkAndCommitUserInteraction({
			sourceBranchId: "main",
			newBranchId: "historical-fork",
			fromSeqId: gateSeqId,
			responseBranchId: "historical-fork",
			response: { ast, gateSeqId, event: { type: "SELECTED" } },
		}, (tx) => tx.query(
			"INSERT INTO hyperchart_test_claims (run_id, candidate, branch_id) VALUES ($1, $2, $3)",
			[runId, 9, "historical-fork"],
		));

		expect(committed.branch.branchId).toBe("historical-fork");
		expect((await store.readAncestry("historical-fork")).at(-1)).toEqual(committed.response.record);
	});

	it("rejects a fork point outside the selected source ancestry", async () => {
		const store = await openWriter(newRunId());
		await store.initializeRootBranch();
		const ast = userAst();
		const gateSeqId = await appendOpenGate(store, ast);
		await expect(store.forkAndCommitUserInteraction({
			sourceBranchId: "main",
			newBranchId: "invalid-fork",
			fromSeqId: gateSeqId + 1000,
			responseBranchId: "invalid-fork",
			response: { ast, gateSeqId, event: { type: "SELECTED" } },
		}, async () => undefined)).rejects.toThrow(/not in source branch 'main' ancestry/);
	});

	it("rolls back fork and response when participating SQL fails", async () => {
		const runId = newRunId();
		const store = await openWriter(runId);
		await store.initializeRootBranch();
		await ensureClaimTable(store);
		const ast = userAst();
		const gateSeqId = await appendOpenGate(store, ast);
		const before = (await journalStats(store, runId)).count;

		await expect(store.forkAndCommitUserInteraction({
			sourceBranchId: "main",
			newBranchId: "rolled-back",
			fromSeqId: gateSeqId,
			responseBranchId: "rolled-back",
			response: { ast, gateSeqId, event: { type: "SELECTED" } },
		}, async (tx) => {
			await tx.query("INSERT INTO hyperchart_test_claims (run_id, candidate, branch_id) VALUES ($1, $2, $3)", [runId, 2, "rolled-back"]);
			throw new Error("participant failed");
		})).rejects.toThrow("participant failed");

		expect((await store.listBranches()).items.some((branch) => branch.branchId === "rolled-back")).toBe(false);
		expect((await journalStats(store, runId)).count).toBe(before);
		const claims = await store.transaction((tx) => tx.query("SELECT branch_id FROM hyperchart_test_claims WHERE run_id = $1 AND candidate = 2", [runId]));
		expect(claims.rows).toEqual([]);
	});

	it("preserves host uniqueness errors and rolls back their fork", async () => {
		const runId = newRunId();
		const store = await openWriter(runId);
		await store.initializeRootBranch();
		await ensureClaimTable(store);
		const ast = userAst();
		const gateSeqId = await appendOpenGate(store, ast);
		await store.transaction((tx) => tx.query("INSERT INTO hyperchart_test_claims (run_id, candidate, branch_id) VALUES ($1, $2, $3)", [runId, 3, "winner"]));

		let failure: unknown;
		try {
			await store.forkAndCommitUserInteraction({
				sourceBranchId: "main",
				newBranchId: "loser",
				fromSeqId: gateSeqId,
				responseBranchId: "loser",
				response: { ast, gateSeqId, event: { type: "SELECTED" } },
			}, (tx) => tx.query("INSERT INTO hyperchart_test_claims (run_id, candidate, branch_id) VALUES ($1, $2, $3)", [runId, 3, "loser"]));
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({ code: "23505", constraint: "hyperchart_test_claims_pkey" });
		expect(String(failure)).not.toContain("Stale Hyperchart journal writer");
		expect((await store.listBranches()).items.some((branch) => branch.branchId === "loser")).toBe(false);
	});

	it("rejects a composite response branch unrelated to source or new fork", async () => {
		const store = await openWriter(newRunId());
		await store.initializeRootBranch();
		await expect(store.forkAndCommitUserInteraction({
			sourceBranchId: "main", newBranchId: "experiment", fromSeqId: 1, responseBranchId: "unrelated",
			response: { ast: {} as never, gateSeqId: 1, event: { type: "OK" } },
		}, async () => undefined)).rejects.toThrow(/source branch or the newly created branch/);
	});

	it("rejects writes through a read-only handle", async () => {
		const runId = newRunId();
		const writer = await openWriter(runId);
		await writer.initializeRootBranch();
		await writer.close();

		const reader = await openReader(runId);
		await expect(reader.appendDrafts([argsDraft()])).rejects.toThrow(/opened read-only/);
	});

	it("treats a missing journal as an empty read-only run", async () => {
		const reader = await openReader(newRunId());
		expect(await reader.listBranches()).toEqual({ items: [], totalCount: 0 });
		expect(await reader.countRecords()).toBe(0);
	});

	it("trusts targeted reads without globally validating the journal", async () => {
		const runId = newRunId();
		const writer = await openWriter(runId);
		await writer.initializeRootBranch();
		await writer.appendDrafts([argsDraft(), invokeDraft()]);
		await writer.close();

		const { Client } = await import("pg");
		const client = new Client({ connectionString: dsn });
		await client.connect();
		// Drop the branch-create entry so the surviving record appends to an unknown branch.
		await client.query(`DELETE FROM ${JOURNAL_TABLE} WHERE run_id = $1 AND seq = 1`, [runId]);
		await client.end();

		const reader = await openReader(runId);
		expect(await reader.getRecord(2)).toMatchObject({ seqId: 2, type: "args" });
	});

	it("serves snapshot-pinned older/newer history chunks and deep-link cursors", async () => {
		const store = await openWriter(newRunId());
		await store.initializeRootBranch();
		const records = await store.appendDrafts(Array.from({ length: 230 }, () => invokeDraft()));
		const snapshot = await store.captureSnapshot("main");
		const first = await store.readStateVisits({ snapshot, state: "work" });
		expect(first.items).toHaveLength(HISTORY_READ_ITEMS);
		expect(first.items.map((item) => item.seqId)).toEqual(records.slice(-100).reverse().map((record) => record.seqId));
		const second = await store.readStateVisits({ snapshot, state: "work", cursor: first.older! });
		expect(second.items).toHaveLength(100); expect(second.newer).toBeTypeOf("string");
		expect((await store.readStateVisits({ snapshot, state: "work", cursor: second.newer! })).items.map((item) => item.seqId)).toEqual(first.items.map((item) => item.seqId));
		const target = records[109]!.seqId;
		const cursor = await store.cursorAt({ snapshot, subject: { kind: "state-visits", state: "work" }, seqId: target });
		expect((await store.readStateVisits({ snapshot, state: "work", cursor: cursor! })).items[0]?.seqId).toBe(target);
		await expect(store.readRecords({ snapshot, cursor: cursor! })).rejects.toBeInstanceOf(HistoryCursorError);
		await store.appendDrafts([invokeDraft()]);
		expect((await store.readStateVisits({ snapshot, state: "work" })).items.map((item) => item.seqId)).toEqual(first.items.map((item) => item.seqId));
		await expect(store.readStateVisits({ snapshot: await store.captureSnapshot("main"), state: "work", cursor: cursor! })).rejects.toBeInstanceOf(HistoryCursorError);
	});

	it("paginates branch heads by creation coordinate under read committed semantics", async () => {
		const store = await openWriter(newRunId());
		await store.initializeRootBranch();
		const [root] = await store.appendDrafts([argsDraft()]);
		for (let index = 0; index < 105; index++) await store.createBranch(`branch-${index.toString().padStart(3, "0")}`, root!.seqId);
		const first = await store.listBranches();
		expect(first.items).toHaveLength(100); expect(first.totalCount).toBe(106); expect(first.next).toBeTypeOf("string");
		await store.createBranch("late-branch", root!.seqId);
		const second = await store.listBranches(first.next);
		expect(second.items).toHaveLength(7); expect(second.totalCount).toBe(107); expect(second.next).toBeUndefined();
		expect(new Set([...first.items, ...second.items].map((branch) => branch.branchId)).size).toBe(107);
	});

	it("streams private projection replay oldest-first with 500-record batches", async () => {
		const store = await openWriter(newRunId());
		await store.initializeRootBranch();
		const records = await store.appendDrafts(Array.from({ length: 1_201 }, () => invokeDraft()));
		const batches: number[][] = [];
		for await (const batch of openProjectionReplay(store, { targetHeadSeqId: records.at(-1)!.seqId, afterSeqId: null })) batches.push(batch.map((record) => record.seqId));
		expect(batches.map((batch) => batch.length)).toEqual([500, 500, 201]);
		expect(batches.flat()).toEqual(records.map((record) => record.seqId));
	});

	it("keeps arbitrary-parent divergent snapshots independent", async () => {
		const store = await openWriter(newRunId());
		await store.initializeRootBranch();
		const [root] = await store.appendDrafts([argsDraft()]);
		await store.createBranch("experiment", root!.seqId);
		const main = await store.appendDrafts(Array.from({ length: 120 }, () => invokeDraft()));
		const experiment = await store.forBranch("experiment").appendDrafts(Array.from({ length: 120 }, () => invokeDraft()));
		const mainSnapshot = await store.captureSnapshot("main");
		const experimentSnapshot = await store.captureSnapshot("experiment");
		await store.moveBranch("main", root!.seqId);
		expect((await store.readStateVisits({ snapshot: mainSnapshot, state: "work" })).items.map((item) => item.seqId)).toEqual(main.slice(-100).reverse().map((record) => record.seqId));
		expect((await store.readStateVisits({ snapshot: experimentSnapshot, state: "work" })).items.map((item) => item.seqId)).toEqual(experiment.slice(-100).reverse().map((record) => record.seqId));
		expect(await store.containsInHistory({ headSeqId: mainSnapshot.headSeqId, seqId: experiment[0]!.seqId })).toBe(false);
	});

	it("publishes the existing PostgreSQL commit notification without using it as a runtime subscription", async () => {
		const runId = newRunId();
		const { Client } = await import("pg");
		const listener = new Client({ connectionString: dsn });
		await listener.connect();
		const received: string[] = [];
		listener.on("notification", (message: { channel: string; payload?: string | undefined }) => {
			if (message.channel === JOURNAL_CHANNEL && message.payload?.startsWith(`${runId}:`)) received.push(message.payload);
		});
		await listener.query(`LISTEN ${JOURNAL_CHANNEL}`);
		const writer = await openWriter(runId);
		await writer.initializeRootBranch();
		await writer.appendDrafts([argsDraft()]);
		await new Promise((resolve) => setTimeout(resolve, 250));
		await listener.end();
		expect(received).toEqual([`${runId}:1`, `${runId}:2`]);
	});
});
