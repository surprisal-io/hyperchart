import { useMemo } from "react";
import type { HyperchartInspectorDataSource, HyperchartRecordInfo, HyperchartRunInfo } from "../../../types.js";
import type { HistoryCursor, HistorySnapshot } from "../../../../runtime/generic/log_store.js";
import {
	actionVisitRows,
	actorMessageVisitForState,
	embeddedActionVisitRows,
	graphStateIdForRuntimePath,
	type ActionVisitRow,
} from "../helpers/actionVisits.js";
import { useHistoryWindow } from "./useHistoryWindow.js";

export function useActionVisitHistory(run: HyperchartRunInfo, dataSource?: HyperchartInspectorDataSource) {
	const snapshot = useMemo(() => historySnapshot(run), [run]);
	const cacheKey = `${run.runId}:${snapshot.branchId}:${snapshot.headSeqId ?? "root"}:action-visits`;
	const recordSource = useMemo(
		() => ({
			load: async (cursor?: HistoryCursor) =>
				dataSource === undefined
					? { snapshot, items: [] }
					: dataSource.readRecords({
							runId: run.runId,
							snapshot,
							includeActionVisits: true,
							...(cursor === undefined ? {} : { cursor }),
						}),
		}),
		[dataSource, run.runId, snapshot],
	);
	const records = useHistoryWindow<HyperchartRecordInfo>({
		cacheKey,
		source: recordSource,
		identity: recordIdentity,
	});
	const embeddedRows = useMemo(() => embeddedActionVisitRows(run), [run]);
	const rows = useMemo<ActionVisitRow[]>(() => {
		if (dataSource === undefined) {
			return embeddedRows;
		}
		if (!sameSnapshot(records.window.snapshot, snapshot)) {
			return [];
		}
		return actionVisitRows(records.window.items).map((row) => {
			const graphStateId = graphStateIdForRuntimePath(run.states, row.statePath);
			if (graphStateId === undefined) {
				return row;
			}
			const state = run.states.find((candidate) => candidate.id === graphStateId);
			const actorVisit =
				row.visit === undefined && state !== undefined
					? actorMessageVisitForState(state, row.invokeSeqId, row.originBranchId)
					: undefined;
			if (actorVisit === undefined) {
				return { ...row, graphStateId };
			}
			const { error: _error, ...index } = row;
			return { ...index, graphStateId, visit: actorVisit };
		});
	}, [dataSource, embeddedRows, records.window.items, records.window.snapshot, run.states, snapshot]);

	return {
		rows,
		snapshot,
		loading: records.initial.loading,
		initialError: records.initial.error,
		hasOlder: records.window.older !== undefined,
		hasNewer: records.window.newer !== undefined,
		older: records.older,
		newer: records.newer,
		loadOlder: records.loadOlder,
		loadNewer: records.loadNewer,
		retryInitial: records.retryInitial,
		historyAvailable: dataSource !== undefined || embeddedRows.length > 0,
	};
}

function sameSnapshot(left: HistorySnapshot | undefined, right: HistorySnapshot): boolean {
	return left?.branchId === right.branchId && left.headSeqId === right.headSeqId;
}

function historySnapshot(run: HyperchartRunInfo): HistorySnapshot {
	if (run.historySnapshot !== undefined) {
		return run.historySnapshot;
	}
	const branchId = run.branchId ?? "main";
	return {
		branchId,
		headSeqId: run.branches?.find((branch) => branch.branchId === branchId)?.headSeqId ?? null,
	};
}

function recordIdentity(record: HyperchartRecordInfo): string {
	return String(record.seqId);
}
