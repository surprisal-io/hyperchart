import { basename, resolve } from "node:path";
import type { BranchId } from "../../core/durable_events.js";
import { DEFAULT_BRANCH_ID, JsonlLogStore, type RunLogStore } from "./log_store.js";
import { PostgresLogStore, type PostgresLogAccess } from "./postgres_log_store.js";

export type OpenRunLogStoreOptions = Readonly<{
	branchId?: BranchId;
	onWarn?: (message: string) => void;
	/** Writers take the run's exclusive claim; read-only opens never do. Defaults to "read". */
	access?: PostgresLogAccess;
}>;

/**
 * Open the durable journal for one run directory. The backend is selected by
 * HYPERCHART_PG_DSN: when set, the journal lives in Postgres keyed by the run
 * directory's basename; otherwise it is the run-local log.jsonl file. The store
 * is returned already opened so corrupt journals fail here for both backends.
 */
export async function openRunLogStore(runDir: string, options: OpenRunLogStoreOptions = {}): Promise<RunLogStore> {
	const branchId = options.branchId ?? DEFAULT_BRANCH_ID;
	const onWarn = options.onWarn ?? (() => {});
	const dsn = process.env.HYPERCHART_PG_DSN;
	if (dsn !== undefined && dsn.length > 0) {
		return PostgresLogStore.open({
			dsn,
			runId: basename(resolve(runDir)),
			branchId,
			onWarn,
			access: options.access ?? "read",
		});
	}
	const store = new JsonlLogStore(resolve(runDir, "log.jsonl"), onWarn, branchId);
	await store.read();
	return store;
}
