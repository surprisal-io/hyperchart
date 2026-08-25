import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { normalizeChartConfig, type ChartAst, type ChartCst, type DurableRecordDraft } from "../packages/hyperchart/src/index.js";
import { chart, final, user } from "../packages/hyperchart/src/core/dsl.js";
import { CorruptRunLogError } from "../packages/hyperchart/src/runtime/generic/log_store.js";
import {
	JOURNAL_CHANNEL,
	JOURNAL_TABLE,
	PostgresLogStore,
} from "../packages/hyperchart/src/runtime/generic/postgres_log_store.js";

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
	await Promise.all(openStores.splice(0).map((store) => store.close().catch(() => {})));
});

afterAll(async () => {
	if (dsn === undefined || usedRunIds.length === 0) return;
	const { Client } = await import("pg");
	const client = new Client({ connectionString: dsn });
	await client.connect();
	await client.query(`DELETE FROM ${JOURNAL_TABLE} WHERE run_id = ANY($1)`, [usedRunIds]).catch(() => {});
	await client.query("DELETE FROM hyperchart_test_claims WHERE run_id = ANY($1)", [usedRunIds]).catch(() => {});
	await client.end();
});

describePg("PostgresLogStore", () => {
	it("rejects append before explicit root-branch initialization", async () => {
		const store = await openWriter(newRunId());
		await expect(store.appendDrafts([argsDraft()])).rejects.toThrow(/Unknown Hyperchart branch 'main'/);
	});

	it("atomically commits a stamped record batch with its head", async () => {
		const store = await openWriter(newRunId());
		await store.initializeRootBranch();
		const records = await store.appendDrafts([argsDraft(), invokeDraft()]);
		const normalized = await store.read();

		expect(normalized.branch("main").headSeqId).toBe(2);
		expect(normalized.nextSeqId).toBe(3);
		expect(normalized.ancestry("main")).toEqual(records);
	});

	it("reloads an identical journal after reopening the run", async () => {
		const runId = newRunId();
		const writer = await openWriter(runId);
		await writer.initializeRootBranch();
		await writer.appendDrafts([argsDraft(), invokeDraft()]);
		await writer.createBranch("experiment", 1, { reason: "sibling", sourceBranchId: "main", sourceSeqId: 1 });
		const before = await writer.read();
		await writer.close();

		const reopened = await openReader(runId);
		const after = await reopened.read();

		expect(after.mutations).toEqual(before.mutations);
		expect(after.records).toEqual(before.records);
		expect(after.nextSeqId).toBe(before.nextSeqId);
		expect(after.branch("experiment").headSeqId).toBe(1);
	});

	it("shares one journal across branch handles", async () => {
		const store = await openWriter(newRunId());
		await store.initializeRootBranch();
		await store.appendDrafts([argsDraft()]);
		await store.createBranch("experiment", 1);

		const experiment = store.forBranch("experiment");
		const forked = await experiment.appendDrafts([invokeDraft()]);

		expect(forked[0]?.parentId).toBe(1);
		expect(store.snapshot().branch("experiment").headSeqId).toBe(2);
		expect(store.snapshot().branch("main").headSeqId).toBe(1);
		expect(await experiment.readAll()).toHaveLength(2);
	});

	it("moves a named head without deleting records", async () => {
		const store = await openWriter(newRunId());
		await store.initializeRootBranch();
		await store.appendDrafts([argsDraft(), invokeDraft()]);
		await store.moveBranch("main", 1);

		const normalized = await store.read();
		expect(normalized.branch("main").headSeqId).toBe(1);
		expect(normalized.records).toHaveLength(2);
		expect(normalized.nextSeqId).toBe(3);
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
		expect((await store.read()).records).toHaveLength(0);
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
		expect(store.snapshot().branch("experiment").headSeqId).toBe(committed.response.record.seqId);
		expect(store.snapshot().ancestry("experiment").at(-1)).toEqual(committed.response.record);
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
		expect(store.snapshot().branch("main").headSeqId).not.toBe(gateSeqId);

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
		expect(store.snapshot().ancestry("historical-fork").at(-1)).toEqual(committed.response.record);
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
		const before = store.snapshot().mutations.length;

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

		expect(store.snapshot().branches.has("rolled-back")).toBe(false);
		expect(store.snapshot().mutations).toHaveLength(before);
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
		expect(store.snapshot().branches.has("loser")).toBe(false);
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
		const normalized = await reader.read();
		expect(normalized.mutations).toHaveLength(0);
	});

	it("rejects a corrupt journal with a seq gap on load", async () => {
		const runId = newRunId();
		const writer = await openWriter(runId);
		await writer.initializeRootBranch();
		await writer.appendDrafts([argsDraft(), invokeDraft()]);
		await writer.close();

		const { Client } = await import("pg");
		const client = new Client({ connectionString: dsn });
		await client.connect();
		// Drop the branch-create mutation so the surviving record batch appends to an unknown branch.
		await client.query(`DELETE FROM ${JOURNAL_TABLE} WHERE run_id = $1 AND seq = 1`, [runId]);
		await client.end();

		await expect(PostgresLogStore.open({ dsn: dsn as string, runId })).rejects.toThrow(CorruptRunLogError);
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
