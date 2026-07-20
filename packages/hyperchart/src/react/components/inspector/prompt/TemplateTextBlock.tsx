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
}: InterpolatedTextProps & { collapsedLines?: number }) {
	if (hasInterpolation(text)) {
		return (
			<InterpolatedTextBlock
				text={text}
				state={state}
				allStates={allStates}
				{...(collapsedLines === undefined ? {} : { collapsedLines })}
				{...(onHighlightInput === undefined ? {} : { onHighlightInput })}
				{...(onHighlightReply === undefined ? {} : { onHighlightReply })}
				{...(onHighlightRef === undefined ? {} : { onHighlightRef })}
			/>
		);
	}
	return <ExpandablePre {...(collapsedLines === undefined ? {} : { collapsedLines })}>{text}</ExpandablePre>;
}
