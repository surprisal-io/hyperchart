import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ElkConstructor, { type ElkNode, type ElkPoint } from "elkjs/lib/elk.bundled.js";
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { HyperchartRunInfo, HyperchartStateInfo, HyperchartStateType } from "../../../types.js";
import type { ElkLayoutEngine, GraphLayout, NodePosition, StateNode } from "../types.js";
import { EDGE_NEUTRAL_COLOR, EDGE_RUNNING_COLOR, routedEdgePoints } from "./edgeRouting.js";
import { fanoutStatusSummary } from "../helpers/fanout.js";
import { childPreviewForState, effectiveDisplayType } from "../helpers/scope.js";
import {
	compactRuntimeFacts,
	compactTriageFacts,
	stateMechanismLabel,
	validationRetryLabel,
} from "../helpers/state.js";
import { graphInput } from "./graphInput.js";

export const GRAPH_COMPACT_NODE_WIDTH = 270;
export const GRAPH_COMPACT_NODE_HEIGHT = 118;
export const GRAPH_MAP_NODE_WIDTH = 320;
export const GRAPH_MAP_NODE_HEIGHT = 154;
export const GRAPH_PARALLEL_NODE_WIDTH = 320;
export const GRAPH_PARALLEL_NODE_HEIGHT = 142;

const elk = new (ElkConstructor as unknown as { new (): ElkLayoutEngine })();

export function graphNodeSize(state: { type?: HyperchartStateType | undefined }): { width: number; height: number } {
	switch (state.type ?? "agent") {
		case "map":
			return { width: GRAPH_MAP_NODE_WIDTH, height: GRAPH_MAP_NODE_HEIGHT };
		case "parallel":
			return { width: GRAPH_PARALLEL_NODE_WIDTH, height: GRAPH_PARALLEL_NODE_HEIGHT };
		default:
			return { width: GRAPH_COMPACT_NODE_WIDTH, height: GRAPH_COMPACT_NODE_HEIGHT };
	}
}

function graphNodeHeight(state: { type?: HyperchartStateType | undefined }): number {
	return graphNodeSize(state).height;
}

type ElkEdgeRoute = Map<string, ElkPoint[]>;
type PortSide = "top" | "bottom" | "left" | "right";

function elkPortId(nodeId: string, side: PortSide): string {
	return `${nodeId}::${side}`;
}

function reactFlowHandleId(kind: "source" | "target", side: PortSide): string {
	return `${kind}-${side}`;
}

function elkPortSide(side: PortSide): string {
	switch (side) {
		case "top":
			return "NORTH";
		case "bottom":
			return "SOUTH";
		case "left":
			return "WEST";
		case "right":
			return "EAST";
	}
}

type StateTransitionEdge = { source: string; target: string; labels: string[] };

function edgePortSides(
	edge: StateTransitionEdge,
	input: ReturnType<typeof graphInput>,
): { source: PortSide; target: PortSide } {
	const sourceIndex = input.stateOrder.get(edge.source) ?? 0;
	const targetIndex = input.stateOrder.get(edge.target) ?? 0;
	if (targetIndex > sourceIndex) return { source: "bottom", target: "top" };
	if (targetIndex < sourceIndex) return { source: "left", target: "left" };
	return { source: "right", target: "left" };
}

function visualTransitionEdgeId(edge: StateTransitionEdge): string {
	const label = edge.labels.join(" / ");
	return label ? `${edge.source}->${edge.target}:${label}` : `${edge.source}->${edge.target}`;
}

function fallbackPositions(states: HyperchartStateInfo[]): Map<string, NodePosition> {
	const positions = new Map<string, NodePosition>();
	let y = 36;
	for (const state of states) {
		positions.set(state.id, { x: 36, y });
		y += graphNodeHeight(state) + 74;
	}
	return positions;
}

