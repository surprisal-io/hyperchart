import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { FolderIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { Controls, MiniMap, ReactFlow, type NodeMouseHandler } from "@xyflow/react";
import {
	formatHyperchartTime,
	hyperchartChartName,
	hyperchartRunLabel,
	summarizeHyperchartProgress,
} from "../../hyperchart-display.js";
import { DialogPortal } from "../../support/DialogPortal.js";
import { useHyperchartTheme } from "../../support/theme-context.js";
import { useMobile } from "../../support/useMobile.js";
import type { HyperchartInspectorDialogProps } from "./dialog-props.js";
import type { GraphLayout, StateNode } from "./types.js";
import { nodeMiniMapColor, useGraphLayout } from "./graph/graphModel.js";
import { HyperchartStateGraphNode } from "./graph/HyperchartStateGraphNode.js";
import { HyperchartTransitionEdge } from "./graph/HyperchartTransitionEdge.js";
import { hyperchartRunTitle, stateDisplayName } from "./helpers/state.js";
import {
	immediateMapScopeId,
	scopeStackForState,
	stateScopeParentId,
	visibleStateIdsForScope,
} from "./helpers/scope.js";
import { StatusPill } from "../ui/StatusPill.js";
import { useModalDialog } from "../../support/useModalDialog.js";
import { HyperchartInspectorSidePanel } from "./HyperchartInspectorSidePanel.js";
import { IssuesSection } from "./validation/IssuesSection.js";
import { ActionVisitGraph } from "./history/ActionVisitGraph.js";
import type { ActionVisitRow } from "./helpers/actionVisits.js";

const nodeTypes = { hyperchartState: HyperchartStateGraphNode };
const edgeTypes = { transition: HyperchartTransitionEdge };
let openInspectorCount = 0;

function usePauseBackgroundAnimations(active: boolean): void {
	useEffect(() => {
		if (!active || typeof document === "undefined") {
			return;
		}
		openInspectorCount += 1;
		document.documentElement.setAttribute("data-hyperchart-inspector-open", "");
		return () => {
			openInspectorCount = Math.max(0, openInspectorCount - 1);
			if (openInspectorCount === 0) {
				document.documentElement.removeAttribute("data-hyperchart-inspector-open");
			}
		};
	}, [active]);
}

const InspectorGraphCanvas = React.memo(function InspectorGraphCanvas({
	runId,
	graph,
	isMobile,
	miniMapMaskColor,
	miniMapBackgroundColor,
	onNodeClick,
	onNodeDoubleClick,
	onPaneClick,
}: {
	runId: string;
	graph: GraphLayout;
	isMobile: boolean;
	miniMapMaskColor: string;
	miniMapBackgroundColor: string;
	onNodeClick: NodeMouseHandler<StateNode>;
	onNodeDoubleClick: NodeMouseHandler<StateNode>;
	onPaneClick: () => void;
}) {
	return (
		<ReactFlow
			key={runId}
			nodes={graph.nodes}
			edges={graph.edges}
			nodeTypes={nodeTypes}
			edgeTypes={edgeTypes}
			defaultViewport={{ x: isMobile ? 12 : 36, y: isMobile ? 18 : 36, zoom: isMobile ? 0.82 : 0.85 }}
			fitView
			fitViewOptions={{ padding: 0.2, minZoom: 0.3, maxZoom: 1.05 }}
			minZoom={0.12}
			maxZoom={1.6}
			nodesDraggable={false}
			onNodeClick={onNodeClick}
			onNodeDoubleClick={onNodeDoubleClick}
			onPaneClick={onPaneClick}
		>
			<Controls position="bottom-left" />
			{!isMobile && graph.nodes.length > 8 && (
				<MiniMap
					pannable
					zoomable
					nodeColor={nodeMiniMapColor}
					maskColor={miniMapMaskColor}
					bgColor={miniMapBackgroundColor}
					style={{ width: 148, height: 96 }}
				/>
			)}
		</ReactFlow>
	);
});

export function HyperchartInspectorDialogInner({
	runs,
	selectedRunId,
	onSelectRun,
	onSelectBranch,
	embedded = false,
	initialCanvasMode = "structure",
	onForkBranch,
	onRewindBranch,
	onClose,
	onResume,
	onAbort,
	onSteerSession,
	historyDataSource,
	onRefreshHistory,
	historyTargetSeqId,
}: Omit<HyperchartInspectorDialogProps, "portal" | "theme">) {
	const isMobile = useMobile();
	const titleId = useId();
	const dialogRef = useRef<HTMLDivElement>(null);
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	const { resolved } = useHyperchartTheme();
	const miniMapMaskColor = resolved === "light" ? "rgba(0, 0, 0, 0.14)" : "rgba(0, 0, 0, 0.45)";
	const miniMapBackgroundColor = resolved === "light" ? "#f0f0f0" : "#1e1e1e";
	const run = useMemo(() => {
		if (selectedRunId) {
			return runs.find((candidate) => candidate.runId === selectedRunId) ?? runs[0];
		}
		return runs.find((candidate) => candidate.status === "running") ?? runs[0];
	}, [runs, selectedRunId]);
	const runRef = useRef(run);
	runRef.current = run;
	usePauseBackgroundAnimations(run !== undefined);
	useModalDialog({ dialogRef, initialFocusRef: closeButtonRef, onClose, open: run !== undefined && !embedded });
	const [selectedStateId, setSelectedStateId] = useState<string | null>(null);
	const [selectedVisit, setSelectedVisit] = useState<ActionVisitRow | null>(null);
	const [selectedExecutionNodeId, setSelectedExecutionNodeId] = useState<string | null>(null);
	const [canvasMode, setCanvasMode] = useState<"execution" | "structure">(initialCanvasMode);
	const [scopeStack, setScopeStack] = useState<string[]>([]);
	const [visibleBranches, setVisibleBranches] = useState(run?.branches ?? []);
	const [branchCursor, setBranchCursor] = useState(run?.branchListNext);
	const [branchLoadError, setBranchLoadError] = useState<string>();
	const [historySnapshot, setHistorySnapshot] = useState(run?.historySnapshot);
	const pinnedHistorySnapshot =
		historySnapshot?.branchId === (run?.branchId ?? "main") ? historySnapshot : run?.historySnapshot;
	const historyRun = useMemo(
		() =>
			run === undefined || pinnedHistorySnapshot === undefined
				? run
				: { ...run, historySnapshot: pinnedHistorySnapshot },
		[pinnedHistorySnapshot, run],
	);

	useEffect(() => {
		void run?.runId;
		setSelectedStateId(null);
		setSelectedVisit(null);
		setSelectedExecutionNodeId(null);
		setScopeStack([]);
		setVisibleBranches(run?.branches ?? []);
		setBranchCursor(run?.branchListNext);
		setBranchLoadError(undefined);
		setHistorySnapshot(run?.historySnapshot);
	}, [run?.runId, run?.branchId]);

	const currentScopeId = scopeStack.at(-1) ?? null;
	const visibleIds = useMemo(
		() => (run ? visibleStateIdsForScope(run.states, { scopeId: currentScopeId }) : new Set<string>()),
		[currentScopeId, run],
	);

	const graph = useGraphLayout(run, visibleIds);
	const focusedGraph = useMemo(
		() => ({
			...graph,
			nodes: graph.nodes.map((node) => ({ ...node, selected: node.id === selectedStateId })),
		}),
		[graph, selectedStateId],
	);
	const selectedState =
		selectedStateId && visibleIds.has(selectedStateId)
			? (run?.states.find((state) => state.id === selectedStateId) ?? null)
			: null;
	const progress = summarizeHyperchartProgress(run);
	const openScope = useCallback((stateId: string) => {
		const latestRun = runRef.current;
		const state = latestRun?.states.find((candidate) => candidate.id === stateId);
		const hasChildScope = latestRun?.states.some((candidate) => {
			const parentId = stateScopeParentId(candidate);
			return parentId === state?.id || parentId?.startsWith(`${state?.id}#`) === true;
		});
		if (!state || !hasChildScope) {
			return;
		}
		setScopeStack((prev) => [...prev, state.id]);
		setSelectedStateId(null);
		setSelectedVisit(null);
	}, []);
	const navigateToState = useCallback((stateId: string) => {
		const latestRun = runRef.current;
		if (latestRun?.states.some((state) => state.id === stateId) !== true) {
			return;
		}
		setScopeStack(scopeStackForState(latestRun.states, stateId));
		setSelectedStateId(stateId);
		setSelectedVisit(null);
	}, []);
	const selectVisit = useCallback((visit: ActionVisitRow) => {
		setSelectedVisit(visit);
		setSelectedExecutionNodeId(`visit-${visit.invokeSeqId}`);
		if (visit.graphStateId === undefined) {
			setSelectedStateId(null);
			return;
		}
		const latestRun = runRef.current;
		setScopeStack(scopeStackForState(latestRun?.states ?? [], visit.graphStateId));
		setSelectedStateId(visit.graphStateId);
	}, []);
	const selectExecutionState = useCallback((stateId: string, nodeId: string, targetSeqId?: number) => {
		const latestRun = runRef.current;
		if (latestRun?.states.some((state) => state.id === stateId) !== true) {
			return;
		}
		setScopeStack(scopeStackForState(latestRun.states, stateId));
		setSelectedStateId(stateId);
		setSelectedVisit(
			targetSeqId === undefined
				? null
				: {
						invokeSeqId: targetSeqId,
						statePath: stateId,
						graphStateId: stateId,
						originBranchId: latestRun.branchId ?? "main",
					},
		);
		setSelectedExecutionNodeId(nodeId);
	}, []);
	const clearStateSelection = useCallback(() => {
		setSelectedStateId(null);
		setSelectedVisit(null);
		setSelectedExecutionNodeId(null);
	}, []);
	const loadMoreBranches = useCallback(async () => {
		const latestRun = runRef.current;
		if (latestRun === undefined || historyDataSource === undefined || branchCursor === undefined) {
			return;
		}
		try {
			const chunk = await historyDataSource.listBranches({ runId: latestRun.runId, cursor: branchCursor });
			setVisibleBranches((current) => [
				...current,
				...chunk.items
					.filter((branch) => !current.some((candidate) => candidate.branchId === branch.branchId))
					.map((branch) => ({
						branchId: branch.branchId,
						headSeqId: branch.headSeqId,
						...(branch.metadata?.name === undefined ? {} : { name: branch.metadata.name }),
						...(branch.metadata?.reason === undefined ? {} : { reason: branch.metadata.reason }),
					})),
			]);
			setBranchCursor(chunk.next);
			setBranchLoadError(undefined);
		} catch (error) {
			setBranchLoadError(error instanceof Error ? error.message : String(error));
		}
	}, [branchCursor, historyDataSource]);
	const handleNodeClick = useCallback<NodeMouseHandler<StateNode>>((_, node) => {
		setSelectedStateId(node.id);
		setSelectedVisit(null);
		setSelectedExecutionNodeId(null);
	}, []);
	const handleNodeDoubleClick = useCallback<NodeMouseHandler<StateNode>>((_, node) => openScope(node.id), [openScope]);

	if (!run || !historyRun) {
		return null;
	}

	return (
		<DialogPortal>
			<div
				data-hyperchart-root
				data-theme={resolved}
				className={
					embedded
						? "absolute inset-0 flex"
						: `fixed inset-0 z-[70] flex ${isMobile ? "items-stretch justify-stretch p-0" : "items-center justify-center p-5"}`
				}
				data-testid="hyperchart-inspector-dialog"
			>
				{!embedded && (
					<button
						type="button"
						tabIndex={-1}
						className="absolute inset-0 cursor-default bg-[var(--bg-overlay)]"
						onClick={onClose}
						aria-label="Close hyperchart inspector"
					/>
				)}
				<div
					ref={dialogRef}
					tabIndex={-1}
					role="dialog"
					aria-modal="true"
					aria-labelledby={titleId}
					className={`relative flex w-full flex-col overflow-hidden bg-[var(--bg-secondary)] ${embedded ? "h-full border-0 shadow-none" : `border border-[var(--border-secondary)] shadow-2xl ${isMobile ? "h-[100svh] max-h-[100svh] overscroll-contain rounded-none border-0" : "h-[94vh] max-w-[1500px] rounded-2xl"}`}`}
				>
					<header
						className={`flex flex-wrap items-center gap-2 border-b border-[var(--border-primary)] py-2 ${isMobile ? "px-3" : "px-4"}`}
					>
						<FolderIcon className="h-5 w-5 text-[var(--hc-blue-text)]" aria-hidden="true" />
						<div className="min-w-0 flex-1">
							<div className="flex min-w-0 items-center gap-2">
								<span id={titleId} className="truncate text-sm font-semibold text-[var(--text-primary)]">
									{hyperchartChartName(run)}
								</span>
								<StatusPill status={run.status} />
							</div>
							{run.replayIncompatibility === undefined && (
								<div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
									<div
										className="h-full rounded-full bg-[var(--accent-blue)] transition-all"
										style={{ width: `${progress.pct}%` }}
									/>
								</div>
							)}
						</div>
						{visibleBranches.length > 0 && (
							<div className="flex items-center gap-1.5" data-testid="hyperchart-branch-navigation">
								<label className="sr-only" htmlFor={`${titleId}-branch`}>
									Branch
								</label>
								<select
									id={`${titleId}-branch`}
									value={run.branchId ?? "main"}
									onChange={(event) => onSelectBranch?.(run.runId, event.currentTarget.value)}
									className="max-w-64 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-primary)]"
									aria-label="Branch"
								>
									{visibleBranches.map((branch) => (
										<option key={branch.branchId} value={branch.branchId}>
											{branch.branchId}
											{run.runnerBranchIds?.includes(branch.branchId) === true ? " · live" : ""}
										</option>
									))}
								</select>
								{onForkBranch && run.branchId && (
									<button
										type="button"
										className="rounded border border-[var(--border-secondary)] px-2 py-1 text-xs"
										onClick={() => {
											const head = visibleBranches.find((branch) => branch.branchId === run.branchId)?.headSeqId;
											if (head === null || head === undefined) {
												return;
											}
											const branchId = window.prompt("New branch name");
											if (
												branchId &&
												window.confirm(`Create branch ${branchId} at seqId ${head}? This will not select or start it.`)
											) {
												void onForkBranch(run.runId, head, branchId);
											}
										}}
									>
										Fork…
									</button>
								)}
								{branchCursor !== undefined && historyDataSource !== undefined && (
									<button
										type="button"
										className="rounded border border-[var(--border-secondary)] px-2 py-1 text-xs"
										onClick={() => void loadMoreBranches()}
									>
										More heads…
									</button>
								)}
								{branchLoadError !== undefined && (
									<span className="text-xs text-[var(--danger)]" title={branchLoadError}>
										heads failed
									</span>
								)}
								{onRewindBranch && run.branchId && (
									<button
										type="button"
										className="rounded border border-amber-500/35 px-2 py-1 text-xs"
										onClick={() => {
											const value = window.prompt(`Move ${run.branchId} head to seqId`);
											const seqId = Number(value);
											if (
												Number.isSafeInteger(seqId) &&
												seqId > 0 &&
												window.confirm(
													`Move only branch ${run.branchId} to seqId ${seqId}? All records stay preserved.`,
												)
											) {
												void onRewindBranch(run.runId, run.branchId!, seqId);
											}
										}}
									>
										Rewind…
									</button>
								)}
							</div>
						)}
						{historyDataSource !== undefined && run.historySnapshot !== undefined && onRefreshHistory !== undefined && (
							<button
								type="button"
								className="rounded border border-[var(--border-secondary)] px-2 py-1 text-xs text-[var(--text-secondary)]"
								onClick={() => {
									setHistorySnapshot(run.historySnapshot);
									void onRefreshHistory(run.runId);
								}}
							>
								Refresh history
							</button>
						)}
						{run.status === "running" && onAbort && (
							<button
								type="button"
								onClick={onAbort}
								className="rounded border border-red-500/35 bg-red-500/10 px-2 py-1 text-xs text-[var(--hc-red-text)] hover:bg-red-500/15"
							>
								Abort
							</button>
						)}
						{run.replayIncompatibility === undefined &&
							(run.status === "failed" || run.status === "paused" || run.status === "blocked") &&
							onResume && (
								<button
									type="button"
									onClick={() => onResume(run.runId)}
									className="rounded border border-green-500/35 bg-green-500/10 px-2 py-1 text-xs text-[var(--hc-green-text)] hover:bg-green-500/15"
								>
									Resume
								</button>
							)}
						{!embedded && (
							<button
								ref={closeButtonRef}
								type="button"
								onClick={onClose}
								className={`rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ${isMobile ? "p-2" : "p-1"}`}
								aria-label="Close hyperchart inspector"
							>
								<XMarkIcon className="h-5 w-5" aria-hidden="true" />
							</button>
						)}
					</header>
					{run.replayIncompatibility !== undefined && (
						<div role="alert" className="px-4 py-2">
							<IssuesSection issues={run.issues} title="Current definition only · Runtime derivation unavailable" />
						</div>
					)}

					{runs.length > 1 && (
						<div className="flex gap-1 overflow-x-auto border-b border-[var(--border-primary)] px-3 py-2">
							{runs.slice(0, 18).map((candidate) => (
								<button
									type="button"
									key={candidate.runId}
									onClick={() => onSelectRun?.(candidate.runId)}
									className={`inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-[10px] ${candidate.runId === run.runId ? "border-blue-500/60 bg-blue-500/10 text-[var(--hc-blue-text)]" : "border-[var(--border-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}
									title={hyperchartRunTitle(candidate)}
								>
									{hyperchartRunLabel(candidate)}
								</button>
							))}
						</div>
					)}

					<div
						className={`grid min-h-0 flex-1 ${isMobile ? "grid-cols-1 grid-rows-[minmax(220px,45svh)_minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)_390px]"}`}
					>
						<main
							className={`flex min-h-0 flex-col border-[var(--border-primary)] ${isMobile ? "border-b" : "border-r"}`}
						>
							<div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-[var(--border-primary)] px-3 py-2 text-xs">
								<div className="inline-flex shrink-0 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-0.5">
									<button
										type="button"
										onClick={() => setCanvasMode("execution")}
										className={`rounded-md px-2.5 py-1 font-medium ${canvasMode === "execution" ? "bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm" : "text-[var(--text-muted)]"}`}
									>
										Execution
									</button>
									<button
										type="button"
										onClick={() => setCanvasMode("structure")}
										className={`rounded-md px-2.5 py-1 font-medium ${canvasMode === "structure" ? "bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm" : "text-[var(--text-muted)]"}`}
									>
										Structure
									</button>
								</div>
								{canvasMode === "structure" && (
									<div className="inline-flex shrink-0 items-center gap-1 rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] px-1.5 py-1 text-[11px]">
										<button
											type="button"
											onClick={() => {
												setScopeStack([]);
												setSelectedStateId(null);
											}}
											className={`rounded px-1.5 py-0.5 ${currentScopeId ? "text-[var(--hc-blue-text)] hover:bg-blue-500/10" : "text-[var(--text-primary)]"}`}
										>
											root
										</button>
										{scopeStack.map((scopeId, index) => {
											const scopeState = run.states.find((state) => state.id === scopeId);
											return (
												<React.Fragment key={scopeId}>
													<span className="text-[var(--text-muted)]">/</span>
													<button
														type="button"
														onClick={() => {
															setScopeStack(scopeStack.slice(0, index + 1));
															setSelectedStateId(null);
														}}
														className={`max-w-[180px] truncate rounded px-1.5 py-0.5 ${index === scopeStack.length - 1 ? "text-[var(--text-primary)]" : "text-[var(--hc-blue-text)] hover:bg-blue-500/10"}`}
														title={scopeId}
													>
														{scopeState ? stateDisplayName(scopeState) : scopeId}
													</button>
												</React.Fragment>
											);
										})}
									</div>
								)}
								<span className="ml-auto shrink-0 text-[11px] text-[var(--text-tertiary)]">
									updated {formatHyperchartTime(run.updatedAt)}
								</span>
							</div>
							<div className="flex min-h-0 flex-1 bg-[var(--bg-primary)]">
								{canvasMode === "execution" ? (
									<ActionVisitGraph
										run={historyRun}
										{...(historyDataSource === undefined ? {} : { dataSource: historyDataSource })}
										{...(selectedExecutionNodeId === null ? {} : { selectedNodeId: selectedExecutionNodeId })}
										onSelectVisit={selectVisit}
										onSelectState={selectExecutionState}
									/>
								) : (
									<InspectorGraphCanvas
										runId={run.runId}
										graph={focusedGraph}
										isMobile={isMobile}
										miniMapMaskColor={miniMapMaskColor}
										miniMapBackgroundColor={miniMapBackgroundColor}
										onNodeClick={handleNodeClick}
										onNodeDoubleClick={handleNodeDoubleClick}
										onPaneClick={clearStateSelection}
									/>
								)}
							</div>
						</main>
						<div className="flex min-h-0 flex-col">
							<HyperchartInspectorSidePanel
								run={historyRun}
								selectedStateId={selectedState?.id ?? null}
								onClearSelection={clearStateSelection}
								onOpenScope={openScope}
								onNavigateToState={navigateToState}
								className="flex-1"
								{...(selectedVisit === null ? {} : { selectedInvokeSeqId: selectedVisit.invokeSeqId })}
								{...(historyDataSource === undefined ? {} : { historyDataSource })}
								{...(historyTargetSeqId === undefined ? {} : { historyTargetSeqId })}
								{...(onSteerSession === undefined
									? {}
									: {
											onSteerSession: (actionKey: string, message: string) =>
												onSteerSession(run.runId, actionKey, message),
										})}
							/>
						</div>
					</div>
				</div>
			</div>
		</DialogPortal>
	);
}
