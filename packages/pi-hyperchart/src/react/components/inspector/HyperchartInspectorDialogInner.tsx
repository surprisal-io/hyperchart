import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { FolderIcon, EyeIcon, EyeSlashIcon, XMarkIcon } from "@heroicons/react/24/outline";
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
import { immediateMapScopeId, visibleStateIdsForScope } from "./helpers/scope.js";
import { StatusPill } from "../ui/StatusPill.js";
import { useModalDialog } from "../../support/useModalDialog.js";
import { HyperchartInspectorSidePanel } from "./HyperchartInspectorSidePanel.js";

const nodeTypes = { hyperchartState: HyperchartStateGraphNode };
const edgeTypes = { transition: HyperchartTransitionEdge };
let openInspectorCount = 0;

function usePauseBackgroundAnimations(active: boolean): void {
	useEffect(() => {
		if (!active || typeof document === "undefined") return;
		openInspectorCount += 1;
		document.documentElement.setAttribute("data-hyperchart-inspector-open", "");
		return () => {
			openInspectorCount = Math.max(0, openInspectorCount - 1);
			if (openInspectorCount === 0) document.documentElement.removeAttribute("data-hyperchart-inspector-open");
		};
	}, [active]);
}

const InspectorGraphCanvas = React.memo(function InspectorGraphCanvas({
	runId,
	graph,
	isMobile,
	miniMapMaskColor,
	onNodeClick,
	onNodeDoubleClick,
}: {
	runId: string;
	graph: GraphLayout;
	isMobile: boolean;
	miniMapMaskColor: string;
	onNodeClick: NodeMouseHandler<StateNode>;
	onNodeDoubleClick: NodeMouseHandler<StateNode>;
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
			fitViewOptions={{ padding: 0.2, minZoom: 0.45, maxZoom: 1.05 }}
			minZoom={0.12}
			maxZoom={1.6}
			nodesDraggable={false}
			onNodeClick={onNodeClick}
			onNodeDoubleClick={onNodeDoubleClick}
		>
			<Controls position="bottom-left" />
			{!isMobile && <MiniMap pannable zoomable nodeColor={nodeMiniMapColor} maskColor={miniMapMaskColor} />}
		</ReactFlow>
	);
});

