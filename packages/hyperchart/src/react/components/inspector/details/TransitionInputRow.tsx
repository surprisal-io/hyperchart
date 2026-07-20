import type { HyperchartStateInfo } from "../../../types.js";
import type { StateTransition } from "../types.js";
import { schemaLabel } from "../helpers/schema.js";
import { transitionTargetInput } from "../helpers/transitions.js";
import { TypeBlock } from "../ui/TypeBlock.js";

export function TransitionInputRow({
	transition,
	name,
	allStates,
}: {
	transition: StateTransition;
	name: string;
	allStates: HyperchartStateInfo[];
}) {
	const targetInput = transitionTargetInput(transition, name, allStates);
	return (
		<div className="rounded border border-emerald-500/20 bg-emerald-500/10 p-2">
			<div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--hc-green-text)]">target input type</div>
			<div className="flex flex-wrap items-center gap-1.5">
				<span className="rounded border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--hc-green-text)]">
					{name}
				</span>
				{targetInput?.schema && (
					<span className="rounded border border-[var(--border-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">
						{schemaLabel(targetInput.schema)}
					</span>
				)}
			</div>
			{targetInput?.schema && (
				<div className="mt-2">
					<TypeBlock schema={targetInput.schema} name={`${name} input`} />
				</div>
			)}
		</div>
	);
}
