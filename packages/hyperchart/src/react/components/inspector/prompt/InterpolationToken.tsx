import type { PromptInterpolationAction } from "../types.js";
import { interpolationTokenClass } from "../helpers/interpolation.js";
import { TypeTooltip } from "../ui/TypeTooltip.js";

export function InterpolationToken({
	token,
	action,
	display,
}: {
	token: string;
	action: PromptInterpolationAction;
	display?: string;
}) {
	const className = interpolationTokenClass(action.tone, action.onClick !== undefined);
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
