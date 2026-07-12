import { ArrowPathIcon, CheckCircleIcon, ClockIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import type { HyperchartStateInfo, HyperchartRunInfo, HyperchartUsageInfo } from "./types.js";

export function hyperchartStatusClasses(status: string): string {
	switch (status) {
		case "running":
			return "border-blue-500/40 text-[var(--hc-blue-text)] bg-blue-500/10";
		case "completed":
		case "done":
			return "border-green-500/40 text-[var(--hc-green-text)] bg-green-500/10";
		case "failed":
			return "border-red-500/40 text-[var(--hc-red-text)] bg-red-500/10";
		case "blocked":
		case "stale":
			return "border-amber-500/40 text-[var(--hc-amber-text)] bg-amber-500/10";
		case "paused":
			return "border-purple-500/40 text-[var(--hc-purple-text)] bg-purple-500/10";
		case "skipped":
		case "cancelled":
			return "border-[var(--border-secondary)] text-[var(--text-muted)] bg-[var(--bg-tertiary)]";
		default:
			return "border-[var(--border-secondary)] text-[var(--text-secondary)] bg-[var(--bg-tertiary)]";
	}
}

export function hyperchartStatusDotClass(status: string): string {
	switch (status) {
		case "running":
			return "bg-[var(--accent-blue)]";
		case "completed":
		case "done":
			return "bg-[var(--accent-green)]";
		case "failed":
			return "bg-[var(--accent-red)]";
		case "blocked":
		case "stale":
			return "bg-[var(--accent-yellow)]";
		case "paused":
			return "bg-[var(--accent-purple)]";
		case "skipped":
		case "cancelled":
			return "bg-[var(--text-muted)]";
		default:
			return "bg-[var(--text-tertiary)]";
	}
}

export function hyperchartStatusIcon(status: string) {
	switch (status) {
		case "running":
			return ArrowPathIcon;
		case "completed":
		case "done":
			return CheckCircleIcon;
		case "failed":
		case "blocked":
			return ExclamationTriangleIcon;
		case "stale":
			return ClockIcon;
		default:
			return ClockIcon;
	}
}

export function formatHyperchartTime(ts?: number): string {
	if (!ts) return "—";
	return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatHyperchartDateTime(ts?: number): string {
	if (!ts) return "—";
	return new Date(ts).toLocaleString([], {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

export function summarizeHyperchartProgress(run?: HyperchartRunInfo): { done: number; total: number; pct: number } {
	if (run === undefined) return { done: 0, total: 0, pct: 0 };
	if (run.status === "completed" || run.status === "failed" || run.states.some((state) => state.final === true && state.status === "done")) {
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
	return states.reduce<HyperchartStateInfo | undefined>((latest, state) =>
		stateActivityTime(state) >= (latest === undefined ? -1 : stateActivityTime(latest)) ? state : latest, undefined);
}

function stateActivityTime(state: HyperchartStateInfo): number {
	const visitTime = state.visitHistory?.reduce((latest, visit) => Math.max(latest, visit.endedAt ?? visit.startedAt), -1) ?? -1;
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

export function runningHyperchartStates(run?: HyperchartRunInfo): HyperchartStateInfo[] {
	return run?.states.filter((state) => state.status === "running") ?? [];
}

export function formatHyperchartUsage(usage?: HyperchartUsageInfo): string | null {
	if (!usage) return null;
	const parts: string[] = [];
	if (typeof usage.total === "number" && usage.total > 0) parts.push(`${usage.total.toLocaleString()} tok`);
	if (typeof usage.cost === "number" && usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.length > 0 ? parts.join(" · ") : null;
}

export function hyperchartChartName(run: HyperchartRunInfo): string {
	return run.chartName;
}

export function hyperchartRunLabel(run: HyperchartRunInfo): string {
	return `${hyperchartChartName(run)} · ${run.status}`;
}
