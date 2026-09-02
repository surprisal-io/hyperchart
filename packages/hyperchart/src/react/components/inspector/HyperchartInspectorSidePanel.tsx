import { useEffect, useMemo, useState } from "react";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import type { HyperchartInspectorDataSource, HyperchartRunInfo } from "../../types.js";
import { useHyperchartTheme } from "../../support/theme-context.js";
import { stateScopeParentId } from "./helpers/scope.js";
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
	const scopeChildIds = useMemo(
		() => new Set(run.states.map(stateScopeParentId).filter((id): id is string => id !== undefined)),
		[run],
	);
	const effectiveDefinitionSource = definitionSource ?? (selectedState === null ? run.definitionSource : selectedState.definitionSource);
	const scopeProps = onOpenScope
		? { onOpenScope, canOpenScope: selectedState ? scopeChildIds.has(selectedState.id) : false }
		: {};
	return (
		<aside
			data-hyperchart-root
			data-theme={resolved}
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
						{...(historyDataSource === undefined || run.historySnapshot === undefined ? {} : { history: { runId: run.runId, snapshot: run.historySnapshot, dataSource: historyDataSource, ...(historyTargetSeqId === undefined ? {} : { targetSeqId: historyTargetSeqId }) } })}
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
