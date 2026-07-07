import type { ActionUID, ChartEvent, GuardOutcome, GuardRef, StateActionAst, StatePath } from "./types.js";

type SessionParams = {
	seqId: number;
	parentId: number | null;
	timestamp: number;
};

type SessionRefLog = {
	type: "session_ref";
	index: number;
	file: string;
	actionUid?: ActionUID;
} & SessionParams;

// The run's input arguments — external data, hence a fact: the first record of a fresh log,
// seeded by start() when the run is created. Everything downstream (template rendering, replay)
// reads args from here and only here.
type ArgsLog = {
	type: "args";
	args: Readonly<Record<string, unknown>>;
} & SessionParams;

// A map's fan-out is a fact: which instance keys exist and what item each carries, pinned when
// the map is entered. The instance's input is frozen at birth — later changes to the `over`
// source do not reach spawned instances, and replay re-creates exactly the same fan-out.
type SpawnedLog = {
	type: "spawned";
	path: StatePath;
	instances: Readonly<Record<string, unknown>>;
} & SessionParams;

export type StateActionInvokeLog = {
	type: "state_action";
	kind: "invoke";
	actionUid: ActionUID;
	// Mandatory provenance for replay over a modified chart. Logs without it are structurally
	// incompatible and must be rewound/restarted instead of silently replayed.
	definition: StateActionAst;
} & SessionParams;

// The emitted event is the fact; transitions are never logged — the projection recomputes the
// route from the chart AST, so a log stays applicable to a modified chart.
type StateActionCompleteLog = {
	type: "state_action";
	kind: "complete";
	actionUid: ActionUID;
	event: ChartEvent;
} & SessionParams;

// Validation verdict for a completion claim. Stored like any other fact: replay reads the
// outcome instead of re-running the validator. The guard ref is provenance — a later "can this
// log replay unchanged?" check compares it (docker-cache style) against the current chart.
type StateActionValidatedLog = {
	type: "state_action";
	kind: "validated";
	actionUid: ActionUID;
	event: ChartEvent;
	guard: GuardRef;
	outcome: GuardOutcome;
} & SessionParams;

// The action's deadline expired before a completion landed. Like transitions, the target is not
// logged — the projection recomputes it from the state's `after` in the current chart.
type StateActionTimerFiredLog = {
	type: "state_action";
	kind: "timer_fired";
	actionUid: ActionUID;
} & SessionParams;

type StateAction = StateActionInvokeLog | StateActionCompleteLog | StateActionValidatedLog | StateActionTimerFiredLog;

export type DurableLogRecord = SessionRefLog | ArgsLog | SpawnedLog | StateAction;