function nodesFromPositions(
	input: ReturnType<typeof graphInput>,
	positions: Map<string, NodePosition>,
	allStates: HyperchartStateInfo[],
	snapshotAt?: number,
): StateNode[] {
	return input.visibleStates.map((state) => {
		const displayType = effectiveDisplayType(state, input.stateById);
		const childPreview = childPreviewForState(state, allStates, input.stateById);
		const size = graphNodeSize({ type: displayType ?? state.type });
		return {
			id: state.id,
			type: "hyperchartState",
			position: positions.get(state.id) ?? { x: 36, y: 36 },
			width: size.width,
			height: size.height,
			// Controlled React Flow updates otherwise discard the measured size and handle bounds.
			// Nodes remain visible from width/height, but their edges disappear until ResizeObserver runs again.
			measured: { width: size.width, height: size.height },
			data: {
				state,
				...(displayType === undefined ? {} : { displayType }),
				...(childPreview === undefined ? {} : { childPreview }),
				...(state.status !== "running" || snapshotAt === undefined ? {} : { snapshotAt }),
			},
		};
	});
}

export function graphLayoutSignature(run: HyperchartRunInfo, visibleIds: Set<string>): string {
	const input = graphInput(run, visibleIds);
	return JSON.stringify({
		runId: run.runId,
		nodes: input.visibleStates.map((state) => ({
			id: state.id,
			type: effectiveDisplayType(state, input.stateById) ?? state.type ?? "agent",
		})),
		edges: input.useStateTransitions ? input.transitionEdges : [],
	});
}

export function buildGraph(
	run: HyperchartRunInfo,
	visibleIds: Set<string>,
	layoutPositions?: Map<string, NodePosition>,
	layoutRoutes?: ElkEdgeRoute,
): GraphLayout {
	const input = graphInput(run, visibleIds);
	const positions = layoutPositions ?? fallbackPositions(input.visibleStates);
	const nodes = nodesFromPositions(input, positions, run.states, run.updatedAt);
	const edges: Edge[] = [];
	if (input.useStateTransitions) {
		for (const edge of input.transitionEdges) {
			const sourceState = input.stateById.get(edge.source);
			const sides = edgePortSides(edge, input);
			const label = edge.labels.join(" / ");
			const edgeId = visualTransitionEdgeId(edge);
			const running = sourceState?.status === "running";
			const routedPoints = layoutRoutes?.get(edgeId);
			edges.push({
				id: edgeId,
				source: edge.source,
				target: edge.target,
				sourceHandle: reactFlowHandleId("source", sides.source),
				targetHandle: reactFlowHandleId("target", sides.target),
				type: "transition",
				label,
				markerEnd: {
					type: MarkerType.ArrowClosed,
					color: running ? EDGE_RUNNING_COLOR : EDGE_NEUTRAL_COLOR,
					width: 12,
					height: 12,
				},
				style: {
					stroke: running ? EDGE_RUNNING_COLOR : EDGE_NEUTRAL_COLOR,
					strokeWidth: running ? 1.6 : 1.15,
					opacity: 0.72,
				},
				data: routedPoints === undefined && !running ? undefined : { points: routedPoints, running },
			} as Edge);
		}
		return { nodes, edges };
	}
	return { nodes, edges };
}

