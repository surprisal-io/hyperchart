import { BaseEdge, type EdgeProps } from "@xyflow/react";
import {
	EDGE_LABEL_BG,
	EDGE_LABEL_STROKE,
	EDGE_LABEL_TEXT,
	EDGE_NEUTRAL_COLOR,
	routeLabelPoint,
	routedEdgePoints,
	routedPolylinePath,
} from "./edgeRouting.js";

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
	return (
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
	);
}
