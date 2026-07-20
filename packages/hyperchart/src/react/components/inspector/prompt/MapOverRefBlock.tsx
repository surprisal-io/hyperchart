import type { HyperchartStateInfo } from "../../../types.js";
import type { InterpolatedTextProps } from "../types.js";
import { interpolationAction } from "../helpers/interpolation.js";
import { schemaTypeText } from "../helpers/schema.js";
import { InterpolationToken } from "./InterpolationToken.js";

export function MapOverRefBlock({
	text,
	schema,
	state,
	allStates,
	onHighlightInput,
	onHighlightReply,
	onHighlightRef,
}: InterpolatedTextProps & { schema?: HyperchartStateInfo["replySchema"] }) {
	const baseAction = interpolationAction(text, state, allStates, {
		...(onHighlightInput === undefined ? {} : { onHighlightInput }),
		...(onHighlightReply === undefined ? {} : { onHighlightReply }),
		...(onHighlightRef === undefined ? {} : { onHighlightRef }),
	});
	const action =
		baseAction.title === "unknown" && schema !== undefined
			? { ...baseAction, title: schemaTypeText(schema) }
			: baseAction;
	return (
		<div className="min-w-0 max-w-full overflow-x-auto rounded-lg border border-[var(--border-primary)] bg-[var(--bg-code)] p-2 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">
			<InterpolationToken token={text} action={action} display={text} />
		</div>
	);
}
