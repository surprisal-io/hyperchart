import type { PromptInterpolationAction } from "../types.js";
import { interpolationTokenClass } from "../helpers/interpolation.js";
import { TypeTooltip } from "../ui/TypeTooltip.js";

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
		? `inline whitespace-nowrap font-mono ${action.onClick === undefined ? "cursor-help" : "cursor-pointer"} ${action.tone === "visit" ? "text-[var(--hc-amber-text)]" : "text-[var(--hc-cyan-text)]"}`
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
