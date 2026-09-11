import { useMemo } from "react";
import { Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import type { HyperchartInspectorDataSource, HyperchartRunInfo, HyperchartStateInfo } from "../../../types.js";
import { HyperchartStateGraphNode } from "../graph/HyperchartStateGraphNode.js";
import { graphStateIdForRuntimePath, type ActionVisitRow } from "../helpers/actionVisits.js";
import { immediateMapScopeId, stateScopeParentId } from "../helpers/scope.js";
import { stateDisplayName, stateKindMeta } from "../helpers/state.js";
import type { StateNode } from "../types.js";
import { useActionVisitHistory } from "./useActionVisitHistory.js";

const ACTION_WIDTH = 270;
const ACTION_HEIGHT = 118;
const ACTION_GAP_Y = 44;
const ACTION_HANDLES: NonNullable<StateNode["handles"]> = [
	{ id: "target-top", type: "target", position: Position.Top, x: ACTION_WIDTH / 2, y: 0, width: 1, height: 1 },
	{
		id: "source-bottom",
		type: "source",
		position: Position.Bottom,
		x: ACTION_WIDTH / 2,
		y: ACTION_HEIGHT,
		width: 1,
		height: 1,
	},
];
const WORKER_PADDING_X = 18;
const WORKER_HEADER = 38;
const WORKER_PADDING_BOTTOM = 18;
const WORKER_GAP_X = 32;
const MAP_PADDING_X = 28;
const MAP_HEADER = 54;
const MAP_PADDING_BOTTOM = 28;
const BLOCK_GAP_Y = 150;

type MapGroupNode = Node<
	Readonly<{
		state: HyperchartStateInfo;
		stateId: string;
		targetSeqId?: number;
	}>,
	"mapVisitGroup"
>;
type WorkerLaneNode = Node<Readonly<{ label: string }>, "workerLane">;
type ExecutionNode = StateNode | MapGroupNode | WorkerLaneNode;

type VisitEntry = Readonly<{
	row: ActionVisitRow;
	template?: HyperchartStateInfo;
	groupId?: string;
	groupType?: "map" | "parallel" | "actor-occurrence";
	laneScopeId?: string;
}>;

type ExecutionBlock =
	| Readonly<{ kind: "action"; entry: VisitEntry; width: number; height: number }>
	| Readonly<{
			kind: "scope";
			groupId: string;
			groupType: "map" | "parallel" | "actor-occurrence";
			cycle: number;
			entries: VisitEntry[];
			width: number;
			height: number;
	  }>;

const nodeTypes = {
	hyperchartState: HyperchartStateGraphNode,
	mapVisitGroup: MapVisitGroupNode,
	workerLane: WorkerLaneNode,
};

export function ActionVisitGraph({
	run,
	dataSource,
	selectedNodeId,
	onSelectVisit,
	onSelectState,
}: {
	run: HyperchartRunInfo;
	dataSource?: HyperchartInspectorDataSource;
	selectedNodeId?: string;
	onSelectVisit: (row: ActionVisitRow) => void;
	onSelectState: (stateId: string, nodeId: string, targetSeqId?: number) => void;
}) {
	const history = useActionVisitHistory(run, dataSource);
	const graph = useMemo(() => executionGraph(run, history.rows), [history.rows, run]);
	const rowsByNodeId = useMemo(() => new Map(history.rows.map((row) => [nodeId(row), row])), [history.rows]);

	return (
		<section
			data-hyperchart-execution
			className="relative min-h-0 flex-1 bg-[var(--bg-primary)]"
			aria-label="Hierarchical execution graph"
		>
			<div className="absolute right-3 top-3 z-10 flex items-center gap-1.5">
				{history.hasOlder && (
					<button
						type="button"
						className="min-h-8 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-secondary)] px-3 text-[10px] text-[var(--hc-cyan-text)] shadow-sm"
						disabled={history.older.loading}
						onClick={() => void history.loadOlder()}
					>
						{history.older.loading ? "Loading…" : "Older"}
					</button>
				)}
				{history.hasNewer && (
					<button
						type="button"
						className="min-h-8 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-secondary)] px-3 text-[10px] text-[var(--hc-cyan-text)] shadow-sm"
						disabled={history.newer.loading}
						onClick={() => void history.loadNewer()}
					>
						{history.newer.loading ? "Loading…" : "Newer"}
					</button>
				)}
			</div>
			<div className="sr-only" role="status" aria-live="polite">
				{history.loading ? "Loading execution graph" : `${history.rows.length} action visits loaded`}
			</div>
			{history.initialError !== undefined ? (
				<div className="grid h-full place-items-center p-8 text-sm text-[var(--danger)]">{history.initialError}</div>
			) : graph.nodes.length === 0 ? (
				<div className="grid h-full place-items-center p-8 text-sm text-[var(--text-muted)]">
					{history.loading ? "Loading execution…" : "No action visits in this window."}
				</div>
			) : (
				<ReactFlow
					key={`${run.runId}:${run.branchId ?? "main"}`}
					nodes={graph.nodes.map((node) => ({ ...node, selected: node.id === selectedNodeId }))}
					edges={graph.edges}
					nodeTypes={nodeTypes}
					fitView
					fitViewOptions={{ padding: 0.1, minZoom: 0.08, maxZoom: 0.82 }}
					minZoom={0.04}
					maxZoom={1.6}
					nodesDraggable={false}
					onNodeClick={(_, node) => {
						const row = rowsByNodeId.get(node.id);
						if (row !== undefined) {
							onSelectVisit(row);
							return;
						}
						if (node.type === "mapVisitGroup")
							onSelectState(
								String(node.data.stateId),
								node.id,
								typeof node.data.targetSeqId === "number" ? node.data.targetSeqId : undefined,
							);
					}}
				>
					<Controls position="bottom-left" />
				</ReactFlow>
			)}
		</section>
	);
}

export function executionGraph(
	run: HyperchartRunInfo,
	rows: readonly ActionVisitRow[],
): { nodes: ExecutionNode[]; edges: Edge[] } {
	const entries = executionEntries(run, rows);
	const blocks = executionBlocks(entries);
	const maxWidth = Math.max(ACTION_WIDTH, ...blocks.map((block) => block.width));
	const nodes: ExecutionNode[] = [];
	const edges: Edge[] = [];
	let y = 0;
	let previousExitIds: string[] = [];

	for (const block of blocks) {
		const x = (maxWidth - block.width) / 2;
		if (block.kind === "action") {
			const id = nodeId(block.entry.row);
			nodes.push(actionNode(block.entry, { x, y }));
			connectBlocks(edges, previousExitIds, [id]);
			previousExitIds = [id];
		} else {
			const prefix =
				block.groupType === "map" ? "map-visit" : block.groupType === "parallel" ? "parallel-visit" : "actor-visit";
			const mapNodeId = `${prefix}-${block.groupId}-${block.cycle}-${block.entries[0]?.row.invokeSeqId ?? y}`;
			const lanes = workerLanes(block.entries);
			const scopeTemplate = run.states.find((state) => state.id === block.groupId);
			const targetSeqId =
				block.groupType === "map"
					? scopeTemplate?.mapConfig?.visitHistory?.find((visit) => visit.visit === block.cycle)?.spawnSeqId
					: undefined;
			nodes.push({
				id: mapNodeId,
				type: "mapVisitGroup",
				position: { x, y },
				width: block.width,
				height: block.height,
				data: {
					state: scopeTemplate ?? { id: block.groupId, type: block.groupType, status: "pending" },
					stateId: block.groupId,
					...(targetSeqId === undefined ? {} : { targetSeqId }),
				},
				style: { width: block.width, height: block.height },
			});

			const entryIds: string[] = [];
			const exitIds: string[] = [];
			if (block.groupType === "actor-occurrence") {
				block.entries.forEach((entry, actionIndex) => {
					const id = nodeId(entry.row);
					nodes.push({
						...actionNode(entry, {
							x: MAP_PADDING_X,
							y: MAP_HEADER + actionIndex * (ACTION_HEIGHT + ACTION_GAP_Y),
						}),
						parentId: mapNodeId,
						extent: "parent",
					});
					if (actionIndex === 0) entryIds.push(id);
					if (actionIndex === block.entries.length - 1) exitIds.push(id);
					const previous = block.entries[actionIndex - 1];
					if (previous !== undefined) edges.push(executionEdge(nodeId(previous.row), id));
				});
			} else
				lanes.forEach((lane, laneIndex) => {
					const workerNodeId = `${mapNodeId}-worker-${laneIndex}`;
					const workerHeight = workerHeightFor(lane.entries.length);
					const workerWidth = ACTION_WIDTH + WORKER_PADDING_X * 2;
					nodes.push({
						id: workerNodeId,
						type: "workerLane",
						parentId: mapNodeId,
						extent: "parent",
						width: workerWidth,
						height: workerHeight,
						position: {
							x: MAP_PADDING_X + laneIndex * (workerWidth + WORKER_GAP_X),
							y: MAP_HEADER,
						},
						data: { label: workerLabel(lane.laneScopeId) },
						style: { width: workerWidth, height: workerHeight },
						selectable: false,
					});

					lane.entries.forEach((entry, actionIndex) => {
						const id = nodeId(entry.row);
						nodes.push({
							...actionNode(entry, {
								x: WORKER_PADDING_X,
								y: WORKER_HEADER + actionIndex * (ACTION_HEIGHT + ACTION_GAP_Y),
							}),
							parentId: workerNodeId,
							extent: "parent",
						});
						if (actionIndex === 0) entryIds.push(id);
						if (actionIndex === lane.entries.length - 1) exitIds.push(id);
						const previous = lane.entries[actionIndex - 1];
						if (previous !== undefined) edges.push(executionEdge(nodeId(previous.row), id));
					});
				});
			connectBlocks(edges, previousExitIds, entryIds);
			previousExitIds = exitIds;
		}
		y += block.height + BLOCK_GAP_Y;
	}
	return { nodes, edges };
}

function executionEntries(run: HyperchartRunInfo, rows: readonly ActionVisitRow[]): VisitEntry[] {
	const statesById = new Map(run.states.map((state) => [state.id, state]));
	const mapIds = new Set(run.states.filter((state) => state.type === "map").map((state) => state.id));
	return rows.map((row) => {
		const logicalStateId = row.graphStateId ?? graphStateIdForRuntimePath(run.states, row.statePath);
		const template = logicalStateId === undefined ? undefined : statesById.get(logicalStateId);
		const workerScopeId =
			template === undefined ? workerScopeFromRuntimePath(row.statePath, mapIds) : stateScopeParentId(template);
		const possibleMapId = workerScopeId === undefined ? undefined : immediateMapScopeId(workerScopeId);
		const mapId = possibleMapId !== undefined && mapIds.has(possibleMapId) ? possibleMapId : undefined;
		const authoredScope =
			mapId === undefined && template !== undefined ? authoredExecutionScopeForState(template, statesById) : undefined;
		const groupId = mapId ?? authoredScope?.groupId;
		const groupType = mapId === undefined ? authoredScope?.groupType : "map";
		const laneScopeId = mapId === undefined ? authoredScope?.laneScopeId : workerScopeId;
		return {
			row,
			...(template === undefined ? {} : { template }),
			...(groupId === undefined ? {} : { groupId }),
			...(groupType === undefined ? {} : { groupType }),
			...(laneScopeId === undefined ? {} : { laneScopeId }),
		};
	});
}

function authoredExecutionScopeForState(
	state: HyperchartStateInfo,
	statesById: ReadonlyMap<string, HyperchartStateInfo>,
): { groupId: string; groupType: "parallel" | "actor-occurrence"; laneScopeId: string } | undefined {
	let child = state;
	let parentId = stateScopeParentId(child);
	const seen = new Set<string>();
	while (parentId !== undefined && !seen.has(parentId)) {
		seen.add(parentId);
		const parent = statesById.get(parentId);
		if (parent === undefined) return undefined;
		if (parent.type === "parallel") return { groupId: parent.id, groupType: "parallel", laneScopeId: child.id };
		if (parent.type === "actor-occurrence")
			return { groupId: parent.id, groupType: "actor-occurrence", laneScopeId: parent.id };
		child = parent;
		parentId = stateScopeParentId(parent);
	}
	return undefined;
}

function executionBlocks(entries: readonly VisitEntry[]): ExecutionBlock[] {
	const provisional: Array<
		| { kind: "action"; entry: VisitEntry }
		| { kind: "scope"; groupId: string; groupType: "map" | "parallel" | "actor-occurrence"; entries: VisitEntry[] }
	> = [];
	for (const entry of entries) {
		const previous = provisional.at(-1);
		if (entry.groupId !== undefined && entry.groupType !== undefined) {
			if (previous?.kind === "scope" && previous.groupId === entry.groupId) previous.entries.push(entry);
			else provisional.push({ kind: "scope", groupId: entry.groupId, groupType: entry.groupType, entries: [entry] });
		} else provisional.push({ kind: "action", entry });
	}
	const cycles = new Map<string, number>();
	return provisional.map((block) => {
		if (block.kind === "action") return { ...block, width: ACTION_WIDTH, height: ACTION_HEIGHT };
		const cycle = (cycles.get(block.groupId) ?? 0) + 1;
		cycles.set(block.groupId, cycle);
		if (block.groupType === "actor-occurrence") {
			const width = MAP_PADDING_X * 2 + ACTION_WIDTH;
			const height =
				MAP_HEADER +
				block.entries.length * ACTION_HEIGHT +
				Math.max(0, block.entries.length - 1) * ACTION_GAP_Y +
				MAP_PADDING_BOTTOM;
			return { ...block, cycle, width, height };
		}
		const lanes = workerLanes(block.entries);
		const workerWidth = ACTION_WIDTH + WORKER_PADDING_X * 2;
		const width = MAP_PADDING_X * 2 + lanes.length * workerWidth + Math.max(0, lanes.length - 1) * WORKER_GAP_X;
		const height =
			MAP_HEADER + Math.max(...lanes.map((lane) => workerHeightFor(lane.entries.length))) + MAP_PADDING_BOTTOM;
		return { ...block, cycle, width, height };
	});
}

function workerLanes(entries: readonly VisitEntry[]): Array<{ laneScopeId: string; entries: VisitEntry[] }> {
	const lanes = new Map<string, VisitEntry[]>();
	for (const entry of entries) {
		const key = entry.laneScopeId ?? `${entry.groupId ?? "scope"}#unknown`;
		const lane = lanes.get(key);
		if (lane === undefined) lanes.set(key, [entry]);
		else lane.push(entry);
	}
	return [...lanes].map(([laneScopeId, laneEntries]) => ({ laneScopeId, entries: laneEntries }));
}

function actionNode(entry: VisitEntry, position: { x: number; y: number }): StateNode {
	const state = visitState(entry.template, entry.row);
	return {
		id: nodeId(entry.row),
		type: "hyperchartState",
		position,
		width: ACTION_WIDTH,
		height: ACTION_HEIGHT,
		handles: ACTION_HANDLES,
		style: { width: ACTION_WIDTH, height: ACTION_HEIGHT },
		data: {
			state,
			...(state.type === undefined ? {} : { displayType: state.type }),
		},
	};
}

function connectBlocks(edges: Edge[], sourceIds: readonly string[], targetIds: readonly string[]): void {
	const type = sourceIds.length > 1 || targetIds.length > 1 ? "smoothstep" : "straight";
	for (const source of sourceIds) for (const target of targetIds) edges.push(executionEdge(source, target, type));
}

function executionEdge(source: string, target: string, type: "straight" | "smoothstep" = "straight"): Edge {
	return {
		id: `execution-edge-${source}-${target}`,
		source,
		target,
		type,
		sourceHandle: "source-bottom",
		targetHandle: "target-top",
		markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
		style: { stroke: "var(--border-primary)", strokeWidth: 1.5 },
	};
}

function workerHeightFor(actionCount: number): number {
	return (
		WORKER_HEADER + actionCount * ACTION_HEIGHT + Math.max(0, actionCount - 1) * ACTION_GAP_Y + WORKER_PADDING_BOTTOM
	);
}

function workerScopeFromRuntimePath(statePath: string, mapIds: ReadonlySet<string>): string | undefined {
	for (const mapId of mapIds) {
		const prefix = `${mapId}#`;
		if (!statePath.startsWith(prefix)) continue;
		const dot = statePath.indexOf(".", prefix.length);
		return dot === -1 ? statePath : statePath.slice(0, dot);
	}
	return undefined;
}

function workerLabel(workerScopeId: string): string {
	const marker = workerScopeId.lastIndexOf("#");
	if (marker !== -1) return `worker ${workerScopeId.slice(marker + 1)}`;
	return workerScopeId.slice(workerScopeId.lastIndexOf(".") + 1);
}

function MapVisitGroupNode({ data, selected }: NodeProps<MapGroupNode>) {
	const kind = stateKindMeta(data.state);
	const KindIcon = kind.Icon;
	return (
		<div
			className={`h-full w-full cursor-pointer rounded-xl border-2 bg-cyan-500/[0.04] shadow-sm transition-[border-color,box-shadow] ${selected ? "border-blue-400 ring-2 ring-blue-500/30" : "border-cyan-500/35 hover:border-cyan-400/70"}`}
		>
			<Handle id="target-top" type="target" position={Position.Top} className="!opacity-0" />
			<div className="flex h-[54px] min-w-0 items-center gap-1.5 border-b border-cyan-500/20 px-4">
				<KindIcon className={`h-3.5 w-3.5 shrink-0 ${kind.iconClassName}`} aria-hidden="true" />
				<div
					className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-[var(--text-primary)]"
					title={data.stateId}
				>
					{stateDisplayName(data.state)}
				</div>
			</div>
			<Handle id="source-bottom" type="source" position={Position.Bottom} className="!opacity-0" />
		</div>
	);
}

function WorkerLaneNode({ data }: NodeProps<WorkerLaneNode>) {
	return (
		<div className="h-full w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-secondary)]/70">
			<div className="flex h-[38px] items-center border-b border-[var(--border-primary)] px-3 font-mono text-[10px] font-medium text-[var(--text-secondary)]">
				{data.label}
			</div>
		</div>
	);
}

function visitState(template: HyperchartStateInfo | undefined, row: ActionVisitRow): HyperchartStateInfo {
	const visit = row.visit;
	const status: HyperchartStateInfo["status"] =
		visit?.status === "unknown"
			? "unknown"
			: visit?.status === "running"
				? "running"
				: visit?.status === "failed"
					? "failed"
					: visit === undefined
						? "pending"
						: "done";
	return {
		...(template ?? {}),
		...(visit === undefined || visit.invocation.kind === "actor" ? {} : { type: visit.invocation.kind }),
		id: `${row.statePath} · cycle ${visit?.visit ?? "?"}`,
		status,
		...(visit?.startedAt === undefined ? {} : { startedAt: visit.startedAt }),
		...(visit?.endedAt === undefined ? {} : { endedAt: visit.endedAt }),
		runtimeSummary: {
			issueCount: 0,
			actorMessageCount: 0,
			hasOlderRuntime: false,
			...(template?.runtimeSummary ?? {}),
			status,
			visitCount: visit?.visit ?? 0,
		},
	};
}

function nodeId(row: ActionVisitRow): string {
	return `visit-${row.invokeSeqId}`;
}
