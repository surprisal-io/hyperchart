import { CodeBracketSquareIcon } from "@heroicons/react/24/outline";
import type { HyperchartLaunchArgumentInfo, HyperchartStateInfo } from "../../../types.js";
import { contractStatesForSelection } from "../helpers/state.js";
import { Section } from "../ui/Section.js";
import { ContractCard } from "./ContractCard.js";

export function ContractsSection({
	state,
	allStates,
	launchArgs,
	highlightedReply,
	highlightedArtifact,
	revealedReplyStateIds = [],
	revealedArtifactStateIds = [],
	onHighlightInput,
	onHighlightReply,
	onHighlightRef,
	onNavigateToState,
}: {
	state: HyperchartStateInfo;
	allStates: HyperchartStateInfo[];
	launchArgs?: Readonly<Record<string, HyperchartLaunchArgumentInfo>>;
	highlightedReply?: { stateId: string; path: string } | null;
	highlightedArtifact?: { stateId: string; name: string } | null;
	revealedReplyStateIds?: readonly string[];
	revealedArtifactStateIds?: readonly string[];
	onHighlightInput?: (name: string) => void;
	onHighlightReply?: (stateId: string, path: string) => void;
	onHighlightRef?: (value: string) => void;
	onNavigateToState?: (stateId: string) => void;
}) {
	const contractStates = contractStatesForSelection(state, allStates, highlightedReply, [
		...revealedReplyStateIds,
		...revealedArtifactStateIds,
	]);
	if (contractStates.length === 0) {
		return null;
	}
	const visibleReplyStateIds = contractStates.map((contractState) => contractState.id);
	return (
		<Section
			title={contractStates.length === 1 && contractStates[0]?.id === state.id ? "Contracts" : "Contracts in scope"}
			icon={CodeBracketSquareIcon}
		>
			<div className="space-y-2">
				{contractStates.map((contractState) => (
					<ContractCard
						key={contractState.id}
						state={contractState}
						allStates={allStates}
						{...(launchArgs === undefined ? {} : { launchArgs })}
						showStateName={contractState.id !== state.id || contractStates.length > 1}
						visibleReplyStateIds={visibleReplyStateIds}
						{...(contractState.id === highlightedReply?.stateId ? { highlightedReplyPath: highlightedReply.path } : {})}
						{...(contractState.id === highlightedArtifact?.stateId
							? { highlightedArtifactName: highlightedArtifact.name }
							: {})}
						{...(onHighlightInput === undefined ? {} : { onHighlightInput })}
						{...(onHighlightReply === undefined ? {} : { onHighlightReply })}
						{...(onHighlightRef === undefined ? {} : { onHighlightRef })}
						{...(onNavigateToState === undefined ? {} : { onNavigateToState })}
					/>
				))}
			</div>
		</Section>
	);
}
