import type { HyperchartInspectRef, HyperchartLaunchArgumentInfo, HyperchartStateInfo } from "../../../types.js";
import type { StateInput, StateTransition, TransitionBindingDisplay } from "../types.js";
import { parseDslCallArgs, stateInputRefSchema } from "./dslRefs.js";
import { asSchemaRecord, schemaAtPath, schemaTypeText } from "./schema.js";

function parsedRef(binding: string, name: string): string[] | undefined {
	return parseDslCallArgs(binding, name);
}

function inputBindingDisplay(binding: string): TransitionBindingDisplay | undefined {
	const args = parsedRef(binding, "input");
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

function simpleBindingDisplay(binding: string): TransitionBindingDisplay | undefined {
	const argArgs = parsedRef(binding, "arg");
	if (argArgs?.[0] !== undefined && argArgs.length === 1) {
		return { kind: "arg", name: argArgs[0], preview: binding };
	}
	const resultArgs = parsedRef(binding, "result");
	if (resultArgs?.[0] !== undefined && resultArgs.length <= 2) {
		return {
			kind: "result",
			state: resultArgs[0],
			...(resultArgs[1] === undefined ? {} : { path: resultArgs[1] }),
			preview: binding,
		};
	}
	const visitArgs = parsedRef(binding, "visit");
	if (visitArgs !== undefined && visitArgs.length <= 1) {
		return {
			kind: "visit",
			...(visitArgs[0] === undefined ? {} : { state: visitArgs[0] }),
			preview: binding,
		};
	}
	const keyArgs = parsedRef(binding, "key");
	if (keyArgs !== undefined && keyArgs.length <= 1) {
		return {
			kind: "key",
			...(keyArgs[0] === undefined ? {} : { state: keyArgs[0] }),
			preview: binding,
		};
	}
	const actorInputArgs = parsedRef(binding, "actorInput");
	if (actorInputArgs !== undefined && actorInputArgs.length <= 1) {
		return {
			kind: "actorInput",
			...(actorInputArgs[0] === undefined ? {} : { path: actorInputArgs[0] }),
			preview: binding,
		};
	}
	const messageInputArgs = parsedRef(binding, "messageInput");
	if (messageInputArgs?.[0] !== undefined && messageInputArgs.length <= 2) {
		return {
			kind: "messageInput",
			name: messageInputArgs[0],
			...(messageInputArgs[1] === undefined ? {} : { path: messageInputArgs[1] }),
			preview: binding,
		};
	}
	return undefined;
}

export function transitionBindingDisplay(binding: string | HyperchartInspectRef): TransitionBindingDisplay {
	if (typeof binding !== "string") {
		return binding;
	}
	if (binding === "event()") {
		return { kind: "event" };
	}
	if (binding.startsWith("event:")) {
		return { kind: "event", path: binding.slice("event:".length) };
	}
	return inputBindingDisplay(binding) ?? simpleBindingDisplay(binding) ?? { kind: "unknown", preview: binding };
}

export function transitionBindingLabel(binding: TransitionBindingDisplay): string {
	return binding.kind === "event"
		? binding.path === undefined
			? "event()"
			: `event().${binding.path}`
		: binding.preview;
}

export function transitionBindingResultTarget(
	state: HyperchartStateInfo,
	allStates: HyperchartStateInfo[],
	ref: Pick<HyperchartInspectRef, "kind" | "state" | "path">,
): { state: HyperchartStateInfo; path?: string } | undefined {
	if (ref.kind !== "result" && ref.kind !== "joinResultOf") {
		return undefined;
	}
	const direct = allStates.find((candidate) => candidate.id === ref.state && candidate.replySchema !== undefined);
	const actorInternal = state.actorInternal;
	const actorLocal =
		actorInternal === undefined
			? undefined
			: (allStates.find((candidate) => {
					const target = candidate.actorInternal;
					if (
						target?.declarationPath !== actorInternal.declarationPath ||
						target.localState !== ref.state ||
						candidate.replySchema === undefined
					) {
						return false;
					}
					if (actorInternal.occurrencePath !== undefined && target.occurrencePath !== actorInternal.occurrencePath) {
						return false;
					}
					if (
						actorInternal.logicalOccurrencePath !== undefined &&
						target.logicalOccurrencePath !== actorInternal.logicalOccurrencePath
					) {
						return false;
					}
					return actorInternal.generation === undefined || target.generation === actorInternal.generation;
				}) ??
				allStates.find(
					(candidate) =>
						candidate.actorInternal?.declarationPath === actorInternal.declarationPath &&
						candidate.actorInternal.localState === ref.state &&
						candidate.replySchema !== undefined,
				));
	const target = actorInternal === undefined ? direct : actorLocal;
	return target === undefined ? undefined : { state: target, ...(ref.path === undefined ? {} : { path: ref.path }) };
}

function actorDeclarationForState(
	state: HyperchartStateInfo,
	allStates: HyperchartStateInfo[],
): NonNullable<HyperchartStateInfo["actorDeclaration"]> | undefined {
	const declarationPath = state.actorInternal?.declarationPath;
	if (declarationPath === undefined) {
		return undefined;
	}
	return allStates.find((candidate) => candidate.actorDeclaration?.declarationPath === declarationPath)
		?.actorDeclaration;
}

function mapForRef(
	state: HyperchartStateInfo,
	allStates: HyperchartStateInfo[],
	mapId: string | undefined,
): HyperchartStateInfo | undefined {
	if (mapId !== undefined) {
		return allStates.find(
			(candidate) => candidate.type === "map" && (candidate.id === mapId || candidate.runtimeStatePath === mapId),
		);
	}
	let candidateId = state.scopeParentId ?? state.id;
	while (candidateId.length > 0) {
		const direct = allStates.find((candidate) => candidate.type === "map" && candidate.id === candidateId);
		if (direct !== undefined) {
			return direct;
		}
		const materialized = /^(.*)#[^.]+(?:\..*)?$/.exec(candidateId)?.[1];
		if (materialized !== undefined) {
			const map = allStates.find((candidate) => candidate.type === "map" && candidate.id === materialized);
			if (map !== undefined) {
				return map;
			}
		}
		const dot = candidateId.lastIndexOf(".");
		if (dot < 0) {
			break;
		}
		candidateId = candidateId.slice(0, dot);
	}
	return undefined;
}

function mapItemSchema(map: HyperchartStateInfo | undefined): HyperchartStateInfo["replySchema"] | undefined {
	const over = asSchemaRecord(map?.mapConfig?.overSchema?.schema);
	if (over === undefined) {
		return undefined;
	}
	const item = over.type === "array" ? over.items : over.additionalProperties;
	const itemSchema = asSchemaRecord(item);
	return itemSchema === undefined ? undefined : { schema: itemSchema };
}

function artifactRefSchema(
	allStates: HyperchartStateInfo[],
	binding: HyperchartInspectRef,
): HyperchartStateInfo["replySchema"] | undefined {
	const producer = allStates.find((candidate) => candidate.id === binding.state);
	const path = binding.path;
	if (path === undefined) {
		return undefined;
	}
	const artifact = producer?.artifacts
		?.filter((candidate) => path === candidate.name || path.startsWith(`${candidate.name}.`))
		.sort((left, right) => right.name.length - left.name.length)[0];
	if (artifact?.schema === undefined) {
		return undefined;
	}
	const selectedPath = path === artifact.name ? undefined : path.slice(artifact.name.length + 1);
	return schemaAtPath(artifact.schema, selectedPath) ?? artifact.schema;
}

export function transitionBindingTitle(
	state: HyperchartStateInfo,
	binding: TransitionBindingDisplay,
	allStates: HyperchartStateInfo[] = [state],
	launchArgs?: Readonly<Record<string, HyperchartLaunchArgumentInfo>>,
): string {
	switch (binding.kind) {
		case "event": {
			const sourceSchema = schemaAtPath(state.replySchema, binding.path);
			return sourceSchema ? schemaTypeText(sourceSchema) : "unknown";
		}
		case "input": {
			const sourceSchema = stateInputRefSchema(state, binding.name ?? "", binding.path);
			return sourceSchema ? schemaTypeText(sourceSchema) : "unknown";
		}
		case "result": {
			const target = transitionBindingResultTarget(state, allStates, binding);
			const sourceSchema = schemaAtPath(target?.state.replySchema, target?.path);
			return sourceSchema ? schemaTypeText(sourceSchema) : "unknown";
		}
		case "joinResultOf": {
			const target = transitionBindingResultTarget(state, allStates, binding);
			const sourceSchema = schemaAtPath(target?.state.replySchema, target?.path);
			return sourceSchema ? `Array<${schemaTypeText(sourceSchema)}>` : "unknown";
		}
		case "arg": {
			const schema = binding.name === undefined ? undefined : launchArgs?.[binding.name]?.schema;
			return schema === undefined ? "arg" : schemaTypeText(schema);
		}
		case "visit":
			return "number";
		case "key":
			return mapForRef(state, allStates, binding.state) === undefined ? "unknown" : "string";
		case "item": {
			const itemSchema = mapItemSchema(mapForRef(state, allStates, binding.state));
			const selected = schemaAtPath(itemSchema, binding.path) ?? itemSchema;
			return selected ? schemaTypeText(selected) : "unknown";
		}
		case "actorInput": {
			const schema = actorDeclarationForState(state, allStates)?.inputSchema;
			const selected = schemaAtPath(schema, binding.path) ?? schema;
			return selected ? schemaTypeText(selected) : "unknown";
		}
		case "messageInput": {
			const schema = actorDeclarationForState(state, allStates)?.protocol.find(
				(message) => message.event === binding.name,
			)?.input;
			const selected = schemaAtPath(schema, binding.path) ?? schema;
			return selected ? schemaTypeText(selected) : "unknown";
		}
		case "artifactOf": {
			const schema = artifactRefSchema(allStates, binding);
			return schema ? schemaTypeText(schema) : "artifact";
		}
		case "joinArtifactOf": {
			const schema = artifactRefSchema(allStates, binding);
			return schema ? `Array<${schemaTypeText(schema)}>` : "joined artifacts";
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
