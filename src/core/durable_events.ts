import type { ActionUID, StateId } from "./types.js";

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

type StateTransitionLog = {
	type: "state_transition";
	kind: "simple";
	source: StateId;
	target: StateId;
} & SessionParams;

type GuardRef = unknown;

type GuardedStateTransitionLog = {
	type: "state_transition";
	kind: "guarded";
	source: StateId;
	target: StateId;
	guard: GuardRef;
} & SessionParams;

type StateActionInvokeLog = {
	type: "state_action";
	kind: "invoke";
	actionUid: ActionUID;
} & SessionParams;

type StateActionCompleteLog = {
	type: "state_action";
	kind: "complete";
	actionUid: ActionUID;
} & SessionParams;

type StateTransition = StateTransitionLog | GuardedStateTransitionLog;
type StateAction = StateActionInvokeLog | StateActionCompleteLog;

export type DurableLogRecord = SessionRefLog | StateTransition | StateAction;
