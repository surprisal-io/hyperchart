import type { HyperchartStateInfo } from "../../../types.js";
import type { StateTransition } from "../types.js";
import { transitionTargetInput } from "../helpers/transitions.js";
import { TypeBlock } from "../ui/TypeBlock.js";

export function TransitionInputRow({
	transition,
	names,
	allStates,
}: {
	transition: StateTransition;
	names: string[];
	allStates: HyperchartStateInfo[];
}) {
	const targetInputs = names.map((name) => ({ name, input: transitionTargetInput(transition, name, allStates) }));
	const properties = Object.fromEntries(targetInputs.map(({ name, input }) => [name, input?.schema?.schema ?? {}]));
	const required = targetInputs
		.filter(({ input }) => input?.required !== false && input?.defaulted !== true)
		.map(({ name }) => name);
	const targetName = transition.target.split(/[.#]/).at(-1) ?? "target";
	return (
		<div className="rounded border border-emerald-500/20 bg-emerald-500/10 p-2">
			<div className="mb-2 text-[10px] uppercase tracking-wide text-[var(--hc-green-text)]">target input type</div>
			<TypeBlock
				schema={{
					schema: {
						type: "object",
						properties,
						...(required.length === 0 ? {} : { required }),
						additionalProperties: false,
					},
				}}
				name={`${targetName} input`}
			/>
		</div>
	);
}
