import type { HyperchartRunInfo, HyperchartStateInfo } from "@surprisal/hyperchart/host";

/**
 * Estimate durable run progress from completed action visits and the shortest remaining
 * transition path to a whole-chart final. This intentionally avoids treating every
 * graph node as equal: loops count completed visits, and branches are measured from
 * the latest active state across enclosing compound boundaries.
 */
export function summarizeHyperchartProgress(run?: HyperchartRunInfo): { done: number; total: number; pct: number } {
	if (run === undefined) return { done: 0, total: 0, pct: 0 };
	if (run.status === "completed" || run.status === "failed") {
		return { done: 1, total: 1, pct: 100 };
	}
	const current = currentProgressState(run.states);
	if (current === undefined) return { done: 0, total: 0, pct: 0 };
	const done = completedVisitCount(run.states);
	const remaining = shortestDistanceToChartFinal(current.id, run.states);
	if (remaining === undefined) return { done, total: done, pct: 0 };
	const total = done + remaining;
	return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}

function currentProgressState(states: HyperchartStateInfo[]): HyperchartStateInfo | undefined {
	const active = states.filter((state) => state.status === "running");
	if (active.length > 0) return latestState(active);
	return latestState(states.filter((state) => state.status === "done" || state.status === "failed"));
}

function latestState(states: HyperchartStateInfo[]): HyperchartStateInfo | undefined {
	return states.reduce<HyperchartStateInfo | undefined>(
		(latest, state) =>
			stateActivityTime(state) >= (latest === undefined ? -1 : stateActivityTime(latest)) ? state : latest,
		undefined,
	);
}

function stateActivityTime(state: HyperchartStateInfo): number {
	const visitTime =
		state.visitHistory?.reduce((latest, visit) => Math.max(latest, visit.endedAt ?? visit.startedAt), -1) ?? -1;
	return Math.max(visitTime, state.endedAt ?? state.startedAt ?? -1);
}

function completedVisitCount(states: HyperchartStateInfo[]): number {
	return states.reduce((count, state) => {
		if (state.visitHistory !== undefined) {
			return count + state.visitHistory.filter((visit) => visit.status === "done" || visit.status === "failed").length;
		}
		const actionState = state.type === undefined || state.type === "agent" || state.type === "user" || state.type === "script";
		return count + (state.final !== true && actionState && (state.status === "done" || state.status === "failed") ? 1 : 0);
	}, 0);
}

function shortestDistanceToChartFinal(startId: string, states: HyperchartStateInfo[]): number | undefined {
	const byId = new Map(states.map((state) => [state.id, state]));
	const queue: Array<{ id: string; distance: number }> = [{ id: startId, distance: 0 }];
	const visited = new Set<string>();
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined || visited.has(current.id)) continue;
		visited.add(current.id);
		const state = byId.get(current.id);
		const container = state?.final === true ? enclosingContainer(state.id, byId) : undefined;
		if (state?.final === true && container === undefined) return current.distance;
		for (const transition of state?.transitions ?? []) {
			enqueueTransitionTarget(queue, visited, transition.target, current.distance + 1, byId);
		}
		if (state?.final === true && container !== undefined) {
			const completionTarget = enclosingCompletionTarget(container, byId);
			if (completionTarget !== undefined) {
				enqueueTransitionTarget(queue, visited, completionTarget, current.distance + 1, byId);
			}
		}
	}
	return undefined;
}

function enqueueTransitionTarget(
	queue: Array<{ id: string; distance: number }>,
	visited: Set<string>,
	target: string,
	distance: number,
	byId: Map<string, HyperchartStateInfo>,
): void {
	const targetState = byId.get(target);
	const entersNestedScope = targetState?.type === "compound" || targetState?.type === "parallel" || targetState?.type === "region";
	if (entersNestedScope) {
		const initialChildren = [...byId.values()].filter(
			(state) => state.initial === true && enclosingContainer(state.id, byId)?.id === target,
		);
		if (initialChildren.length > 0) {
			for (const child of initialChildren) {
				if (!visited.has(child.id)) queue.push({ id: child.id, distance });
			}
			return;
		}
	}
	if (!visited.has(target)) queue.push({ id: target, distance });
}

function enclosingCompletionTarget(
	container: HyperchartStateInfo,
	byId: Map<string, HyperchartStateInfo>,
): string | undefined {
	let current: HyperchartStateInfo | undefined = container;
	while (current !== undefined) {
		const target = current.transitions?.find((transition) => transition.event === "onDone")?.target;
		if (target !== undefined) return target;
		current = enclosingContainer(current.id, byId);
	}
	return undefined;
}

function enclosingContainer(
	stateId: string,
	byId: Map<string, HyperchartStateInfo>,
): HyperchartStateInfo | undefined {
	let parent = parentPath(stateId);
	while (parent !== undefined) {
		const direct = byId.get(parent);
		if (direct !== undefined) return direct;
		const templateContainer = byId.get(stripLastInstanceKey(parent));
		if (templateContainer !== undefined) return templateContainer;
		parent = parentPath(parent);
	}
	return undefined;
}

function parentPath(path: string): string | undefined {
	const separator = path.lastIndexOf(".");
	return separator === -1 ? undefined : path.slice(0, separator);
}

function stripLastInstanceKey(path: string): string {
	const separator = path.lastIndexOf(".");
	const hash = path.lastIndexOf("#");
	return hash > separator ? path.slice(0, hash) : path;
}
