import type { HyperchartStateInfo } from "../../../types.js";
import type { FanoutStatusSummary, HyperchartBranch } from "../types.js";

export function mapItemDotClass(status?: string): string {
	switch (status) {
		case "running":
			return "bg-[var(--accent-blue)]";
		case "waiting":
			return "bg-[var(--accent-yellow)]";
		case "done":
			return "bg-[var(--accent-green)]";
		case "failed":
			return "bg-[var(--accent-red)]";
		case "stale":
			return "bg-[var(--accent-yellow)]";
		case "skipped":
			return "bg-[var(--text-muted)]";
		default:
			return "bg-[var(--text-tertiary)]";
	}
}

export function branchDisplayName(branch: HyperchartBranch): string | undefined {
	const id = typeof branch.id === "string" ? branch.id : undefined;
	const localId = id?.split(".").at(-1);
	return localId ?? branch.taskPreview ?? branch.agent;
}

export function fanoutStatusSummary(state: HyperchartStateInfo): FanoutStatusSummary | undefined {
	if (state.type === "map") {
		const items = state.mapConfig?.items ?? [];
		const entries = items.map((item) => ({
			key: item.key,
			label: item.label,
			status: item.status,
			title:
				[
					item.label,
					item.summary,
					item.state,
					item.issueCount ? `${item.issueCount} issue${item.issueCount === 1 ? "" : "s"}` : undefined,
				]
					.filter(Boolean)
					.join("\n") || item.label,
			issueCount: item.issueCount,
		}));
		const total = state.subProgress?.total ?? (state.mapConfig?.items !== undefined ? items.length : undefined);
		const done = state.subProgress?.done ?? items.filter((item) => item.status === "done").length;
		const waiting = state.subProgress?.waiting ?? items.filter((item) => item.status === "waiting").length;
		const running = state.subProgress?.running ?? items.filter((item) => item.status === "running").length;
		const failed = state.subProgress?.failed ?? items.filter((item) => item.status === "failed").length;
		const stale = state.subProgress?.stale ?? items.filter((item) => item.status === "stale").length;
		const pending =
			total !== undefined
				? Math.max(0, total - done - waiting - running - failed - stale)
				: items.filter(
						(item) =>
							item.status !== "done" &&
							item.status !== "waiting" &&
							item.status !== "running" &&
							item.status !== "failed" &&
							item.status !== "stale",
					).length;
		return {
			kind: "map",
			label: "items",
			emptyLabel: state.mapConfig?.items !== undefined ? "no items" : "items pending",
			emptyHint:
				state.mapConfig?.items !== undefined ? "Nothing to fan out for this map." : "Waiting for the map item list.",
			total,
			done,
			waiting,
			running,
			failed,
			stale,
			pending,
			entries,
		};
	}
	if (state.type === "parallel") {
		const branches = state.parallelConfig?.branches ?? [];
		const entries = branches.map((branch, index) => {
			const label = branchDisplayName(branch) ?? branch.id ?? `branch ${index + 1}`;
			return {
				key: branch.id ?? label,
				label,
				title: [
					branch.id ?? label,
					branch.issueCount ? `${branch.issueCount} issue${branch.issueCount === 1 ? "" : "s"}` : undefined,
				]
					.filter(Boolean)
					.join("\n"),
				issueCount: branch.issueCount,
			};
		});
		const total =
			state.subProgress?.total ?? state.parallelConfig?.count ?? (entries.length > 0 ? entries.length : undefined);
		const done = state.subProgress?.done ?? (state.status === "done" && total !== undefined ? total : 0);
		const waiting = state.subProgress?.waiting ?? 0;
		const running = state.subProgress?.running ?? 0;
		const failed = state.subProgress?.failed ?? 0;
		const stale = state.subProgress?.stale ?? 0;
		const pending = total !== undefined ? Math.max(0, total - done - waiting - running - failed - stale) : 0;
		return {
			kind: "parallel",
			label: "branches",
			emptyLabel: "branches pending",
			emptyHint: "Waiting for parallel branches.",
			total,
			done,
			waiting,
			running,
			failed,
			stale,
			pending,
			entries,
		};
	}
	return undefined;
}
