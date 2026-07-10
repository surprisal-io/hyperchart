import { CommandLineIcon } from "@heroicons/react/24/outline";
import type { HyperchartStateInfo } from "../../../types.js";
import { Section } from "../ui/Section.js";
import { TemplateTextBlock } from "./TemplateTextBlock.js";

export function PromptSection({
	state,
	allStates,
	onHighlightInput,
	onHighlightReply,
	onHighlightRef,
}: {
	state: HyperchartStateInfo;
	allStates: HyperchartStateInfo[];
	onHighlightInput?: (name: string) => void;
	onHighlightReply?: (stateId: string, path: string) => void;
	onHighlightRef?: (value: string) => void;
}) {
	if (!state.taskPrompt) return null;
	return (
		<Section title="Prompt" icon={CommandLineIcon}>
			<TemplateTextBlock
				text={state.taskPrompt}
				state={state}
				allStates={allStates}
				collapsedLines={12}
				showOpenFull={false}
				{...(onHighlightInput === undefined ? {} : { onHighlightInput })}
				{...(onHighlightReply === undefined ? {} : { onHighlightReply })}
				{...(onHighlightRef === undefined ? {} : { onHighlightRef })}
			/>
		</Section>
	);
}
