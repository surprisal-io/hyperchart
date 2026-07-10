import React from "react";
import type { InterpolatedTextProps } from "../types.js";
import { interpolationAction } from "../helpers/interpolation.js";
import { InterpolationToken } from "./InterpolationToken.js";

export function InterpolatedTextBlock({
	text,
	state,
	allStates,
	onHighlightInput,
	onHighlightReply,
	onHighlightRef,
}: InterpolatedTextProps) {
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
	return (
		<div className="min-w-0 max-w-full overflow-x-auto rounded-lg border border-[var(--border-primary)] bg-[var(--bg-code)] p-2 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap [overflow-wrap:anywhere]">
			{parts}
		</div>
	);
}
