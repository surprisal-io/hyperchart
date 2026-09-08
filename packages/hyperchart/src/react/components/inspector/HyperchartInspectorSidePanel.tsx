import { useEffect, useMemo, useState } from "react";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import type { HyperchartInspectorDataSource, HyperchartRunInfo } from "../../types.js";
import { useHyperchartTheme } from "../../support/theme-context.js";
import { immediateMapScopeId, stateScopeParentId } from "./helpers/scope.js";
import { RunOverview } from "./details/RunOverview.js";
import { StateDetails } from "./details/StateDetails.js";

export interface HyperchartInspectorSidePanelProps {
	run: HyperchartRunInfo;
	selectedStateId?: string | null;
	onClearSelection?: () => void;
	onOpenScope?: (stateId: string) => void;
	onNavigateToState?: (stateId: string) => void;
	onSteerSession?: (actionKey: string, message: string) => void | Promise<void>;
	className?: string;
	definitionSource?: string;
	historyDataSource?: HyperchartInspectorDataSource;
	historyTargetSeqId?: number;
	/** Exact visit selected by the Inspector chronology, including embedded snapshots. */
	selectedInvokeSeqId?: number;
}

export function HyperchartInspectorSidePanel({
	run,
	selectedStateId = null,
	onClearSelection,
	onOpenScope,
	onNavigateToState,
	onSteerSession,
	className = "",
	definitionSource,
	historyDataSource,
	historyTargetSeqId,
	selectedInvokeSeqId,
}: HyperchartInspectorSidePanelProps) {
	const { resolved } = useHyperchartTheme();
	const selectedState = selectedStateId ? (run.states.find((state) => state.id === selectedStateId) ?? null) : null;
	const [highlightedReply, setHighlightedReply] = useState<{ stateId: string; path: string } | null>(null);
	const [highlightedArtifact, setHighlightedArtifact] = useState<{ stateId: string; name: string } | null>(null);
	const [highlightedInputName, setHighlightedInputName] = useState<string | null>(null);
	const [highlightedRefValue, setHighlightedRefValue] = useState<string | null>(null);
	const [revealedReplyStateIds, setRevealedReplyStateIds] = useState<string[]>([]);
	const [revealedArtifactStateIds, setRevealedArtifactStateIds] = useState<string[]>([]);
	useEffect(() => {
		void run.runId;
		void selectedStateId;
		setHighlightedReply(null);
		setHighlightedArtifact(null);
		setHighlightedInputName(null);
		setHighlightedRefValue(null);
		setRevealedReplyStateIds([]);
		setRevealedArtifactStateIds([]);
	}, [run.runId, selectedStateId]);
	useEffect(() => {
		if (highlightedReply === null && highlightedArtifact === null && highlightedInputName === null && highlightedRefValue === null) return;
		const timeout = window.setTimeout(() => {
			setHighlightedReply(null);
			setHighlightedArtifact(null);
			setHighlightedInputName(null);
			setHighlightedRefValue(null);
		}, 5_000);
		return () => window.clearTimeout(timeout);
	}, [highlightedReply, highlightedArtifact, highlightedInputName, highlightedRefValue]);
	const scopeChildIds = useMemo(() => {
		const ids = new Set<string>();
		for (const state of run.states) {
			const parentId = stateScopeParentId(state);
			if (parentId === undefined) continue;
			ids.add(parentId);
			const mapId = immediateMapScopeId(parentId);
			if (mapId !== undefined) ids.add(mapId);
		}
		return ids;
	}, [run]);
	const effectiveDefinitionSource = definitionSource ?? (selectedState === null ? run.definitionSource : selectedState.definitionSource);
	const scopeProps = onOpenScope
		? { onOpenScope, canOpenScope: selectedState ? scopeChildIds.has(selectedState.id) : false }
		: {};
	return (
		<aside
			data-hyperchart-root
			data-theme={resolved}
			style={{ paddingRight: "1.5rem", scrollbarGutter: "stable" }}
			className={`min-h-0 overflow-y-auto overscroll-contain p-2 [-webkit-overflow-scrolling:touch] md:p-3 ${className}`}
		>
			{selectedState ? (
				<>
					{onClearSelection && (
						<button
							type="button"
							onClick={onClearSelection}
							className="mb-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-[var(--hc-blue-text)] hover:bg-blue-500/10"
						>
							<ArrowLeftIcon className="h-3.5 w-3.5" aria-hidden="true" />
							Chart overview
						</button>
					)}
					<StateDetails
						key={`${run.runId}:${selectedState.id}`}
						state={selectedState}
						allStates={run.states}
						{...(effectiveDefinitionSource === undefined ? {} : { definitionSource: effectiveDefinitionSource })}
						{...(onNavigateToState === undefined ? {} : { onNavigateToState })}
						highlightedReply={highlightedReply}
						highlightedArtifact={highlightedArtifact}
						revealedReplyStateIds={revealedReplyStateIds}
						revealedArtifactStateIds={revealedArtifactStateIds}
						onHighlightReply={(stateId, path) => {
							setHighlightedReply({ stateId, path });
							setRevealedReplyStateIds((stateIds) =>
								stateIds.includes(stateId) ? stateIds : [...stateIds, stateId],
							);
							setHighlightedArtifact(null);
							setHighlightedInputName(null);
							setHighlightedRefValue(null);
						}}
						onHighlightArtifact={(stateId, name) => {
							setHighlightedArtifact({ stateId, name });
							setRevealedArtifactStateIds((stateIds) => stateIds.includes(stateId) ? stateIds : [...stateIds, stateId]);
							setHighlightedReply(null);
							setHighlightedInputName(null);
							setHighlightedRefValue(null);
						}}
						highlightedInputName={highlightedInputName}
						onHighlightInput={(name) => {
							setHighlightedInputName(name);
							setHighlightedReply(null);
							setHighlightedArtifact(null);
							setHighlightedRefValue(null);
						}}
						highlightedRefValue={highlightedRefValue}
						onHighlightRef={(value) => {
							setHighlightedRefValue(value);
							setHighlightedReply(null);
							setHighlightedArtifact(null);
							setHighlightedInputName(null);
						}}
						{...scopeProps}
						{...(selectedInvokeSeqId === undefined ? {} : { selectedInvokeSeqId })}
						{...(historyDataSource === undefined || run.historySnapshot === undefined ? {} : { history: { runId: run.runId, snapshot: run.historySnapshot, dataSource: historyDataSource, ...((selectedInvokeSeqId ?? historyTargetSeqId) === undefined ? {} : { targetSeqId: selectedInvokeSeqId ?? historyTargetSeqId }) } })}
						{...(onSteerSession === undefined ? {} : { onSteerSession })}
					/>
				</>
			) : (
				<RunOverview
					run={run}
					{...(effectiveDefinitionSource === undefined ? {} : { definitionSource: effectiveDefinitionSource })}
				/>
			)}
		</aside>
	);
}
