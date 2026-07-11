import type { ElkPoint } from "elkjs/lib/elk.bundled.js";
import type { EdgeProps } from "@xyflow/react";
import type { RoutedEdgeData } from "../types.js";

export const EDGE_NEUTRAL_COLOR = "var(--text-tertiary)";
export const EDGE_RUNNING_COLOR = "var(--accent-blue)";
export const EDGE_LABEL_TEXT = "var(--text-secondary)";
export const EDGE_LABEL_BG = "var(--bg-primary)";
export const EDGE_LABEL_STROKE = "var(--border-secondary)";

export function routedEdgePoints(data: EdgeProps["data"]): ElkPoint[] | undefined {
	const points = (data as RoutedEdgeData | undefined)?.points;
	return points && points.length >= 2 ? points : undefined;
}

export function routedPolylinePath(points: ElkPoint[]): string {
	const first = points[0];
	if (first === undefined) return "";
	return [`M ${first.x} ${first.y}`, ...points.slice(1).map((point) => `L ${point.x} ${point.y}`)].join(" ");
}

export function routeLabelPoint(points: ElkPoint[]): ElkPoint {
	const fallback = points[0] ?? { x: 0, y: 0 };
	const index = Math.max(0, Math.floor((points.length - 1) / 2));
	const a = points[index] ?? fallback;
	const b = points[index + 1] ?? a;
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
