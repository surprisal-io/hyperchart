import type { InterpolatedTextProps } from "../types.js";
import { hasInterpolation } from "../helpers/interpolation.js";
import { createBufferedTextPreview } from "../helpers/textPreview.js";
import { CssExpandableBlock } from "../ui/CssExpandableBlock.js";
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
	nowrap = false,
	compact = false,
	cssCollapse = false,
	wrapLongLines = false,
	maxPreviewCharacters,
	language,
}: InterpolatedTextProps & { collapsedLines?: number; nowrap?: boolean; compact?: boolean; cssCollapse?: boolean; wrapLongLines?: boolean; maxPreviewCharacters?: number; language?: string }) {
	if (hasInterpolation(text)) {
		return (
			<InterpolatedTextBlock
				text={text}
				state={state}
				allStates={allStates}
				{...(collapsedLines === undefined ? {} : { collapsedLines })}
				nowrap={nowrap}
				compact={compact}
				cssCollapse={cssCollapse}
				{...(maxPreviewCharacters === undefined ? {} : { maxPreviewCharacters })}
				{...(onHighlightInput === undefined ? {} : { onHighlightInput })}
				{...(onHighlightReply === undefined ? {} : { onHighlightReply })}
				{...(onHighlightRef === undefined ? {} : { onHighlightRef })}
			/>
		);
	}
	if (cssCollapse) {
		const preview = createBufferedTextPreview(text);
		return (
			<CssExpandableBlock
				contentTruncated={preview.truncated}
				previewText={preview.text}
				fullText={text}
				render={(value, full) => <div className={`min-w-0 max-w-full p-2 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)] [overflow-wrap:anywhere] ${full ? "whitespace-pre-wrap" : "whitespace-normal"}`}>{value}</div>}
			/>
		);
	}
	return <ExpandablePre {...(collapsedLines === undefined ? {} : { collapsedLines })} {...(maxPreviewCharacters === undefined ? {} : { maxPreviewCharacters })} {...(language === undefined ? {} : { language })} wrapLongLines={wrapLongLines}>{text}</ExpandablePre>;
}
