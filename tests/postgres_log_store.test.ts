import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { DurableRecordDraft } from "../packages/hyperchart/src/index.js";
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
	return { type: "state_action", kind: "invoke", actionUid, definition: { kind: "agent", uid: actionUid, name: "worker" } };
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

	it("refuses a second live writer for the same run", async () => {
		const runId = newRunId();
		const first = await openWriter(runId);
		await first.initializeRootBranch();

		await expect(PostgresLogStore.open({ dsn: dsn as string, runId, access: "writer" })).rejects.toThrow(
			/Another live writer holds Hyperchart run/,
		);
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

	it("notifies listeners on every committed mutation", async () => {
		const runId = newRunId();
		const { Client } = await import("pg");
		const listener = new Client({ connectionString: dsn });
		await listener.connect();
		const received: string[] = [];
		listener.on("notification", (message: { channel: string; payload?: string | undefined }) => {
			if (message.channel === JOURNAL_CHANNEL && message.payload?.startsWith(`${runId}:`)) {
				received.push(message.payload);
			}
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
