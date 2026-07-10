import React from "react";
import { interpolationAction } from "../helpers/interpolation.js";
import type { InterpolatedTextProps } from "../types.js";
import { ExpandablePre } from "../ui/ExpandablePre.js";
import { InterpolationToken } from "./InterpolationToken.js";

function interpolatedParts(
	text: string,
	{ state, allStates, onHighlightInput, onHighlightReply, onHighlightRef }: Omit<InterpolatedTextProps, "text">,
): React.ReactNode[] {
	const parts: React.ReactNode[] = [];
	const pattern = /\{([^{}]+)\}/g;
	let lastIndex = 0;
	let match = pattern.exec(text);
	while (match !== null) {
		if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
		const token = match[1] ?? "";
		const action = interpolationAction(token, state, allStates, {
			...(onHighlightInput === undefined ? {} : { onHighlightInput }),
			...(onHighlightReply === undefined ? {} : { onHighlightReply }),
			...(onHighlightRef === undefined ? {} : { onHighlightRef }),
		});
		parts.push(<InterpolationToken key={`${token}:${match.index}`} token={token} action={action} />);
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
}: InterpolatedTextProps & { collapsedLines?: number }) {
	const interpolationProps = {
		state,
		allStates,
		...(onHighlightInput === undefined ? {} : { onHighlightInput }),
		...(onHighlightReply === undefined ? {} : { onHighlightReply }),
		...(onHighlightRef === undefined ? {} : { onHighlightRef }),
	};
	return (
		<ExpandablePre
			collapsedLines={collapsedLines}
			maxPreviewCharacters={Math.max(240, collapsedLines * 100)}
			renderContent={(visibleText) => (
				<div className="min-w-0 max-w-full p-2 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap [overflow-wrap:anywhere]">
					{interpolatedParts(visibleText, interpolationProps)}
				</div>
			)}
		>
			{text}
		</ExpandablePre>
	);
}