async function buildElkGraph(run: HyperchartRunInfo, visibleIds: Set<string>): Promise<GraphLayout> {
	const input = graphInput(run, visibleIds);
	const layoutEdges = input.useStateTransitions ? input.transitionEdges : [];
	const graph: ElkNode = {
		id: "hyperchart-root",
		layoutOptions: {
			"elk.algorithm": "layered",
			"elk.direction": "DOWN",
			"elk.edgeRouting": "ORTHOGONAL",
			"elk.spacing.nodeNode": "56",
			"elk.spacing.edgeNode": "32",
			"elk.spacing.edgeEdge": "18",
			"elk.layered.spacing.nodeNodeBetweenLayers": "86",
			"elk.layered.spacing.edgeNodeBetweenLayers": "32",
			"elk.layered.spacing.edgeEdgeBetweenLayers": "18",
			"elk.layered.cycleBreaking.strategy": "GREEDY",
			"elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
			"elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
			"elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
		},
		children: input.visibleStates.map((state) => {
			const displayType = effectiveDisplayType(state, input.stateById);
			const size = graphNodeSize({ type: displayType ?? state.type });
			return {
				id: state.id,
				width: size.width,
				height: size.height,
				layoutOptions: { "elk.portConstraints": "FIXED_POS" },
				ports: [
					{
						id: elkPortId(state.id, "top"),
						x: size.width / 2,
						y: 0,
						width: 1,
						height: 1,
						layoutOptions: { "elk.port.side": elkPortSide("top") },
					},
					{
						id: elkPortId(state.id, "bottom"),
						x: size.width / 2,
						y: size.height,
						width: 1,
						height: 1,
						layoutOptions: { "elk.port.side": elkPortSide("bottom") },
					},
					{
						id: elkPortId(state.id, "left"),
						x: 0,
						y: size.height / 2,
						width: 1,
						height: 1,
						layoutOptions: { "elk.port.side": elkPortSide("left") },
					},
					{
						id: elkPortId(state.id, "right"),
						x: size.width,
						y: size.height / 2,
						width: 1,
						height: 1,
						layoutOptions: { "elk.port.side": elkPortSide("right") },
					},
				],
			};
		}),
		edges: layoutEdges.map((edge) => {
			const sides = edgePortSides(edge, input);
			return {
				id: visualTransitionEdgeId(edge),
				sources: [elkPortId(edge.source, sides.source)],
				targets: [elkPortId(edge.target, sides.target)],
			};
		}),
	};
	const laidOut = await elk.layout(graph);
	const positions = new Map<string, NodePosition>();
	for (const child of laidOut.children ?? []) {
		positions.set(child.id, { x: child.x ?? 36, y: child.y ?? 36 });
	}
	const routes: ElkEdgeRoute = new Map();
	for (const edge of laidOut.edges ?? []) {
		const section = edge.sections?.[0];
		if (!edge.id || !section) continue;
		routes.set(edge.id, [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]);
	}
	return buildGraph(run, visibleIds, positions, routes);
}

function positionsFromGraph(graph: GraphLayout): Map<string, NodePosition> {
	return new Map(graph.nodes.map((node) => [node.id, node.position]));
}

function routesFromGraph(graph: GraphLayout): ElkEdgeRoute {
	const routes: ElkEdgeRoute = new Map();
	for (const edge of graph.edges) {
		const points = routedEdgePoints(edge.data);
		if (points) routes.set(edge.id, points);
	}
	return routes;
}

function positionsForUpdatedGraph(previous: GraphLayout, fallback: GraphLayout): Map<string, NodePosition> {
	const positions = positionsFromGraph(fallback);
	for (const node of previous.nodes) {
		if (positions.has(node.id)) positions.set(node.id, node.position);
	}
	return positions;
}

function nodeVisualSignature(node: StateNode): string {
	const state = node.data.state;
	const displayState = node.data.displayType ? { ...state, type: node.data.displayType } : state;
	const validationLabel = validationRetryLabel(state);
	return JSON.stringify({
		id: state.id,
		type: displayState.type,
		status: state.status,
		startedAt: state.startedAt,
		endedAt: state.endedAt,
		mechanism: stateMechanismLabel(displayState),
		runtimeChips: compactRuntimeFacts(state).slice(0, 2),
		triageChips: compactTriageFacts(state, validationLabel).slice(0, 2),
		fanout: fanoutStatusSummary(displayState),
	});
}

function sameNode(left: StateNode, right: StateNode): boolean {
	return (
		left.id === right.id &&
		left.type === right.type &&
		left.position.x === right.position.x &&
		left.position.y === right.position.y &&
		left.width === right.width &&
		left.height === right.height &&
		left.measured?.width === right.measured?.width &&
		left.measured?.height === right.measured?.height &&
		nodeVisualSignature(left) === nodeVisualSignature(right)
	);
}

