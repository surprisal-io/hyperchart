import type { ChartAst, StateAst } from "@surprisal/hyperchart/internal/core/types";
import type { DurableLogRecord } from "@surprisal/hyperchart/internal/core/durable_events";
import { createBranchProjection, isFinalState, type PendingAction, projectBranch } from "@surprisal/hyperchart/internal/core/projection";
import { underScope } from "@surprisal/hyperchart/internal/core/paths";

export type PendingView = {
	path: string;
	phase: "running" | "validating" | "rejected";
	sinceMs?: number;
	rejections?: number;
	reason?: string;
};

export type TreeRow = {
	depth: number;
	label: string;
	kind: StateAst["kind"];
	status: "idle" | "active" | "final";
	instanceOf?: string;
};

export type GraphNodeStatus = "pending" | "running" | "validating" | "rejected" | "completed" | "failed" | "final";

export type GraphRow = {
	depth: number;
	path: string;
	label: string;
	kind: StateAst["kind"] | "instance";
	status: GraphNodeStatus;
	action?: string;
	event?: string;
	sinceMs?: number;
	durationMs?: number;
	rejections?: number;
	reason?: string;
	instanceOf?: string;
};

export type RunView = {
	chartId: string;
	final: boolean;
	failedTerminal: boolean;
	args?: Record<string, unknown>;
	rows: TreeRow[];
	graph: GraphRow[];
	pending: PendingView[];
	results: Array<{ state: string; output: unknown }>;
	tail: Array<{ seqId: number; timestamp: number; text: string }>;
	result?: unknown;
};

export function buildRunView(ast: ChartAst, log: readonly DurableLogRecord[], now: number): RunView {
	const projection = projectBranch(createBranchProjection(ast), ast, log);
	const final = isFinalState(projection, ast);
	const finalLeaf = projection.activeLeaves[0];
	return {
		chartId: ast.id,
		final,
		failedTerminal: final && projection.activeLeaves.some((leaf) => ast.states[leaf]?.kind === "final" && ast.states[leaf]?.outcome === "failed"),
		...(projection.args === undefined ? {} : { args: { ...projection.args } }),
		rows: buildRows(ast, projection.activeLeaves, projection.spawns),
		graph: buildGraphRows(
			ast,
			log,
			projection.activeLeaves,
			projection.spawns,
			projection.pendingActions,
			projection.results,
			now,
		),
		pending: projection.pendingActions.map((pending) => pendingView(pending, now)),
		results: Object.entries(projection.results).map(([state, output]) => ({ state, output })),
		tail: log
			.slice(-30)
			.map((record) => ({ seqId: record.seqId, timestamp: record.timestamp, text: recordText(record) })),
		...(finalLeaf !== undefined && projection.results[finalLeaf] !== undefined
			? { result: projection.results[finalLeaf] }
			: {}),
	};
}

function buildRows(
	ast: ChartAst,
	activeLeaves: readonly string[],
	spawns: Record<string, Readonly<Record<string, unknown>>>,
): TreeRow[] {
	const children = new Map<string | undefined, Array<[string, StateAst]>>();
	for (const [path, state] of Object.entries(ast.states)) {
		const list = children.get(state.parent) ?? [];
		list.push([path, state]);
		children.set(state.parent, list);
	}
	for (const list of children.values()) {
		list.sort(([left], [right]) => left.localeCompare(right));
	}
	const rows: TreeRow[] = [];
	const visit = (path: string, state: StateAst, depth: number, instanceOf?: string) => {
		rows.push({
			depth,
			label: instanceOf === undefined ? state.id : path,
			kind: state.kind,
			status: statusFor(path, state, activeLeaves),
			...(instanceOf === undefined ? {} : { instanceOf }),
		});
		if (state.kind === "map" && spawns[path] !== undefined) {
			for (const key of Object.keys(spawns[path] ?? {})) {
				const instancePath = `${path}#${key}`;
				rows.push({
					depth: depth + 1,
					label: `#${key}`,
					kind: "map",
					status: activeLeaves.some((leaf) => underScope(leaf, instancePath)) ? "active" : "idle",
					instanceOf: path,
				});
			}
		}
		for (const [childPath, child] of children.get(path) ?? []) {
			visit(childPath, child, depth + 1);
		}
	};
	for (const [path, state] of children.get(undefined) ?? []) {
		visit(path, state, 0);
	}
	return rows;
}

