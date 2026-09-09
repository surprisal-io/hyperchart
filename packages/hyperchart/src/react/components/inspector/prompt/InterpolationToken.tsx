import type { PromptInterpolationAction } from "../types.js";
import { interpolationTokenClass } from "../helpers/interpolation.js";
import { TypeTooltip } from "../ui/TypeTooltip.js";

function inlineToneClass(tone: PromptInterpolationAction["tone"]): string {
	switch (tone) {
		case "actorInput":
			return "text-[var(--hc-purple-text)]";
		case "messageInput":
			return "text-[var(--hc-blue-text)]";
		case "result":
			return "text-[var(--hc-green-text)]";
		case "visit":
			return "text-[var(--hc-amber-text)]";
		case "input":
		case "plain":
			return "text-[var(--hc-cyan-text)]";
	}
}

export function InterpolationToken({
	token,
	action,
	display,
	inline = false,
}: {
	token: string;
	action: PromptInterpolationAction;
	display?: string;
	inline?: boolean;
}) {
	const className = inline
		? `inline whitespace-nowrap font-mono ${action.onClick === undefined ? "cursor-help" : "cursor-pointer"} ${inlineToneClass(action.tone)}`
		: interpolationTokenClass(action.tone, action.onClick !== undefined);
	const label = display ?? `{${token}}`;
	const content =
		action.onClick === undefined ? (
			<span className={className}>{label}</span>
		) : (
			<button key={token} type="button" onClick={action.onClick} className={className}>
				{label}
			</button>
		);
	return <TypeTooltip text={action.title}>{content}</TypeTooltip>;
}
