import { useEffect, useMemo, useState } from "react";
import type { HyperchartRunInfo } from "../../types.js";
import { useHyperchartTheme } from "../../support/theme-context.js";
import { immediateMapScopeId } from "./helpers/scope.js";
import { RunOverview } from "./details/RunOverview.js";
import { StateDetails } from "./details/StateDetails.js";

export interface HyperchartInspectorSidePanelProps {
	run: HyperchartRunInfo;
	selectedStateId?: string | null;
	onOpenScope?: (stateId: string) => void;
	className?: string;
	definitionSource?: string;
}

export function HyperchartInspectorSidePanel({
	run,
	selectedStateId = null,
	onOpenScope,
	className = "",
	definitionSource,
}: HyperchartInspectorSidePanelProps) {
	const { resolved } = useHyperchartTheme();
	const selectedState = selectedStateId ? (run.states.find((state) => state.id === selectedStateId) ?? null) : null;
	const [highlightedReply, setHighlightedReply] = useState<{ stateId: string; path: string } | null>(null);
	const [highlightedInputName, setHighlightedInputName] = useState<string | null>(null);
	const [highlightedRefValue, setHighlightedRefValue] = useState<string | null>(null);
	const [revealedReplyStateIds, setRevealedReplyStateIds] = useState<string[]>([]);
	useEffect(() => {
		void run.runId;
		void selectedStateId;
		setHighlightedReply(null);
		setHighlightedInputName(null);
		setHighlightedRefValue(null);
		setRevealedReplyStateIds([]);
	}, [run.runId, selectedStateId]);
	useEffect(() => {
		if (highlightedReply === null && highlightedInputName === null && highlightedRefValue === null) return;
		const timeout = window.setTimeout(() => {
			setHighlightedReply(null);
			setHighlightedInputName(null);
			setHighlightedRefValue(null);
		}, 5_000);
		return () => window.clearTimeout(timeout);
	}, [highlightedReply, highlightedInputName, highlightedRefValue]);
	const scopeChildIds = useMemo(
		() => new Set(run.states.map((state) => immediateMapScopeId(state.id)).filter((id): id is string => !!id)),
		[run],
	);
	const effectiveDefinitionSource = definitionSource ?? selectedState?.definitionSource ?? run.definitionSource;
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
				<StateDetails
					state={selectedState}
					allStates={run.states}
					{...(effectiveDefinitionSource === undefined ? {} : { definitionSource: effectiveDefinitionSource })}
					highlightedReply={highlightedReply}
					revealedReplyStateIds={revealedReplyStateIds}
					onHighlightReply={(stateId, path) => {
						setHighlightedReply({ stateId, path });
						setRevealedReplyStateIds((stateIds) => (stateIds.includes(stateId) ? stateIds : [...stateIds, stateId]));
						setHighlightedInputName(null);
						setHighlightedRefValue(null);
					}}
					highlightedInputName={highlightedInputName}
					onHighlightInput={(name) => {
						setHighlightedInputName(name);
						setHighlightedReply(null);
						setHighlightedRefValue(null);
					}}
					highlightedRefValue={highlightedRefValue}
					onHighlightRef={(value) => {
						setHighlightedRefValue(value);
						setHighlightedReply(null);
						setHighlightedInputName(null);
					}}
					{...scopeProps}
				/>
			) : (
				<RunOverview
					run={run}
					{...(effectiveDefinitionSource === undefined ? {} : { definitionSource: effectiveDefinitionSource })}
				/>
			)}
		</aside>
	);
}
