import { actorPoolWorkerOccurrencePath } from "../core/actors.js";
import type { BranchId, DurableLogRecord } from "../core/durable_events.js";
import { templatePath } from "../core/paths.js";
import { explainReplay } from "../core/replay_check.js";
import type { ChartAst, StatePath } from "../core/types.js";
import { openExecutionReplay, type RunHistoryStore } from "../runtime/generic/log_store.js";

export type RewindSelector = Readonly<{ branchId: BranchId; state?: string; seqId?: number; to?: "compatible"; mode: "before" | "after" }>;
export type RewindMatch = { index: number; label: string; recordSeqId: number; targetHeadSeqId: number | null };

export async function findRewindMatch(reader: RunHistoryStore, opts: RewindSelector, ast: ChartAst): Promise<RewindMatch> {
	const snapshot = await reader.captureSnapshot(opts.branchId);
	if (opts.seqId !== undefined) {
		const record = await reader.getRecord(opts.seqId);
		if (record === undefined) throw new Error(`No durable log record with seqId ${opts.seqId}`);
		return { index: -1, label: `${opts.mode} seqId ${opts.seqId}`, recordSeqId: opts.seqId, targetHeadSeqId: opts.mode === "before" ? record.parentId : record.seqId };
	}
	const ancestry: DurableLogRecord[] = [];
	for await (const batch of openExecutionReplay(reader, { targetHeadSeqId: snapshot.headSeqId, afterSeqId: null })) ancestry.push(...batch);
	if (opts.to === "compatible") {
		const explanation = explainReplay(ast, ancestry);
		const broken = explanation.broken;
		if (broken === undefined) {
			const warnings = explanation.skipped.length + explanation.stale.length;
			throw new Error(warnings === 0 ? "Selected branch ancestry is already compatible with the current chart; no rewind needed" : `Selected branch ancestry has no structural incompatibility (${warnings} warning record(s)); choose state or seqId to move it`);
		}
		const targetSeqId = broken.record.type === "state_action" ? (broken.invokeSeqId ?? broken.seqId) : broken.seqId;
		const index = ancestry.findIndex((record) => record.seqId === targetSeqId);
		const target = ancestry[index];
		if (target === undefined) throw new Error(`Cannot find compatible target seqId ${targetSeqId} in branch '${opts.branchId}'`);
		return { index, label: `compatible before seqId ${targetSeqId}`, recordSeqId: targetSeqId, targetHeadSeqId: target.parentId };
	}
	const state = opts.state ?? "";
	const index = ancestry.findIndex((record, recordIndex) => recordMatchesState(ancestry, recordIndex, state));
	const record = ancestry[index];
	if (record === undefined) throw new Error(`No durable log record matched state '${state}' in branch '${opts.branchId}'`);
	return { index, label: `${opts.mode} state ${state}`, recordSeqId: record.seqId, targetHeadSeqId: opts.mode === "before" ? record.parentId : record.seqId };
}

export function semanticStatesForRecord(record: DurableLogRecord, records: readonly DurableLogRecord[], recordIndex: number): StatePath[] {
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
		else for (let index = recordIndex - 1; index >= 0; index--) {
			const candidate = records[index];
			if (candidate?.type === "actor_message" && candidate.kind === "accepted" && candidate.occurrence === record.occurrence && candidate.messageId === record.messageId && candidate.workerIndex === record.workerIndex) { accepted = candidate; break; }
		}
		return accepted === undefined ? [record.occurrence, workerOccurrence] : [record.occurrence, workerOccurrence, accepted.receiveState];
	}
	if (record.type === "actor_scope") return [record.occurrence];
	if (record.type === "actor_call_resolved" || record.type === "actor_batch_call_resolved") return [record.callerState];
	return ["<run>"];
}

function recordMatchesState(records: readonly DurableLogRecord[], recordIndex: number, state: string): boolean {
	const record = records[recordIndex];
	return record !== undefined && semanticStatesForRecord(record, records, recordIndex).some((path) => path === state || templatePath(path) === state || isUnderState(path, state));
}
function isUnderState(path: string, state: string): boolean { return path === state || path.startsWith(`${state}.`) || path.startsWith(`${state}#`) || templatePath(path).startsWith(`${state}.`); }
