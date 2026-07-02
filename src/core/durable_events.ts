import type { ActionUID, ChartEvent } from "./types.js";

type SessionParams = {
	seqId: number;
	parentId: number | null;
	timestamp: number;
};

type SessionRefLog = {
	type: "session_ref";
	index: number;
	file: string;
} & SessionParams;

type StateActionInvokeLog = {
	type: "state_action";
	kind: "invoke";
	actionUid: ActionUID;
} & SessionParams;

// The emitted event is the fact; transitions are never logged — the projection recomputes the
// route from the chart AST, so a log stays applicable to a modified chart.
type StateActionCompleteLog = {
	type: "state_action";
	kind: "complete";
	actionUid: ActionUID;
	event: ChartEvent;
} & SessionParams;

type StateAction = StateActionInvokeLog | StateActionCompleteLog;

export type DurableLogRecord = SessionRefLog | StateAction;
