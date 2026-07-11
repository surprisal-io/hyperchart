import { ArrowsRightLeftIcon } from "@heroicons/react/24/outline";
import type { HyperchartStateInfo } from "../../../types.js";
import { transitionWasTaken } from "../helpers/transitions.js";
import { Section } from "../ui/Section.js";
import { TransitionBindingJson } from "./TransitionBindingJson.js";
import { TransitionInputRow } from "./TransitionInputRow.js";

export function TransitionsSection({
	state,
	allStates,
	onReplyFieldClick,
}: {
	state: HyperchartStateInfo;
	allStates: HyperchartStateInfo[];
	onReplyFieldClick?: (path: string) => void;
}) {
	if (!state.transitions?.length) return null;
	return (
		<Section title="Transitions" icon={ArrowsRightLeftIcon}>
			<div className="grid gap-2">
				{state.transitions.map((transition) => {
					const inputEntries = Object.entries(transition.input ?? {});
					const taken = transitionWasTaken(state, transition);
					return (
						<div
							key={`${transition.event}:${transition.target}`}
							className={`rounded-lg border p-2 ${taken ? "border-blue-500/55 bg-blue-500/10 shadow-[0_0_0_1px_rgba(59,130,246,0.16)]" : "border-[var(--border-secondary)] bg-[var(--bg-secondary)]"}`}
						>
							<div className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2 text-[11px]">
								<code
									className={`rounded px-1.5 py-0.5 text-[10px] ${taken ? "bg-blue-500/15 text-[var(--hc-blue-text)] ring-1 ring-blue-500/30" : "bg-[var(--bg-code)] text-[var(--hc-amber-text)]"}`}
								>
									{transition.event}
								</code>
								<span className={taken ? "text-[var(--hc-blue-text)]" : "text-[var(--text-muted)]"}>→</span>
								<span
									className={`min-w-0 truncate font-mono ${taken ? "font-semibold text-[var(--text-primary)]" : "text-[var(--text-primary)]"}`}
									title={transition.target}
								>
									{transition.target}
								</span>
								{taken && (
									<span className="shrink-0 rounded border border-blue-500/35 bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--hc-blue-text)]">
										taken
									</span>
								)}
							</div>
							{inputEntries.length > 0 ? (
								<div className="mt-2 space-y-2">
									<div className="grid gap-1">
										{inputEntries.map(([name]) => (
											<TransitionInputRow key={name} transition={transition} name={name} allStates={allStates} />
										))}
									</div>
									<TransitionBindingJson
										state={state}
										input={transition.input ?? {}}
										{...(onReplyFieldClick === undefined ? {} : { onReplyFieldClick })}
									/>
								</div>
							) : (
								<div className="mt-2 text-[10px] text-[var(--text-muted)]">
									No input object is passed on this transition.
								</div>
							)}
						</div>
					);
				})}
			</div>
		</Section>
	);
}
