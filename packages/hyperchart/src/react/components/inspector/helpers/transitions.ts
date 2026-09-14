import type { HyperchartStateInfo } from "../../../types.js";
import type { StateInput, StateTransition, TransitionBindingDisplay } from "../types.js";
import { parseDslCallArgs, stateInputRefSchema } from "./dslRefs.js";
import { schemaAtPath, schemaTypeText } from "./schema.js";

function inputBindingDisplay(binding: string): TransitionBindingDisplay | undefined {
	const args = parseDslCallArgs(binding, "input");
	if (args?.[0] === undefined || args.length > 2) {
		return undefined;
	}
	return {
		kind: "input",
		name: args[0],
		...(args[1] === undefined ? {} : { path: args[1] }),
		preview: binding,
	};
}

export function transitionBindingDisplay(binding: string): TransitionBindingDisplay {
	if (binding === "event()") {
		return { kind: "event" };
	}
	if (binding.startsWith("event:")) {
		return { kind: "event", path: binding.slice("event:".length) };
	}
	return inputBindingDisplay(binding) ?? { kind: "unknown", preview: binding };
}

export function transitionBindingLabel(binding: TransitionBindingDisplay): string {
	switch (binding.kind) {
		case "event":
			return binding.path === undefined ? "event()" : `event().${binding.path}`;
		case "input":
			return binding.preview;
		case "unknown":
			return binding.preview;
	}
}

export function transitionBindingTitle(state: HyperchartStateInfo, binding: TransitionBindingDisplay): string {
	switch (binding.kind) {
		case "event": {
			const sourceSchema = schemaAtPath(state.replySchema, binding.path);
			return sourceSchema ? schemaTypeText(sourceSchema) : "unknown";
		}
		case "input": {
			const sourceSchema = stateInputRefSchema(state, binding.name, binding.path);
			return sourceSchema ? schemaTypeText(sourceSchema) : "unknown";
		}
		case "unknown":
			return "unknown";
	}
}

export function transitionTargetInput(
	transition: StateTransition,
	inputName: string,
	allStates: HyperchartStateInfo[],
): StateInput | undefined {
	const direct = allStates
		.find((candidate) => candidate.id === transition.target)
		?.inputs?.find((candidate) => candidate.name === inputName);
	if (direct) {
		return direct;
	}
	const prefix = `${transition.target}.`;
	return allStates
		.find((candidate) => candidate.id.startsWith(prefix) && candidate.inputs?.some((input) => input.name === inputName))
		?.inputs?.find((candidate) => candidate.name === inputName);
}

export function transitionWasTaken(state: HyperchartStateInfo, transition: StateTransition): boolean {
	return transition.taken === true || state.completedEvent === transition.event;
}