function statusFor(path: string, state: StateAst, activeLeaves: readonly string[]): "idle" | "active" | "final" {
	if (state.kind === "final" && activeLeaves.includes(path)) return "final";
	return activeLeaves.some((leaf) => leaf === path || underScope(leaf, path)) ? "active" : "idle";
}

type ActionTimeline = {
	invokedAt?: number;
	completedAt?: number;
	event?: string;
	failed?: boolean;
};

function buildGraphRows(
	ast: ChartAst,
	log: readonly DurableLogRecord[],
	activeLeaves: readonly string[],
	spawns: Record<string, Readonly<Record<string, unknown>>>,
	pendingActions: readonly PendingAction[],
	results: Readonly<Record<string, unknown>>,
	now: number,
): GraphRow[] {
	const children = childMap(ast);
	const timelines = actionTimelines(log);
	const pendingByPath = new Map(pendingActions.map((pending) => [pending.actionUid.state, pending]));
	const rows: GraphRow[] = [];
	const visit = (
		templatePath: string,
		state: StateAst,
		depth: number,
		actualPath = templatePath,
		instanceOf?: string,
	) => {
		rows.push(graphRow(state, actualPath, depth, activeLeaves, pendingByPath, timelines, results, now, instanceOf));
		if (state.kind === "map" && spawns[templatePath] !== undefined) {
			for (const key of Object.keys(spawns[templatePath] ?? {})) {
				const instancePath = `${templatePath}#${key}`;
				rows.push({
					depth: depth + 1,
					path: instancePath,
					label: `#${key}`,
					kind: "instance",
					status: activeLeaves.some((leaf) => leaf === instancePath || underScope(leaf, instancePath))
						? "running"
						: Object.keys(results).some((statePath) => underScope(statePath, instancePath))
							? "completed"
							: "pending",
					instanceOf: templatePath,
				});
				for (const [childTemplatePath, child] of children.get(templatePath) ?? []) {
					visit(
						childTemplatePath,
						child,
						depth + 2,
						materializePath(childTemplatePath, templatePath, instancePath),
						templatePath,
					);
				}
			}
			return;
		}
		for (const [childPath, child] of children.get(templatePath) ?? []) {
			visit(childPath, child, depth + 1, materializePath(childPath, templatePath, actualPath), instanceOf);
		}
	};
	for (const [path, state] of children.get(undefined) ?? []) {
		visit(path, state, 0);
	}
	return rows;
}

function childMap(ast: ChartAst): Map<string | undefined, Array<[string, StateAst]>> {
	const children = new Map<string | undefined, Array<[string, StateAst]>>();
	for (const [path, state] of Object.entries(ast.states)) {
		const list = children.get(state.parent) ?? [];
		list.push([path, state]);
		children.set(state.parent, list);
	}
	for (const list of children.values()) list.sort(([left], [right]) => left.localeCompare(right));
	return children;
}

function graphRow(
	state: StateAst,
	path: string,
	depth: number,
	activeLeaves: readonly string[],
	pendingByPath: ReadonlyMap<string, PendingAction>,
	timelines: ReadonlyMap<string, ActionTimeline>,
	results: Readonly<Record<string, unknown>>,
	now: number,
	instanceOf?: string,
): GraphRow {
	const pending = pendingByPath.get(path);
	const timeline = timelines.get(path);
	const active = activeLeaves.some((leaf) => leaf === path || underScope(leaf, path));
	const status = graphStatus(state, path, active, pending, timeline, results);
	return {
		depth,
		path,
		label: state.id,
		kind: state.kind,
		status,
		...(state.kind === "state" ? { action: actionLabel(state) } : {}),
		...(timeline?.event === undefined ? {} : { event: timeline.event }),
		...(pending?.phase === "running" ? { sinceMs: Math.max(0, now - pending.timestamp) } : {}),
		...(timeline?.invokedAt !== undefined && timeline.completedAt !== undefined
			? { durationMs: Math.max(0, timeline.completedAt - timeline.invokedAt) }
			: {}),
		...(pending?.phase === "validating" || pending?.phase === "rejected"
			? { rejections: pending.validationAttempts }
			: {}),
		...(pending?.phase === "rejected" && pending.reason !== undefined ? { reason: pending.reason } : {}),
		...(instanceOf === undefined ? {} : { instanceOf }),
	};
}

