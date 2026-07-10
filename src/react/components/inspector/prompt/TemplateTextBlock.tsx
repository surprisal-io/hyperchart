import type { InterpolatedTextProps } from "../types.js";
import { hasInterpolation } from "../helpers/interpolation.js";
import { ExpandablePre } from "../ui/ExpandablePre.js";
import { InterpolatedTextBlock } from "./InterpolatedTextBlock.js";

export function TemplateTextBlock({
	text,
	state,
	allStates,
	onHighlightInput,
	onHighlightReply,
	onHighlightRef,
	collapsedLines,
	collapsedMaxHeight,
	showOpenFull = true,
}: InterpolatedTextProps & { collapsedLines?: number; collapsedMaxHeight?: string; showOpenFull?: boolean }) {
	if (hasInterpolation(text)) {
		return (
			<InterpolatedTextBlock
				text={text}
				state={state}
				allStates={allStates}
				{...(onHighlightInput === undefined ? {} : { onHighlightInput })}
				{...(onHighlightReply === undefined ? {} : { onHighlightReply })}
				{...(onHighlightRef === undefined ? {} : { onHighlightRef })}
			/>
		);
	}
	return (
		<ExpandablePre
			{...(collapsedLines === undefined ? {} : { collapsedLines })}
			{...(collapsedMaxHeight === undefined ? {} : { collapsedMaxHeight })}
			showOpenFull={showOpenFull}
		>
			{text}
		</ExpandablePre>
	);
}
