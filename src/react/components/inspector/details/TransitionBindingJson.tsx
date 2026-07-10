import type { HyperchartStateInfo } from "../../../types.js";
import { transitionBindingDisplay, transitionBindingLabel, transitionBindingTitle } from "../helpers/transitions.js";
import { TypeTooltip } from "../ui/TypeTooltip.js";

export function TransitionBindingJson({
	state,
	input,
	onReplyFieldClick,
}: {
	state: HyperchartStateInfo;
	input: Record<string, string>;
	onReplyFieldClick?: (path: string) => void;
}) {
	const entries = Object.entries(input);
	return (
		<div className="min-w-0 max-w-full overflow-x-auto rounded-lg border border-[var(--border-primary)] bg-[var(--bg-code)] p-2 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">
			<div>{"{"}</div>
			{entries.map(([name, rawBinding], index) => {
				const binding = transitionBindingDisplay(rawBinding);
				const clickable = binding.kind === "event" && binding.path !== undefined && onReplyFieldClick !== undefined;
				const value = transitionBindingLabel(binding);
				return (
					<div key={name} className="pl-4">
						<span className="text-red-400">{JSON.stringify(name)}</span>
						<span>: </span>
						<TypeTooltip text={transitionBindingTitle(state, binding)}>
							{clickable ? (
								<button
									type="button"
									onClick={() => onReplyFieldClick(binding.path ?? "")}
									className="rounded border border-cyan-500/25 bg-cyan-500/10 px-1 text-left text-[var(--hc-cyan-text)] hover:bg-cyan-500/15"
								>
									{value}
								</button>
							) : (
								<span className="text-[var(--hc-cyan-text)]">{value}</span>
							)}
						</TypeTooltip>
						{index < entries.length - 1 ? "," : ""}
					</div>
				);
			})}
			<div>{"}"}</div>
		</div>
	);
}