export function HyperchartInspectorDialogInner({
	runs,
	selectedRunId,
	onSelectRun,
	onClose,
	onResume,
	onAbort,
}: Omit<HyperchartInspectorDialogProps, "portal" | "theme">) {
	const isMobile = useMobile();
	const titleId = useId();
	const dialogRef = useRef<HTMLDivElement>(null);
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	const { resolved } = useHyperchartTheme();
	const miniMapMaskColor = resolved === "light" ? "rgba(0, 0, 0, 0.14)" : "rgba(0, 0, 0, 0.45)";
	const run = useMemo(() => {
		if (selectedRunId) return runs.find((candidate) => candidate.runId === selectedRunId) ?? runs[0];
		return runs.find((candidate) => candidate.status === "running") ?? runs[0];
	}, [runs, selectedRunId]);
	const runRef = useRef(run);
	runRef.current = run;
	usePauseBackgroundAnimations(run !== undefined);
	useModalDialog({ dialogRef, initialFocusRef: closeButtonRef, onClose, open: run !== undefined });
	const [selectedStateId, setSelectedStateId] = useState<string | null>(null);
	const [showDone, setShowDone] = useState(true);
	const [showPending, setShowPending] = useState(true);
	const [showSkipped, setShowSkipped] = useState(false);
	const [showMapWorkers, setShowMapWorkers] = useState(false);
	const [scopeStack, setScopeStack] = useState<string[]>([]);

	useEffect(() => {
		void run?.runId;
		setSelectedStateId(null);
		setScopeStack([]);
	}, [run?.runId]);

	const currentScopeId = scopeStack.at(-1) ?? null;
	const visibleIds = useMemo(
		() =>
			run
				? visibleStateIdsForScope(run.states, {
						scopeId: currentScopeId,
						showDone,
						showPending,
						showSkipped,
						showMapWorkers,
					})
				: new Set<string>(),
		[currentScopeId, run, showDone, showPending, showSkipped, showMapWorkers],
	);

	const graph = useGraphLayout(run, visibleIds);
	const selectedState =
		selectedStateId && visibleIds.has(selectedStateId)
			? (run?.states.find((state) => state.id === selectedStateId) ?? null)
			: null;
	const progress = summarizeHyperchartProgress(run);
	const openScope = useCallback((stateId: string) => {
		const latestRun = runRef.current;
		const state = latestRun?.states.find((candidate) => candidate.id === stateId);
		const hasChildScope = latestRun?.states.some((candidate) => immediateMapScopeId(candidate.id) === state?.id);
		if (!state || !hasChildScope) return;
		setScopeStack((prev) => [...prev, state.id]);
		setSelectedStateId(null);
	}, []);
	const handleNodeClick = useCallback<NodeMouseHandler<StateNode>>((_, node) => setSelectedStateId(node.id), []);
	const handleNodeDoubleClick = useCallback<NodeMouseHandler<StateNode>>((_, node) => openScope(node.id), [openScope]);

	if (!run) return null;

	return (
		<DialogPortal>
			<div
				data-hyperchart-root
				data-theme={resolved}
				className={`fixed inset-0 z-[70] flex ${isMobile ? "items-stretch justify-stretch p-0" : "items-center justify-center p-5"}`}
				data-testid="hyperchart-inspector-dialog"
			>
				<button
					type="button"
					tabIndex={-1}
					className="absolute inset-0 cursor-default bg-[var(--bg-overlay)]"
					onClick={onClose}
					aria-label="Close hyperchart inspector"
				/>
				<div
					ref={dialogRef}
					tabIndex={-1}
					role="dialog"
					aria-modal="true"
					aria-labelledby={titleId}
					className={`relative flex w-full flex-col overflow-hidden border border-[var(--border-secondary)] bg-[var(--bg-secondary)] shadow-2xl ${isMobile ? "h-[100svh] max-h-[100svh] overscroll-contain rounded-none border-0" : "h-[94vh] max-w-[1500px] rounded-2xl"}`}
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
							<div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
								<div
									className="h-full rounded-full bg-[var(--accent-blue)] transition-all"
									style={{ width: `${progress.pct}%` }}
								/>
							</div>
						</div>
						{run.status === "running" && onAbort && (
							<button
								type="button"
								onClick={onAbort}
								className="rounded border border-red-500/35 bg-red-500/10 px-2 py-1 text-xs text-[var(--hc-red-text)] hover:bg-red-500/15"
							>
								Abort
							</button>
						)}
						{(run.status === "failed" || run.status === "paused" || run.status === "blocked") && onResume && (
							<button
								type="button"
								onClick={() => onResume(run.runId)}
								className="rounded border border-green-500/35 bg-green-500/10 px-2 py-1 text-xs text-[var(--hc-green-text)] hover:bg-green-500/15"
							>
								Resume
							</button>
						)}
						<button
							ref={closeButtonRef}
							type="button"
							onClick={onClose}
							className={`rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ${isMobile ? "p-2" : "p-1"}`}
							aria-label="Close hyperchart inspector"
						>
							<XMarkIcon className="h-5 w-5" aria-hidden="true" />
						</button>
					</header>

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
								<button
									type="button"
									onClick={() => setShowDone((value) => !value)}
									className={`inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 ${showDone ? "border-green-500/35 bg-green-500/10 text-[var(--hc-green-text)]" : "border-[var(--border-secondary)] text-[var(--text-secondary)]"}`}
								>
									{showDone ? (
										<EyeIcon className="h-3 w-3" aria-hidden="true" />
									) : (
										<EyeSlashIcon className="h-3 w-3" aria-hidden="true" />
									)}{" "}
									done
								</button>
								<button
									type="button"
									onClick={() => setShowPending((value) => !value)}
									className={`inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 ${showPending ? "border-purple-500/35 bg-purple-500/10 text-[var(--hc-purple-text)]" : "border-[var(--border-secondary)] text-[var(--text-secondary)]"}`}
								>
									{showPending ? (
										<EyeIcon className="h-3 w-3" aria-hidden="true" />
									) : (
										<EyeSlashIcon className="h-3 w-3" aria-hidden="true" />
									)}{" "}
									pending
								</button>
								<button
									type="button"
									onClick={() => setShowSkipped((value) => !value)}
									className={`inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 ${showSkipped ? "border-[var(--border-secondary)] text-[var(--text-secondary)]" : "border-[var(--border-secondary)] text-[var(--text-muted)]"}`}
								>
									{showSkipped ? (
										<EyeIcon className="h-3 w-3" aria-hidden="true" />
									) : (
										<EyeSlashIcon className="h-3 w-3" aria-hidden="true" />
									)}{" "}
									skipped
								</button>
								<button
									type="button"
									onClick={() => setShowMapWorkers((value) => !value)}
									className={`inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 ${showMapWorkers ? "border-cyan-500/35 bg-cyan-500/10 text-[var(--hc-cyan-text)]" : "border-[var(--border-secondary)] text-[var(--text-muted)]"}`}
								>
									{showMapWorkers ? (
										<EyeIcon className="h-3 w-3" aria-hidden="true" />
									) : (
										<EyeSlashIcon className="h-3 w-3" aria-hidden="true" />
									)}{" "}
									map workers
								</button>
								<button
									type="button"
									onClick={() => {
										setShowDone(true);
										setShowPending(true);
										setShowSkipped(true);
										setShowMapWorkers(true);
									}}
									className="shrink-0 rounded border border-[var(--border-secondary)] px-2 py-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
								>
									show all
								</button>
								<span className="ml-auto shrink-0 text-[11px] text-[var(--text-tertiary)]">
									updated {formatHyperchartTime(run.updatedAt)}
								</span>
							</div>
							<div className="min-h-0 flex-1 bg-[var(--bg-primary)]">
								<InspectorGraphCanvas
									runId={run.runId}
									graph={graph}
									isMobile={isMobile}
									miniMapMaskColor={miniMapMaskColor}
									onNodeClick={handleNodeClick}
									onNodeDoubleClick={handleNodeDoubleClick}
								/>
							</div>
						</main>
						<HyperchartInspectorSidePanel
							run={run}
							selectedStateId={selectedState?.id ?? null}
							onOpenScope={openScope}
						/>
					</div>
				</div>
			</div>
		</DialogPortal>
	);
}
