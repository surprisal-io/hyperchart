import { useEffect, useMemo, useRef, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import type { RoutedEdgeData } from "../types.js";
import {
	EDGE_LABEL_BG,
	EDGE_LABEL_STROKE,
	EDGE_LABEL_TEXT,
	EDGE_NEUTRAL_COLOR,
	EDGE_RUNNING_COLOR,
	edgeMotionPoints,
	routeLabelPoint,
	routedEdgePoints,
	routedPolylinePath,
} from "./edgeRouting.js";

function RunningEdgeMarker({ points }: { points: Array<{ x: number; y: number }> }) {
	const markerRef = useRef<HTMLDivElement>(null);
	const [reduceMotion, setReduceMotion] = useState(false);
	const [canAnimate, setCanAnimate] = useState(false);
	const initial = points[0] ?? { x: 0, y: 0 };

	useEffect(() => {
		setCanAnimate(typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.animate === "function");
		if (globalThis.matchMedia === undefined) return;
		const media = globalThis.matchMedia("(prefers-reduced-motion: reduce)");
		const update = () => setReduceMotion(media.matches);
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);

	useEffect(() => {
		const marker = markerRef.current;
		if (marker === null || points.length < 2 || reduceMotion || !canAnimate) return;
		const lastIndex = points.length - 1;
		const animation = marker.animate(
			points.map((point, index) => {
				const progress = index / lastIndex;
				return {
					transform: `translate3d(${point.x}px, ${point.y}px, 0)`,
					opacity: progress < 0.08 || progress > 0.92 ? 0 : 1,
					offset: progress,
				};
			}),
			{ duration: 1_600, easing: "linear", iterations: Number.POSITIVE_INFINITY },
		);
		return () => animation.cancel();
	}, [canAnimate, points, reduceMotion]);

	if (reduceMotion || !canAnimate) return null;
	return (
		<EdgeLabelRenderer>
			<div
				ref={markerRef}
				aria-hidden="true"
				data-hyperchart-running-edge-marker
				style={{
					position: "absolute",
					left: 0,
					top: 0,
					width: 8,
					height: 8,
					marginLeft: -4,
					marginTop: -4,
					boxSizing: "border-box",
					border: "2px solid var(--bg-primary)",
					borderRadius: "9999px",
					background: EDGE_RUNNING_COLOR,
					opacity: 0,
					pointerEvents: "none",
					transform: `translate3d(${initial.x}px, ${initial.y}px, 0)`,
					willChange: "transform, opacity",
				}}
			/>
		</EdgeLabelRenderer>
	);
}

export function HyperchartTransitionEdge({
	sourceX,
	sourceY,
	targetX,
	targetY,
	markerEnd,
	label,
	style,
	data,
}: EdgeProps) {
	const points = routedEdgePoints(data);
	const dx = targetX - sourceX;
	const dy = targetY - sourceY;
	const horizontal = Math.abs(dx) >= Math.abs(dy);
	const path = points
		? routedPolylinePath(points)
		: horizontal
			? `M ${sourceX} ${sourceY} C ${sourceX + dx * 0.45} ${sourceY}, ${targetX - dx * 0.45} ${targetY}, ${targetX} ${targetY}`
			: `M ${sourceX} ${sourceY} C ${sourceX} ${sourceY + dy * 0.45}, ${targetX} ${targetY - dy * 0.45}, ${targetX} ${targetY}`;
	const labelPoint = points ? routeLabelPoint(points) : { x: (sourceX + targetX) / 2, y: (sourceY + targetY) / 2 - 8 };
	const running = (data as RoutedEdgeData | undefined)?.running === true;
	const motionPoints = useMemo(
		() => (running ? edgeMotionPoints({ sourceX, sourceY, targetX, targetY, routedPoints: points }) : []),
		[running, sourceX, sourceY, targetX, targetY, points],
	);
	return (
		<>
			<BaseEdge
				path={path}
				{...(markerEnd === undefined ? {} : { markerEnd })}
				label={label}
				labelX={labelPoint.x}
				labelY={points ? labelPoint.y - 8 : labelPoint.y}
				labelStyle={{ fill: EDGE_LABEL_TEXT, fontSize: 10, fontWeight: 700 }}
				labelBgStyle={{ fill: EDGE_LABEL_BG, stroke: EDGE_LABEL_STROKE, strokeWidth: 1 }}
				labelBgPadding={[6, 3]}
				interactionWidth={14}
				style={{ stroke: EDGE_NEUTRAL_COLOR, strokeWidth: 1.15, opacity: 0.72, ...style }}
			/>
			{running ? <RunningEdgeMarker points={motionPoints} /> : null}
		</>
	);
}
