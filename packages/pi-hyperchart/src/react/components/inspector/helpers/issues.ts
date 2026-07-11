import type { HyperchartIssueInfo } from "../../../types.js";

export function issueSeverityClasses(severity: HyperchartIssueInfo["severity"]): { card: string; badge: string } {
	if (severity === "error")
		return {
			card: "border-red-500/30 bg-red-500/10",
			badge: "border-red-500/35 bg-red-500/15 text-[var(--hc-red-text)]",
		};
	if (severity === "warning")
		return {
			card: "border-amber-500/30 bg-amber-500/10",
			badge: "border-amber-500/35 bg-amber-500/15 text-[var(--hc-amber-text)]",
		};
	return {
		card: "border-sky-500/30 bg-sky-500/10",
		badge: "border-sky-500/35 bg-sky-500/15 text-[var(--hc-blue-text)]",
	};
}

export function issueKindLabel(kind: HyperchartIssueInfo["kind"]): string {
	return kind.replaceAll("_", " ");
}
