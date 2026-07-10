import { useMemo } from "react";
import { Controls, ReactFlow } from "@xyflow/react";
import type { HyperchartRunInfo } from "../../../types.js";
import { useHyperchartTheme } from "../../../support/theme-context.js";
import { useGraphLayout } from "./graphModel.js";
import { HyperchartStateGraphNode } from "./HyperchartStateGraphNode.js";
import { HyperchartTransitionEdge } from "./HyperchartTransitionEdge.js";

const nodeTypes = { hyperchartState: HyperchartStateGraphNode };
const edgeTypes = { transition: HyperchartTransitionEdge };

export function HyperchartGraphPreview({ run, className = "h-72" }: { run: HyperchartRunInfo; className?: string }) {
	const { resolved } = useHyperchartTheme();
	const visibleIds = useMemo(() => new Set(run.states.map((state) => state.id)), [run]);
	const graph = useGraphLayout(run, visibleIds);
	return (
		<div
			data-hyperchart-root
			data-theme={resolved}
			className={`overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] ${className}`}
		>
			<ReactFlow
				nodes={graph.nodes}
				edges={graph.edges}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				fitView
				fitViewOptions={{ padding: 0.18, minZoom: 0.25, maxZoom: 0.9 }}
				minZoom={0.12}
				maxZoom={1.4}
				nodesDraggable={false}
				panOnScroll
			>
				<Controls position="bottom-left" />
			</ReactFlow>
		</div>
	);
}
