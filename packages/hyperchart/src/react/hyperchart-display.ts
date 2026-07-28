import { ArrowPathIcon, CheckCircleIcon, ClockIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import type { HyperchartStateInfo, HyperchartRunInfo, HyperchartUsageInfo } from "./types.js";
export { summarizeHyperchartProgress } from "../host/run_progress.js";

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
		case "waiting":
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
		case "waiting":
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
		case "waiting":
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

export function hyperchartChartName(run: Pick<HyperchartRunInfo, "chartName">): string {
	return run.chartName;
}

export function hyperchartRunLabel(run: Pick<HyperchartRunInfo, "chartName" | "status">): string {
	return `${hyperchartChartName(run)} · ${run.status}`;
}
