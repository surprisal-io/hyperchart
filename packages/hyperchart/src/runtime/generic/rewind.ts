import { basename } from "node:path";
import { actorPoolWorkerOccurrencePath } from "../../core/actors.js";
import type { BranchId, DurableLogRecord } from "../../core/durable_events.js";
import { parseChartModuleSync } from "../../core/inspect.js";
import { templatePath } from "../../core/paths.js";
import { explainReplay } from "../../core/replay_check.js";
import type { ChartAst, StatePath } from "../../core/types.js";
import { assertRunOwnership, assertStoppedRun } from "./branches.js";
import type { NormalizedRunLog } from "./log_store.js";
import { openRunLogStore } from "./log_store_factory.js";
import { loadRunMeta } from "./run_dir.js";
import { patchRunStatus } from "./run_status.js";

export type RewindMode = "before" | "after";

export type RewindOptions = {
	runDir: string;
	branchId: BranchId;
	state?: string;
	seqId?: number;
	to?: "compatible";
	mode: RewindMode;
	/** Working directory the run must belong to; rewinding a foreign run is refused. */
	cwd: string;
};

export type RewindResult = {
	runId: string;
	runDir: string;
	chartId: string;
	branchId: BranchId;
	targetLabel: string;
	previousHeadSeqId: number | null;
	headSeqId: number | null;
	/** Every machine record and downstream file remains in place. */
	preservedRecords: number;
};

type RewindMatch = {
	index: number;
	label: string;
	recordSeqId: number;
	targetHeadSeqId: number | null;
};

/**
 * Move one durable named head. This operation is append-only: it never rewrites
 * log.jsonl and never moves/deletes sessions, gates, notifications, or artifacts.
 */
export async function rewindHyperchartRun(opts: RewindOptions): Promise<RewindResult> {
	const targetCount = [opts.state, opts.seqId, opts.to].filter((target) => target !== undefined).length;
	if (targetCount !== 1) throw new Error("rewind requires exactly one of state, seqId, or to=compatible");
	assertStoppedRun(opts.runDir, "rewinding");
	await assertRunOwnership(opts.runDir, opts.cwd);
	const meta = await loadRunMeta(opts.runDir);
	const parsed = parseChartModuleSync(meta.chartPath, meta.exportName === undefined ? {} : { exportName: meta.exportName });
	if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));

	const store = await openRunLogStore(opts.runDir, { branchId: opts.branchId, access: "writer" });
	let match: RewindMatch;
	let previousHeadSeqId: number | null;
	let preservedRecords: number;
	try {
		const normalized = await store.read();
		const previous = normalized.branch(opts.branchId);
		match = findRewindMatch(normalized, opts, parsed.ast);
		if (match.targetHeadSeqId === previous.headSeqId) {
			throw new Error(`Rewind would not move branch '${opts.branchId}'; choose a different target`);
		}
		await store.moveBranch(opts.branchId, match.targetHeadSeqId);
		previousHeadSeqId = previous.headSeqId;
		preservedRecords = normalized.records.length;
	} finally {
		await store.close();
	}
	patchRunStatus(opts.runDir, {
		runId: basename(opts.runDir),
		chartId: parsed.ast.id,
		branchIds: [opts.branchId],
		state: "stopped",
		pid: undefined,
		heartbeatAt: undefined,
		exitCode: 0,
		error: undefined,
	});
	return {
		runId: basename(opts.runDir),
		runDir: opts.runDir,
		chartId: parsed.ast.id,
		branchId: opts.branchId,
		targetLabel: match.label,
		previousHeadSeqId,
		headSeqId: match.targetHeadSeqId,
		preservedRecords,
	};
}

