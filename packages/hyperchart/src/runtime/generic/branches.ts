import { basename, resolve } from "node:path";
import type { BranchHead, BranchId, BranchMetadata } from "../../core/durable_events.js";
import { loadRunMeta } from "./run_dir.js";
import { isRunLive, readRunStatus } from "./run_status.js";
import { openRunLogStore } from "./log_store_factory.js";
import { collectBranches } from "./log_store.js";

export type ForkBranchOptions = Readonly<{
	runDir: string;
	fromSeqId: number;
	branchId: BranchId;
	reason?: string;
	/** Optional ownership boundary used by host tools. */
	cwd?: string;
	sourceBranchId?: BranchId;
}>;

export type ForkBranchResult = Readonly<{
	runId: string;
	runDir: string;
	branch: BranchHead;
	/** Fork never changes a caller/UI selection. */
	selectedBranchChanged: false;
	started: false;
}>;

export async function listHyperchartBranches(runDir: string): Promise<readonly BranchHead[]> {
	const store = await openRunLogStore(runDir);
	try {
		return [...await collectBranches(store)].sort((left, right) => left.createdAt - right.createdAt || left.branchId.localeCompare(right.branchId));
	} finally {
		await store.close();
	}
}

export async function getHyperchartBranch(runDir: string, branchId: BranchId): Promise<BranchHead> {
	const store = await openRunLogStore(runDir);
	try {
		return store.getBranch(branchId);
	} finally {
		await store.close();
	}
}

/** Create a durable named pointer without selecting it and without starting a runner. */
export async function forkHyperchartRun(options: ForkBranchOptions): Promise<ForkBranchResult> {
	assertStoppedRun(options.runDir, "forking");
	await assertRunOwnership(options.runDir, options.cwd);
	const store = await openRunLogStore(options.runDir, { access: "writer" });
	let branch: BranchHead;
	try {
		if (await store.getRecord(options.fromSeqId) === undefined) {
			throw new Error(`No durable log record with seqId ${options.fromSeqId}`);
		}
		if ((await collectBranches(store)).some((candidate) => candidate.branchId === options.branchId)) {
			throw new Error(`Hyperchart branch '${options.branchId}' already exists`);
		}
		if (options.sourceBranchId !== undefined) await store.getBranch(options.sourceBranchId);
		const metadata: BranchMetadata = {
			name: options.branchId,
			...(options.reason === undefined ? {} : { reason: options.reason }),
			...(options.sourceBranchId === undefined ? {} : { sourceBranchId: options.sourceBranchId }),
			sourceSeqId: options.fromSeqId,
		};
		branch = await store.createBranch(options.branchId, options.fromSeqId, metadata);
	} finally {
		await store.close();
	}
	return {
		runId: basename(options.runDir),
		runDir: options.runDir,
		branch,
		selectedBranchChanged: false,
		started: false,
	};
}

export function assertStoppedRun(runDir: string, operation: string): void {
	const status = readRunStatus(runDir);
	if (isRunLive(status)) throw new Error(`Run '${basename(runDir)}' is live; stop it before ${operation}`);
}

export async function assertRunOwnership(runDir: string, cwd: string | undefined): Promise<void> {
	if (cwd === undefined) return;
	const meta = await loadRunMeta(runDir);
	if (resolve(meta.workDir) !== resolve(cwd)) {
		throw new Error(`Run '${basename(runDir)}' belongs to ${meta.workDir}; open that directory first`);
	}
}
