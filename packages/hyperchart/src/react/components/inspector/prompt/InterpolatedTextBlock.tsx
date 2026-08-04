import React from "react";
import { interpolationAction, isPromptInterpolationToken } from "../helpers/interpolation.js";
import { createBufferedTextPreview } from "../helpers/textPreview.js";
import type { InterpolatedTextProps } from "../types.js";
import { CssExpandableBlock } from "../ui/CssExpandableBlock.js";
import { ExpandablePre } from "../ui/ExpandablePre.js";
import { InterpolationToken } from "./InterpolationToken.js";

function compactTokenDisplay(token: string): string {
	return `\${${token.trim()}}`;
}

function interpolatedParts(
	text: string,
	{ state, allStates, onHighlightInput, onHighlightReply, onHighlightRef }: Omit<InterpolatedTextProps, "text">,
	compactTokens = false,
): React.ReactNode[] {
	const parts: React.ReactNode[] = [];
	const pattern = /\{([^{}]+)\}/g;
	let lastIndex = 0;
	let match = pattern.exec(text);
	while (match !== null) {
		if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
		const token = match[1] ?? "";
		if (isPromptInterpolationToken(token)) {
			const action = interpolationAction(token, state, allStates, {
				...(onHighlightInput === undefined ? {} : { onHighlightInput }),
				...(onHighlightReply === undefined ? {} : { onHighlightReply }),
				...(onHighlightRef === undefined ? {} : { onHighlightRef }),
			});
			const display = compactTokens ? compactTokenDisplay(token) : undefined;
			parts.push(<InterpolationToken key={`${token}:${match.index}`} token={token} action={action} inline={compactTokens} {...(display === undefined ? {} : { display })} />);
		} else {
			parts.push(match[0]);
		}
		lastIndex = match.index + match[0].length;
		match = pattern.exec(text);
	}
	if (lastIndex < text.length) parts.push(text.slice(lastIndex));
	return parts;
}

export function InterpolatedTextBlock({
	text,
	state,
	allStates,
	onHighlightInput,
	onHighlightReply,
	onHighlightRef,
	collapsedLines = 12,
	nowrap = false,
	compact = false,
	cssCollapse = false,
	maxPreviewCharacters,
}: InterpolatedTextProps & { collapsedLines?: number; nowrap?: boolean; compact?: boolean; cssCollapse?: boolean; maxPreviewCharacters?: number }) {
	const interpolationProps = {
		state,
		allStates,
		...(onHighlightInput === undefined ? {} : { onHighlightInput }),
		...(onHighlightReply === undefined ? {} : { onHighlightReply }),
		...(onHighlightRef === undefined ? {} : { onHighlightRef }),
	};
	if (compact) {
		return (
			<div className="min-w-0 max-w-full overflow-x-auto rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] px-2 py-1.5 font-mono text-[10px] leading-relaxed text-[var(--text-secondary)] whitespace-pre [overflow-wrap:normal]">
				<span className="inline-block w-max min-w-full">{interpolatedParts(text, interpolationProps, true)}</span>
			</div>
		);
	}
	if (cssCollapse) {
		const preview = createBufferedTextPreview(text);
		return (
			<CssExpandableBlock
				contentTruncated={preview.truncated}
				previewText={preview.text}
				fullText={text}
				render={(value, full, closeFull) => {
					const fullProps = closeFull === undefined ? interpolationProps : {
						...interpolationProps,
						...(onHighlightInput === undefined ? {} : { onHighlightInput: (name: string) => { closeFull(); onHighlightInput(name); } }),
						...(onHighlightReply === undefined ? {} : { onHighlightReply: (stateId: string, path: string) => { closeFull(); onHighlightReply(stateId, path); } }),
						...(onHighlightRef === undefined ? {} : { onHighlightRef: (value: string) => { closeFull(); onHighlightRef(value); } }),
					};
					return (
						<div className={`min-w-0 max-w-full p-2 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)] [overflow-wrap:anywhere] ${full ? "whitespace-pre-wrap" : "whitespace-normal"}`}>
							{interpolatedParts(value, fullProps)}
						</div>
					);
				}}
			/>
		);
	}
	return (
		<ExpandablePre
			collapsedLines={collapsedLines}
			maxPreviewCharacters={maxPreviewCharacters ?? Math.max(240, collapsedLines * 100)}
			renderContent={(visibleText) => (
				<div className={`p-2 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)] ${nowrap ? "w-max min-w-full whitespace-pre [overflow-wrap:normal]" : "min-w-0 max-w-full whitespace-pre-wrap [overflow-wrap:anywhere]"}`}>
					{interpolatedParts(visibleText, interpolationProps)}
				</div>
			)}
		>
			{text}
		</ExpandablePre>
	);
}