/** Resolve a selector once against normalized storage. Explicit seqId may target a sibling tip. */
export function findRewindMatch(
	normalized: NormalizedRunLog,
	opts: Pick<RewindOptions, "branchId" | "state" | "seqId" | "to" | "mode">,
	ast: ChartAst,
): RewindMatch {
	const ancestry = normalized.ancestry(opts.branchId);
	if (opts.to === "compatible") {
		const explanation = explainReplay(ast, ancestry);
		const broken = explanation.broken;
		if (broken === undefined) {
			const warnings = explanation.skipped.length + explanation.stale.length;
			throw new Error(warnings === 0
				? "Selected branch ancestry is already compatible with the current chart; no rewind needed"
				: `Selected branch ancestry has no structural incompatibility (${warnings} warning record(s)); choose state or seqId to move it`);
		}
		const targetSeqId = broken.record.type === "state_action" ? (broken.invokeSeqId ?? broken.seqId) : broken.seqId;
		const index = ancestry.findIndex((record) => record.seqId === targetSeqId);
		if (index === -1) throw new Error(`Cannot find compatible target seqId ${targetSeqId} in branch '${opts.branchId}'`);
		const target = ancestry[index];
		if (target === undefined) throw new Error(`Cannot find compatible target seqId ${targetSeqId}`);
		return {
			index,
			label: `compatible before seqId ${targetSeqId}`,
			recordSeqId: targetSeqId,
			targetHeadSeqId: target.parentId,
		};
	}
	if (opts.seqId !== undefined) {
		const record = normalized.recordsBySeqId.get(opts.seqId);
		if (record === undefined) throw new Error(`No durable log record with seqId ${opts.seqId}`);
		const index = ancestry.findIndex((candidate) => candidate.seqId === opts.seqId);
		return {
			index,
			label: `${opts.mode} seqId ${opts.seqId}`,
			recordSeqId: opts.seqId,
			targetHeadSeqId: opts.mode === "before" ? record.parentId : record.seqId,
		};
	}
	const state = opts.state ?? "";
	const index = ancestry.findIndex((record, recordIndex) => recordMatchesState(ancestry, recordIndex, state));
	if (index === -1) throw new Error(`No durable log record matched state '${state}' in branch '${opts.branchId}'`);
	const record = ancestry[index];
	if (record === undefined) throw new Error(`No durable log record matched state '${state}'`);
	return {
		index,
		label: `${opts.mode} state ${state}`,
		recordSeqId: record.seqId,
		targetHeadSeqId: opts.mode === "before" ? record.parentId : record.seqId,
	};
}

export function semanticStatesForRecord(
	record: DurableLogRecord,
	records: readonly DurableLogRecord[],
	recordIndex: number,
): StatePath[] {
	if (record.type === "spawned") return [record.path];
	if (record.type === "state_action") return [record.actionUid.state];
	if (record.type === "failure_intent") return [record.origin];
	if (record.type === "actor_created") return [record.declaration, record.occurrence];
	if (record.type === "actor_messages_enqueued") return [record.source.producerState, record.occurrence];
	if (record.type === "actor_message") {
		if (record.workerIndex === undefined) return [record.occurrence];
		const workerOccurrence = actorPoolWorkerOccurrencePath(record.occurrence, record.workerIndex);
		let accepted: Extract<DurableLogRecord, { type: "actor_message"; kind: "accepted" }> | undefined;
		if (record.kind === "accepted") accepted = record;
		else {
			for (let index = recordIndex - 1; index >= 0; index--) {
				const candidate = records[index];
				if (candidate?.type === "actor_message" && candidate.kind === "accepted" && candidate.occurrence === record.occurrence && candidate.messageId === record.messageId && candidate.workerIndex === record.workerIndex) {
					accepted = candidate;
					break;
				}
			}
		}
		return accepted === undefined ? [record.occurrence, workerOccurrence] : [record.occurrence, workerOccurrence, accepted.receiveState];
	}
	if (record.type === "actor_scope") return [record.occurrence];
	if (record.type === "actor_call_resolved" || record.type === "actor_batch_call_resolved") return [record.callerState];
	return ["<run>"];
}

function recordMatchesState(records: readonly DurableLogRecord[], recordIndex: number, state: string): boolean {
	const record = records[recordIndex];
	return record !== undefined && semanticStatesForRecord(record, records, recordIndex)
		.some((path) => path === state || templatePath(path) === state || isUnderState(path, state));
}

function isUnderState(path: string, state: string): boolean {
	return path === state || path.startsWith(`${state}.`) || path.startsWith(`${state}#`) || templatePath(path).startsWith(`${state}.`);
}
