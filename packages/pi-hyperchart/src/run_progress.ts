import type { HyperchartRunInfo, HyperchartStateInfo } from "@surprisal/hyperchart/host";

/**
 * Estimate durable run progress from completed visits and the shortest remaining
 * transition path. This intentionally avoids treating every graph node as equal:
 * loops count completed visits, and branches are measured from the latest active state.
 */
export function summarizeHyperchartProgress(run?: HyperchartRunInfo): { done: number; total: number; pct: number } {
	if (run === undefined) return { done: 0, total: 0, pct: 0 };
	if (run.status === "completed" || run.status === "failed") {
		return { done: 1, total: 1, pct: 100 };
	}
	const current = currentProgressState(run.states);
	if (current === undefined) return { done: 0, total: 0, pct: 0 };
	const done = completedVisitCount(run.states);
	const remaining = shortestDistanceToFinal(current.id, run.states);
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
		return count + (state.final !== true && (state.status === "done" || state.status === "failed") ? 1 : 0);
	}, 0);
}

function shortestDistanceToFinal(startId: string, states: HyperchartStateInfo[]): number | undefined {
	const byId = new Map(states.map((state) => [state.id, state]));
	const queue: Array<{ id: string; distance: number }> = [{ id: startId, distance: 0 }];
	const visited = new Set<string>();
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined || visited.has(current.id)) continue;
		visited.add(current.id);
		const state = byId.get(current.id);
		if (state?.final === true) return current.distance;
		for (const transition of state?.transitions ?? []) {
			if (!visited.has(transition.target)) queue.push({ id: transition.target, distance: current.distance + 1 });
		}
	}
	return undefined;
}
