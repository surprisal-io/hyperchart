import type { HyperchartStateInfo } from "../../../types.js";
import type { EventBindingDisplay, StateInput, StateTransition } from "../types.js";
import { schemaAtPath, schemaTypeText } from "./schema.js";

export function transitionBindingDisplay(binding: string): EventBindingDisplay {
	if (binding === "event()") return { kind: "event" };
	if (binding.startsWith("event:")) return { kind: "event", path: binding.slice("event:".length) };
	return { kind: "unknown", preview: binding };
}

export function transitionBindingLabel(binding: EventBindingDisplay): string {
	if (binding.kind === "unknown") return binding.preview;
	return binding.path === undefined ? "event()" : `event().${binding.path}`;
}

export function transitionBindingTitle(state: HyperchartStateInfo, binding: EventBindingDisplay): string {
	if (binding.kind === "unknown") return "unknown";
	const sourceSchema = schemaAtPath(state.replySchema, binding.path);
	return sourceSchema ? schemaTypeText(sourceSchema) : "unknown";
}

export function transitionTargetInput(
	transition: StateTransition,
	inputName: string,
	allStates: HyperchartStateInfo[],
): StateInput | undefined {
	const direct = allStates
		.find((candidate) => candidate.id === transition.target)
		?.inputs?.find((candidate) => candidate.name === inputName);
	if (direct) return direct;
	const prefix = `${transition.target}.`;
	return allStates
		.find((candidate) => candidate.id.startsWith(prefix) && candidate.inputs?.some((input) => input.name === inputName))
		?.inputs?.find((candidate) => candidate.name === inputName);
}

export function transitionWasTaken(state: HyperchartStateInfo, transition: StateTransition): boolean {
	return transition.taken === true || state.completedEvent === transition.event;
}
