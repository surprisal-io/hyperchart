import { actionUidKey } from "./action_uid.js";
import type { DurableLogRecord } from "./durable_events.js";
import { nodeAt } from "./paths.js";
import {
	createBranchProjection,
	projectBranch,
	type BranchProjection,
	type ProjectionSkippedRecord,
} from "./projection.js";
import type { ActionUID, ChartAst, StatePath } from "./types.js";

export type ReplayBrokenRecord = Readonly<{
	index: number;
	seqId: number;
	record: DurableLogRecord;
	error: string;
	state?: StatePath;
	invokeSeqId?: number;
}>;

export type ReplaySkippedRecord = ProjectionSkippedRecord &
	Readonly<{
		index: number;
		seqId: number;
	}>;

export type ReplayStaleRecord = Readonly<{
	index: number;
	seqId: number;
	record: DurableLogRecord;
	state: StatePath;
	reason: "action_definition_changed" | "guard_changed";
	message: string;
	invokeSeqId?: number;
}>;

export type ReplayExplanation = Readonly<{
	// Number of records that applied before the first structurally broken record. If there is no
	// broken record this equals log.length. This is an array prefix end, not a durable seqId.
	prefixEnd: number;
	// Durable seqId of the last record in the valid prefix, when there is one.
	seqId?: number;
	broken?: ReplayBrokenRecord;
	skipped: readonly ReplaySkippedRecord[];
	stale: readonly ReplayStaleRecord[];
}>;

export function explainReplay(ast: ChartAst, log: readonly DurableLogRecord[]): ReplayExplanation {
	const projection = createBranchProjection(ast);
	const skipped: ReplaySkippedRecord[] = [];
	const stale: ReplayStaleRecord[] = [];
	for (let index = 0; index < log.length; index++) {
		const record = log[index];
		if (record === undefined) continue;
		stale.push(...staleRecordsFor(ast, projection, index, record));
		const skippedForRecord: ProjectionSkippedRecord[] = [];
		try {
			projectBranch(projection, ast, [record], [], skippedForRecord);
		} catch (error) {
			const previous = index > 0 ? log[index - 1] : undefined;
			return {
				prefixEnd: index,
				...(previous === undefined ? {} : { seqId: previous.seqId }),
				broken: brokenRecordFor(projection, log, index, record, error),
				skipped,
				stale,
			};
		}
		for (const entry of skippedForRecord) {
			skipped.push({ ...entry, index, seqId: record.seqId });
		}
	}
	const last = log[log.length - 1];
	return {
		prefixEnd: log.length,
		...(last === undefined ? {} : { seqId: last.seqId }),
		skipped,
		stale,
	};
}

function staleRecordsFor(
	ast: ChartAst,
	projection: BranchProjection,
	index: number,
	record: DurableLogRecord,
): ReplayStaleRecord[] {
	if (record.type !== "state_action") return [];
	const state = record.actionUid.state;
	if (!projection.activeLeaves.includes(state) && record.kind !== "validated") return [];
	const node = nodeAt(ast, state);
	if (node?.kind !== "state") return [];
	if (record.kind === "invoke") {
		if (!isRecord(record.definition)) return [];
		if (stableStringify(record.definition) === stableStringify(node.action)) return [];
		return [
			{
				index,
				seqId: record.seqId,
				record,
				state,
				reason: "action_definition_changed",
				message: `Action definition for state ${state} changed since invoke seqId ${record.seqId}`,
				invokeSeqId: record.seqId,
			},
		];
	}
	if (record.kind === "validated") {
		const pending = projection.pendingActions.find((entry) => sameActionUid(entry.actionUid, record.actionUid));
		if (node.validate === undefined || stableStringify(record.guard) === stableStringify(node.validate)) return [];
		return [
			{
				index,
				seqId: record.seqId,
				record,
				state,
				reason: "guard_changed",
				message: `Guard for state ${state} changed since validation seqId ${record.seqId}`,
				...(pending === undefined ? {} : { invokeSeqId: pending.invokeSeqId }),
			},
		];
	}
	return [];
}

function brokenRecordFor(
	projection: BranchProjection,
	log: readonly DurableLogRecord[],
	index: number,
	record: DurableLogRecord,
	error: unknown,
): ReplayBrokenRecord {
	const base = {
		index,
		seqId: record.seqId,
		record,
		error: error instanceof Error ? error.message : String(error),
	};
	if (record.type !== "state_action") {
		return record.type === "spawned" ? { ...base, state: record.path } : base;
	}
	const pending = projection.pendingActions.find((entry) => sameActionUid(entry.actionUid, record.actionUid));
	const invokeSeqId =
		pending?.invokeSeqId ?? (record.kind === "invoke" ? record.seqId : lastInvokeSeqId(log, index, record.actionUid));
	return {
		...base,
		state: record.actionUid.state,
		...(invokeSeqId === undefined ? {} : { invokeSeqId }),
	};
}

function lastInvokeSeqId(
	log: readonly DurableLogRecord[],
	beforeIndex: number,
	actionUid: ActionUID,
): number | undefined {
	for (let index = beforeIndex - 1; index >= 0; index--) {
		const record = log[index];
		if (
			record?.type === "state_action" &&
			record.kind === "invoke" &&
			actionUidKey(record.actionUid) === actionUidKey(actionUid)
		) {
			return record.seqId;
		}
	}
	return undefined;
}

function sameActionUid(left: ActionUID, right: ActionUID): boolean {
	return left.chart === right.chart && left.state === right.state && left.action === right.action;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
	return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, stableValue(entry)]),
	);
}
