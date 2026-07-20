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

function samplePolyline(points: ElkPoint[], count: number): ElkPoint[] {
	const first = points[0];
	if (first === undefined || count <= 0) return [];
	if (points.length === 1 || count === 1) return [first];
	const segments = points.slice(1).map((point, index) => {
		const start = points[index] ?? first;
		return { start, end: point, length: Math.hypot(point.x - start.x, point.y - start.y) };
	});
	const totalLength = segments.reduce((total, segment) => total + segment.length, 0);
	if (totalLength === 0) return Array.from({ length: count }, () => ({ ...first }));

	return Array.from({ length: count }, (_, index) => {
		const distance = (totalLength * index) / (count - 1);
		let traversed = 0;
		for (const segment of segments) {
			if (distance <= traversed + segment.length || segment === segments.at(-1)) {
				const progress = segment.length === 0 ? 0 : (distance - traversed) / segment.length;
				return {
					x: segment.start.x + (segment.end.x - segment.start.x) * progress,
					y: segment.start.y + (segment.end.y - segment.start.y) * progress,
				};
			}
			traversed += segment.length;
		}
		return { ...first };
	});
}

function cubicPoint(t: number, start: ElkPoint, controlA: ElkPoint, controlB: ElkPoint, end: ElkPoint): ElkPoint {
	const inverse = 1 - t;
	return {
		x:
			inverse ** 3 * start.x +
			3 * inverse ** 2 * t * controlA.x +
			3 * inverse * t ** 2 * controlB.x +
			t ** 3 * end.x,
		y:
			inverse ** 3 * start.y +
			3 * inverse ** 2 * t * controlA.y +
			3 * inverse * t ** 2 * controlB.y +
			t ** 3 * end.y,
	};
}

/** Precompute graph-space transform keyframes so the browser can animate a separate HTML layer. */
export function edgeMotionPoints({
	sourceX,
	sourceY,
	targetX,
	targetY,
	routedPoints,
	count = 28,
}: {
	sourceX: number;
	sourceY: number;
	targetX: number;
	targetY: number;
	routedPoints?: ElkPoint[] | undefined;
	count?: number | undefined;
}): ElkPoint[] {
	if (routedPoints && routedPoints.length >= 2) return samplePolyline(routedPoints, count);
	const dx = targetX - sourceX;
	const dy = targetY - sourceY;
	const horizontal = Math.abs(dx) >= Math.abs(dy);
	const start = { x: sourceX, y: sourceY };
	const end = { x: targetX, y: targetY };
	const controlA = horizontal ? { x: sourceX + dx * 0.45, y: sourceY } : { x: sourceX, y: sourceY + dy * 0.45 };
	const controlB = horizontal ? { x: targetX - dx * 0.45, y: targetY } : { x: targetX, y: targetY - dy * 0.45 };
	const approximation = Array.from({ length: 65 }, (_, index) =>
		cubicPoint(index / 64, start, controlA, controlB, end),
	);
	return samplePolyline(approximation, count);
}