/** Preserve React Flow element identities when a fresh host snapshot has no visual changes. */
export function reconcileGraphElements(previous: GraphLayout, next: GraphLayout): GraphLayout {
	const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));
	let nodesChanged = previous.nodes.length !== next.nodes.length;
	const nodes = next.nodes.map((node, index) => {
		const candidate = previousNodes.get(node.id);
		const reconciled = candidate !== undefined && sameNode(candidate, node) ? candidate : node;
		if (previous.nodes[index] !== reconciled) nodesChanged = true;
		return reconciled;
	});

	const previousEdges = new Map(previous.edges.map((edge) => [edge.id, edge]));
	let edgesChanged = previous.edges.length !== next.edges.length;
	const edges = next.edges.map((edge, index) => {
		const candidate = previousEdges.get(edge.id);
		const reconciled = candidate !== undefined && JSON.stringify(candidate) === JSON.stringify(edge) ? candidate : edge;
		if (previous.edges[index] !== reconciled) edgesChanged = true;
		return reconciled;
	});

	if (!nodesChanged && !edgesChanged) return previous;
	return {
		nodes: nodesChanged ? nodes : previous.nodes,
		edges: edgesChanged ? edges : previous.edges,
	};
}

export function useGraphLayout(run: HyperchartRunInfo | null | undefined, visibleIds: Set<string>): GraphLayout {
	const fallback = useMemo(() => (run ? buildGraph(run, visibleIds) : { nodes: [], edges: [] }), [run, visibleIds]);
	const signature = useMemo(() => (run ? graphLayoutSignature(run, visibleIds) : ""), [run, visibleIds]);
	const [graph, setGraph] = useState<GraphLayout>(fallback);
	const graphRef = useRef(graph);
	const fallbackRef = useRef(fallback);
	const layoutInputRef = useRef({ run, visibleIds });
	layoutInputRef.current = { run, visibleIds };

	useEffect(() => {
		graphRef.current = graph;
	}, [graph]);

	useEffect(() => {
		fallbackRef.current = fallback;
	}, [fallback]);

	useLayoutEffect(() => {
		if (!run) {
			const empty = { nodes: [], edges: [] };
			graphRef.current = empty;
			setGraph(empty);
			return;
		}
		const previous = graphRef.current;
		if (previous.nodes.length === 0) {
			graphRef.current = fallback;
			setGraph(fallback);
			return;
		}
		const next = reconcileGraphElements(
			previous,
			buildGraph(run, visibleIds, positionsForUpdatedGraph(previous, fallback), routesFromGraph(previous)),
		);
		if (next === previous) return;
		graphRef.current = next;
		setGraph(next);
	}, [fallback, run, visibleIds]);

	useEffect(() => {
		let cancelled = false;
		const requested = layoutInputRef.current;
		if (!requested.run)
			return () => {
				cancelled = true;
			};
		buildElkGraph(requested.run, requested.visibleIds)
			.then((layoutGraph) => {
				if (cancelled) return;
				const latest = layoutInputRef.current;
				if (!latest.run || graphLayoutSignature(latest.run, latest.visibleIds) !== signature) return;
				const previous = graphRef.current;
				const next = reconcileGraphElements(
					previous,
					buildGraph(latest.run, latest.visibleIds, positionsFromGraph(layoutGraph), routesFromGraph(layoutGraph)),
				);
				if (next === previous) return;
				graphRef.current = next;
				setGraph(next);
			})
			.catch(() => {
				if (!cancelled && graphRef.current.nodes.length === 0) setGraph(fallbackRef.current);
			});
		return () => {
			cancelled = true;
		};
	}, [signature]);
	return graph;
}

export function nodeMiniMapColor(node: Node): string {
	const state = (node.data as Partial<StateNode["data"]>).state;
	if (!state) return EDGE_NEUTRAL_COLOR;
	switch (state.status) {
		case "running":
			return EDGE_RUNNING_COLOR;
		case "done":
			return "var(--accent-green)";
		case "failed":
			return "var(--accent-red)";
		case "stale":
			return "var(--accent-yellow)";
		case "skipped":
			return EDGE_NEUTRAL_COLOR;
		default:
			return "var(--accent-purple)";
	}
}
