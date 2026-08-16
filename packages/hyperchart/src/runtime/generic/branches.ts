import { basename, resolve } from "node:path";
import type { BranchHead, BranchId, BranchMetadata } from "../../core/durable_events.js";
import { loadRunMeta } from "./run_dir.js";
import { isRunLive, readRunStatus } from "./run_status.js";
import { JsonlLogStore, type NormalizedRunLog } from "./log_store.js";

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
	const normalized = await new JsonlLogStore(resolve(runDir, "log.jsonl")).read();
	return [...normalized.branches.values()].sort((left, right) => left.createdAt - right.createdAt || left.branchId.localeCompare(right.branchId));
}

export async function getHyperchartBranch(runDir: string, branchId: BranchId): Promise<BranchHead> {
	const normalized = await new JsonlLogStore(resolve(runDir, "log.jsonl")).read();
	return normalized.branch(branchId);
}

/** Create a durable named pointer without selecting it and without starting a runner. */
export async function forkHyperchartRun(options: ForkBranchOptions): Promise<ForkBranchResult> {
	assertStoppedRun(options.runDir, "forking");
	assertRunOwnership(options.runDir, options.cwd);
	const store = new JsonlLogStore(resolve(options.runDir, "log.jsonl"));
	const normalized = await store.read();
	if (!normalized.recordsBySeqId.has(options.fromSeqId)) {
		throw new Error(`No durable log record with seqId ${options.fromSeqId}`);
	}
	if (normalized.branches.has(options.branchId)) {
		throw new Error(`Hyperchart branch '${options.branchId}' already exists`);
	}
	if (options.sourceBranchId !== undefined) normalized.branch(options.sourceBranchId);
	const metadata: BranchMetadata = {
		name: options.branchId,
		...(options.reason === undefined ? {} : { reason: options.reason }),
		...(options.sourceBranchId === undefined ? {} : { sourceBranchId: options.sourceBranchId }),
		sourceSeqId: options.fromSeqId,
	};
	const branch = store.createBranch(options.branchId, options.fromSeqId, metadata);
	return {
		runId: basename(options.runDir),
		runDir: options.runDir,
		branch,
		selectedBranchChanged: false,
		started: false,
	};
}

export function branchContainsSeqId(normalized: NormalizedRunLog, branchId: BranchId, seqId: number): boolean {
	return normalized.ancestry(branchId).some((record) => record.seqId === seqId);
}

export function assertStoppedRun(runDir: string, operation: string): void {
	const status = readRunStatus(runDir);
	if (isRunLive(status)) throw new Error(`Run '${basename(runDir)}' is live; stop it before ${operation}`);
}

export function assertRunOwnership(runDir: string, cwd: string | undefined): void {
	if (cwd === undefined) return;
	const meta = loadRunMeta(runDir);
	if (resolve(meta.workDir) !== resolve(cwd)) {
		throw new Error(`Run '${basename(runDir)}' belongs to ${meta.workDir}; open that directory first`);
	}
}
