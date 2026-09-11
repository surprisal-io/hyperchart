import type {
	HyperchartRecordInfo,
	HyperchartRunInfo,
	HyperchartStateInfo,
	HyperchartVisitInfo,
} from "../../../types.js";

export type ActionVisitIndex = Readonly<{
	invokeSeqId: number;
	statePath: string;
	originBranchId: string;
}>;

export type ActionVisitRow = ActionVisitIndex &
	Readonly<{
		graphStateId?: string;
		visit?: HyperchartVisitInfo;
		error?: string;
	}>;

export type ActionStateContext = Readonly<{
	stateId: string;
	label:
		| "Active"
		| "Waiting"
		| "Pending—not guaranteed to execute"
		| "Skipped"
		| "Not yet visited"
		| "Visit history unavailable";
}>;

/** Durable sequence order is the branch chronology; record timestamps are presentation-only. */
export function actionVisitIndexes(records: readonly HyperchartRecordInfo[]): ActionVisitIndex[] {
	const byInvocation = new Map<number, ActionVisitIndex>();
	for (const item of records) {
		if (!isRecord(item.record)) {
			continue;
		}
		if (item.type === "state_action") {
			if (item.record.kind !== "invoke" || !isRecord(item.record.actionUid)) {
				continue;
			}
			const state = item.record.actionUid.state;
			if (typeof state !== "string") {
				continue;
			}
			byInvocation.set(item.seqId, { invokeSeqId: item.seqId, statePath: state, originBranchId: item.branchId });
			continue;
		}
		if (item.type === "actor_messages_enqueued" && isRecord(item.record.source)) {
			const state = item.record.source.producerState;
			if (typeof state === "string") {
				byInvocation.set(item.seqId, { invokeSeqId: item.seqId, statePath: state, originBranchId: item.branchId });
			}
		}
	}
	return [...byInvocation.values()].sort((left, right) => left.invokeSeqId - right.invokeSeqId);
}

export function actionVisitRows(records: readonly HyperchartRecordInfo[]): ActionVisitRow[] {
	const recordsBySeqId = new Map(records.map((record) => [record.seqId, record]));
	return actionVisitIndexes(records).map((index) => {
		const visit = recordsBySeqId.get(index.invokeSeqId)?.actionVisit;
		return visit === undefined
			? { ...index, error: "Visit details are unavailable in this snapshot." }
			: { ...index, visit };
	});
}

export function graphStateIdForRuntimePath(
	states: readonly HyperchartStateInfo[],
	statePath: string,
): string | undefined {
	return states.find((state) => (state.runtimeStatePath ?? state.id) === statePath)?.id;
}

export function actorMessageVisitForState(
	state: HyperchartStateInfo,
	invokeSeqId: number,
	originBranchId: string,
): HyperchartVisitInfo | undefined {
	const messages = state.actorMessageLink?.messages?.filter((message) => message.enqueueSeqId === invokeSeqId);
	if (messages === undefined || messages.length === 0) {
		return undefined;
	}
	const first = messages[0]!;
	const done =
		state.actorMessageLink?.kind === "send" ||
		state.actorMessageLink?.kind === "sendBatch" ||
		messages.every((message) => message.status === "settled" || message.status === "replied");
	return {
		visit: first.producerVisit,
		invokeSeqId,
		originBranchId,
		startedAt: first.enqueuedAt,
		...(done ? { endedAt: first.enqueuedAt } : {}),
		status: done ? "done" : "running",
		invocation: { kind: "actor" },
	};
}

export function actionVisitStatusLabel(visit: HyperchartVisitInfo): string {
	switch (visit.status) {
		case "unknown":
			return "Unknown · Replay incompatible";
		case "running":
			return "In progress";
		case "done":
			return "Completed";
		case "failed":
			return "Failed";
		case "cancelled":
			if (visit.endedReason === "timed_out") {
				return "Cancelled · Timed out";
			}
			if (visit.endedReason === "scope_exit") {
				return "Cancelled · Scope exited";
			}
			return "Cancelled";
	}
}

export function embeddedActionVisitRows(run: HyperchartRunInfo): ActionVisitRow[] {
	const rows = new Map<number, ActionVisitRow>();
	const append = (statePath: string, visits: readonly HyperchartVisitInfo[] | undefined, graphStateId?: string) => {
		for (const visit of visits ?? []) {
			if (visit.invocation.kind === "actor") {
				continue;
			}
			rows.set(visit.invokeSeqId, {
				invokeSeqId: visit.invokeSeqId,
				statePath,
				originBranchId: visit.originBranchId ?? run.branchId ?? "main",
				...(graphStateId === undefined ? {} : { graphStateId }),
				visit,
			});
		}
	};
	for (const state of run.states) {
		const runtimePath = state.runtimeStatePath ?? state.id;
		append(runtimePath, state.visitHistory, state.id);
		const enqueueSeqIds = new Set((state.actorMessageLink?.messages ?? []).map((message) => message.enqueueSeqId));
		for (const enqueueSeqId of enqueueSeqIds) {
			const originBranchId = run.branchId ?? "main";
			const visit = actorMessageVisitForState(state, enqueueSeqId, originBranchId);
			if (visit !== undefined) {
				rows.set(enqueueSeqId, {
					invokeSeqId: enqueueSeqId,
					statePath: runtimePath,
					originBranchId,
					graphStateId: state.id,
					visit,
				});
			}
		}
		for (const generation of state.actorInternal?.generations ?? []) {
			append(
				`${generation.occurrencePath}.${state.actorInternal?.localState ?? state.id}`,
				generation.visitHistory,
				state.id,
			);
		}
		for (const worker of state.actorOccurrence?.workers ?? []) {
			append(`${worker.occurrencePath}.${worker.currentState}`, worker.visitHistory, worker.currentStateId);
		}
	}
	return [...rows.values()].sort((left, right) => left.invokeSeqId - right.invokeSeqId);
}

export function actionStateContexts(states: readonly HyperchartStateInfo[]): ActionStateContext[] {
	const contexts: ActionStateContext[] = [];
	for (const state of states) {
		if (!isActionState(state)) {
			continue;
		}
		if (state.status === "running") {
			contexts.push({ stateId: state.id, label: "Active" });
		} else if (state.status === "waiting") {
			contexts.push({ stateId: state.id, label: "Waiting" });
		} else if (state.status === "pending") {
			contexts.push({ stateId: state.id, label: "Pending—not guaranteed to execute" });
		} else if (state.status === "skipped") {
			contexts.push({ stateId: state.id, label: "Skipped" });
		} else {
			const count = state.runtimeSummary?.visitCount ?? state.visitHistory?.length;
			if (count === 0) {
				contexts.push({ stateId: state.id, label: "Not yet visited" });
			} else if (count === undefined) {
				contexts.push({ stateId: state.id, label: "Visit history unavailable" });
			}
		}
	}
	return contexts;
}

function isActionState(state: HyperchartStateInfo): boolean {
	return (
		state.type === undefined ||
		state.type === "agent" ||
		state.type === "user" ||
		state.type === "script" ||
		state.type === "tsImport"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