function graphStatus(
	state: StateAst,
	path: string,
	active: boolean,
	pending: PendingAction | undefined,
	timeline: ActionTimeline | undefined,
	results: Readonly<Record<string, unknown>>,
): GraphNodeStatus {
	if (pending?.phase === "rejected") return "rejected";
	if (pending?.phase === "validating") return "validating";
	if (pending?.phase === "running") return "running";
	if (state.kind === "final" && active) return "final";
	if (timeline?.failed) return "failed";
	if (timeline?.completedAt !== undefined) return "completed";
	if (active) return "running";
	if (Object.keys(results).some((statePath) => statePath === path || underScope(statePath, path))) return "completed";
	return "pending";
}

function actionTimelines(log: readonly DurableLogRecord[]): Map<string, ActionTimeline> {
	const timelines = new Map<string, ActionTimeline>();
	for (const record of log) {
		if (record.type !== "state_action") continue;
		const path = record.actionUid.state;
		const timeline = timelines.get(path) ?? {};
		if (record.kind === "invoke") {
			timeline.invokedAt = record.timestamp;
		} else if (record.kind === "complete") {
			timeline.completedAt = record.timestamp;
			timeline.event = record.event.type;
			timeline.failed = record.event.type === "FAILED";
		}
		timelines.set(path, timeline);
	}
	return timelines;
}

function actionLabel(state: Extract<StateAst, { kind: "state" }>): string {
	const action = state.action;
	if (action.kind === "agent") return `agent:${action.name}`;
	if (action.kind === "script") return `script:${[action.command, ...action.args].join(" ")}`;
	return "user";
}

function materializePath(path: string, templateParent: string, actualParent: string): string {
	if (templateParent === actualParent) return path;
	if (path === templateParent) return actualParent;
	return path.replace(`${templateParent}.`, `${actualParent}.`);
}

function pendingView(pending: PendingAction, now: number): PendingView {
	return {
		path: pending.actionUid.state,
		phase: pending.phase,
		...(pending.phase === "running" ? { sinceMs: Math.max(0, now - pending.timestamp) } : {}),
		...(pending.phase === "validating" || pending.phase === "rejected"
			? { rejections: pending.validationAttempts }
			: {}),
		...(pending.phase === "rejected" && pending.reason !== undefined ? { reason: pending.reason } : {}),
	};
}

function recordText(record: DurableLogRecord): string {
	switch (record.type) {
		case "args":
			return `args ${JSON.stringify(record.args)}`;
		case "spawned":
			return `spawned ${record.path} (${Object.keys(record.instances).length})`;
		case "session_ref":
			return `session ${record.index}: ${record.file}`;
		case "failure_intent":
			return `failure ${record.origin}: ${String(record.error)}`;
		case "cancellation": {
			const target = record.target;
			const label = target.kind === "action" ? target.actionUid.state : target.kind === "actor_call" ? target.callerState : target.occurrence;
			return `cancellation ${record.kind} ${target.kind} ${label}`;
		}
		case "actor_created":
			return `actor ${record.occurrence} created`;
		case "actor_messages_enqueued":
			return `actor ${record.occurrence} enqueued ${record.messages.length}`;
		case "actor_message":
			return `actor ${record.occurrence} ${record.kind} ${record.messageId}`;
		case "actor_call_resolved":
			return `actor call ${record.callId} resolved`;
		case "actor_scope":
			return `actor ${record.occurrence} ${record.kind}`;
		case "state_action":
			switch (record.kind) {
				case "invoke":
					return `invoke ${record.actionUid.state}`;
				case "complete":
					return `complete ${record.actionUid.state} → ${record.event.type}`;
				case "validated":
					return `validated ${record.actionUid.state} → ${record.outcome === true ? "ok" : "reject"}`;
				case "timer_fired":
					return `timer ${record.actionUid.state}`;
			}
	}
}
