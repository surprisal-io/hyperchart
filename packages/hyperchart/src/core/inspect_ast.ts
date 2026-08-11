import { hyperchartSource, hyperchartValueSource } from "./source.js";
import type {
	ArtifactAst,
	ArtifactOfAst,
	AgentActionAst,
	ActorDefinitionAst,
	ActorEndpointDeclarationAst,
	ActorWorkflowStateAst,
	ChartArgumentAst,
	ChartAst,
	EventBindingAst,
	GuardRefAst,
	InputRef,
	JoinArtifactOfAst,
	JsonSchema,
	OnReject,
	OnReenterAst,
	SchemaAst,
	StateActionAst,
	StateAst,
	TemplateAst,
	ValueAst,
} from "./types.js";

export type HyperchartInspectAgentDefaults = {
	description?: string;
	role?: string;
	model?: string;
	resolvedModel?: string;
	thinking?: string;
	toolset?: string;
	tools?: readonly string[];
	resolvedTools?: readonly string[];
	agentDefinitionUnavailable?: boolean;
};

export type InspectChartModuleOptions = {
	exportName?: string;
	agentDefaults?: (agentName: string) => HyperchartInspectAgentDefaults | undefined;
};

export type HyperchartInspectArtifact = {
	name: string;
	path?: string;
	shape?: JsonSchema;
	/** Producer state when this artifact is referenced as an agent read. */
	sourceState?: string;
	/** Whether this read references one producer or joins every instance of a map producer. */
	readKind?: "artifact" | "join";
};

export type HyperchartInspectInput = {
	name: string;
	schema: JsonSchema;
	required: boolean;
	defaultValue?: unknown;
};

export type HyperchartInspectTransition = {
	event: string;
	target: string;
	input?: Record<string, string>;
};

export type HyperchartInspectRef = {
	kind: InputRef["kind"] | "artifactOf" | "joinArtifactOf";
	preview: string;
	state?: string;
	name?: string;
	path?: string;
	json?: boolean;
};

export type HyperchartInspectOnReenter =
	| { mode: "restart" }
	| { mode: "resume"; message?: string; refs?: HyperchartInspectRef[] };

export type HyperchartInspectEnv = {
	name: string;
	type: string;
	value?: string;
	schema?: JsonSchema;
};

export type HyperchartInspectGuard =
	| {
			kind: "script";
			command: string;
			args?: string[];
			env?: HyperchartInspectEnv[];
			artifacts?: HyperchartInspectArtifact[];
			reply?: JsonSchema;
	  }
	| { kind: "tsImport"; module: string; export: string };

export type HyperchartInspectBranch = {
	id: string;
	agent?: string;
	task?: string;
};

export type HyperchartInspectActorMessageContract = {
	event: string;
	inputSchema: JsonSchema;
	reply: { kind: "void" } | { kind: "single"; schema: JsonSchema } | { kind: "named"; schemas: Record<string, JsonSchema> };
};

export type HyperchartInspectActorMessageDefinition = {
	kind: "send" | "sendBatch" | "call" | "callBatch" | "receive" | "reply";
	to?: string;
	resolvedTo?: string;
	targetKind?: "actor" | "self";
	event?: string;
	target?: string;
	payload?: { label: "input" | "inputs" | "output"; source: string; schema?: JsonSchema };
	contracts?: HyperchartInspectActorMessageContract[];
};

export type HyperchartInspectState = {
	id: string;
	scopeParentId?: string;
	runtimeStatePath?: string;
	actorInternal?: { declarationPath: string; localState: string; occurrencePath?: string };
	kind: "agent" | "user" | "script" | "send" | "sendBatch" | "call" | "callBatch" | "receive" | "reply" | "map" | "parallel" | "compound" | "region" | "final";
	initial?: boolean;
	definitionSource?: string;
	agent?: string;
	task?: string;
	command?: string;
	env?: HyperchartInspectEnv[];
	reads?: string[];
	readArtifacts?: HyperchartInspectArtifact[];
	refs?: HyperchartInspectRef[];
	inputs?: HyperchartInspectInput[];
	onReenter?: HyperchartInspectOnReenter;
	artifacts?: HyperchartInspectArtifact[];
	reply?: JsonSchema;
	guard?: HyperchartInspectGuard;
	onReject?: OnReject;
	description?: string;
	role?: string;
	model?: string;
	resolvedModel?: string;
	thinking?: string;
	toolset?: string;
	tools?: readonly string[];
	resolvedTools?: readonly string[];
	agentDefinitionUnavailable?: boolean;
	over?: string;
	overSchema?: JsonSchema;
	concurrency?: number;
	regions?: string[];
	branches?: HyperchartInspectBranch[];
	retries?: number;
	transitions?: HyperchartInspectTransition[];
	actorMessageLink?: { kind: "send" | "sendBatch" | "call" | "callBatch"; to: string; event: string; self?: true };
	actorMessageDefinition?: HyperchartInspectActorMessageDefinition;
	finalConfig?: {
		outcome: "complete" | "failed";
		notify?: { prompt?: string; artifacts?: HyperchartInspectArtifact[]; scope?: string };
	};
};

export type HyperchartInspectActorDeclaration = {
	kind: "actor" | "actorPool";
	declarationPath: string;
	ownerPath?: string;
	definitionSource?: string;
	inputSchema: JsonSchema;
	/** Concrete placement value/expression, before runtime reference resolution. */
	inputValue: ValueAst;
	initialReceive: string;
	concurrency?: number;
	protocol: HyperchartInspectActorMessageContract[];
};

export type HyperchartInspectResult = {
	chartId: string;
	args?: Readonly<Record<string, ChartArgumentAst>>;
	chartPath?: string;
	exportName?: string;
	definitionSource?: string;
	mode: "static";
	states: HyperchartInspectState[];
	actorDeclarations?: HyperchartInspectActorDeclaration[];
};

export function inspectChartAst(
	ast: ChartAst,
	options: { chartPath?: string; exportName?: string; agentDefaults?: (agentName: string) => HyperchartInspectAgentDefaults | undefined } = {},
): HyperchartInspectResult {
	return {
		chartId: ast.id,
		...(ast.args === undefined ? {} : { args: ast.args }),
		...(options.chartPath === undefined ? {} : { chartPath: options.chartPath }),
		...(options.exportName === undefined ? {} : { exportName: options.exportName }),
		definitionSource: hyperchartSource(ast, null),
		mode: "static",
		states: statesFromAst(ast, options),
		...(Object.keys(ast.actors).length === 0
			? {}
			: {
					actorDeclarations: Object.values(ast.actors).map((actor) => ({
						kind: actor.kind,
						declarationPath: actor.path,
						...(actor.owner === undefined ? {} : { ownerPath: actor.owner }),
						definitionSource: hyperchartSource(ast, actor.path),
						inputSchema: actor.input.schema,
						inputValue: actor.inputValue,
						initialReceive: actorDefinition(actor).initial,
						...(actor.kind === "actorPool" ? { concurrency: actor.concurrency } : {}),
						protocol: Object.entries(actor.protocol).map(([event, message]) => inspectActorMessageContract(event, message)),
					})),
				}),
	};
}

function statesFromAst(ast: ChartAst, options: { agentDefaults?: (agentName: string) => HyperchartInspectAgentDefaults | undefined } = {}): HyperchartInspectState[] {
	const chartStates = Object.entries(ast.states).map(([path, state]) => {
		const initial = isInitialState(ast, path, state);
		if (state.kind === "final") {
			const notifyArtifacts = referencedArtifacts(state.notify?.artifacts ?? [], ast);
			const prompt = templatePreview(state.notify?.prompt);
			return {
				id: path,
				kind: "final" as const,
				...(initial ? { initial: true } : {}),
				definitionSource: hyperchartSource(ast, path),
				finalConfig: {
					outcome: state.outcome,
					...(state.notify === undefined
						? {}
						: {
							notify: {
								...(prompt === undefined ? {} : { prompt }),
								...(notifyArtifacts.length === 0 ? {} : { artifacts: notifyArtifacts }),
								...(state.notify.scope === undefined ? {} : { scope: state.notify.scope }),
							},
						}),
				},
			};
		}
		const transitions = transitionEntries(state);
		return {
			...stateFromAst(ast, path, state, options),
			...(initial ? { initial: true } : {}),
			definitionSource: hyperchartSource(ast, path),
			...(transitions.length === 0 ? {} : { transitions }),
		};
	});
	return [...chartStates, ...Object.values(ast.actors).flatMap((actor) => actorDefinitionStates(ast, actor, options))];
}

function actorDefinition(actor: ActorEndpointDeclarationAst): ActorDefinitionAst {
	return actor.kind === "actorPool" ? actor.worker : { input: actor.input, protocol: actor.protocol, initial: actor.initial, states: actor.states };
}

function inspectActorMessageContract(event: string, message: ActorDefinitionAst["protocol"][string]): HyperchartInspectActorMessageContract {
	return {
		event,
		inputSchema: message.input.schema,
		reply: message.reply.kind === "void"
			? { kind: "void" }
			: message.reply.kind === "single"
				? { kind: "single", schema: message.reply.schema.schema }
				: { kind: "named", schemas: Object.fromEntries(Object.entries(message.reply.schemas).map(([name, schema]) => [name, schema.schema])) },
	};
}

function outgoingActorMessageDefinition(
	ast: ChartAst,
	state: Extract<StateAst | ActorWorkflowStateAst, { kind: "send" | "sendBatch" | "call" | "callBatch" }>,
): HyperchartInspectActorMessageDefinition {
	const message = ast.actors[state.to]?.protocol[state.event];
	const source = hyperchartValueSource(state.kind === "send" || state.kind === "call" ? state.input : state.inputs);
	const authoredSelf = (state.kind === "send" || state.kind === "sendBatch") && state.self === true;
	return {
		kind: state.kind,
		to: authoredSelf ? "self()" : state.to,
		...(authoredSelf ? { resolvedTo: state.to, targetKind: "self" as const } : { targetKind: "actor" as const }),
		event: state.event,
		...(state.target === undefined ? {} : { target: state.target }),
		payload: {
			label: state.kind === "send" || state.kind === "call" ? "input" : "inputs",
			source,
			...(message === undefined ? {} : { schema: message.input.schema }),
		},
		...(message === undefined ? {} : { contracts: [inspectActorMessageContract(state.event, message)] }),
	};
}

function receiveActorMessageDefinition(actor: ActorEndpointDeclarationAst, state: Extract<ActorWorkflowStateAst, { kind: "receive" }>): HyperchartInspectActorMessageDefinition {
	return {
		kind: "receive",
		contracts: Object.keys(state.on).flatMap((event) => {
			const message = actor.protocol[event];
			return message === undefined ? [] : [inspectActorMessageContract(event, message)];
		}),
	};
}

function replyOutputSchema(actor: ActorEndpointDeclarationAst, event: string | undefined): JsonSchema | undefined {
	const schemas = Object.values(actor.protocol).flatMap((message) => {
		if (message.reply.kind === "single") return event === undefined || event === "reply" ? [message.reply.schema.schema] : [];
		if (message.reply.kind === "named" && event !== undefined) {
			const schema = message.reply.schemas[event];
			return schema === undefined ? [] : [schema.schema];
		}
		return [];
	});
	const unique = new Map(schemas.map((schema) => [JSON.stringify(schema), schema]));
	return unique.size === 1 ? unique.values().next().value : undefined;
}

function replyActorMessageDefinition(actor: ActorEndpointDeclarationAst, state: Extract<ActorWorkflowStateAst, { kind: "reply" }>): HyperchartInspectActorMessageDefinition {
	const schema = replyOutputSchema(actor, state.event);
	return {
		kind: "reply",
		event: state.event ?? "reply",
		target: state.target,
		...(state.output === undefined
			? {}
			: { payload: { label: "output" as const, source: hyperchartValueSource(state.output), ...(schema === undefined ? {} : { schema }) } }),
	};
}

function actorDefinitionStates(
	ast: ChartAst,
	actor: ActorEndpointDeclarationAst,
	options: { agentDefaults?: (agentName: string) => HyperchartInspectAgentDefaults | undefined },
): HyperchartInspectState[] {
	const definition = actorDefinition(actor);
	const actorBase = actor.kind === "actorPool" ? `${actor.path}.$worker` : actor.path;
	return Object.entries(definition.states).map(([localState, state]) => {
		const path = `${actorBase}.${localState}`;
		const common = {
			id: path,
			scopeParentId: actor.path,
			actorInternal: { declarationPath: actor.path, localState },
			...(localState === definition.initial ? { initial: true } : {}),
		};
		if (state.kind === "state") {
			const inspected = actionStateFromAst(ast, path, state as Extract<StateAst, { kind: "state" }>, options);
			return {
				...inspected,
				...common,
				transitions: actorTransitionEntries(actorBase, state),
			};
		}
		if (state.kind === "receive") {
			return {
				...common,
				kind: "receive" as const,
				actorMessageDefinition: receiveActorMessageDefinition(actor, state),
				transitions: Object.entries(state.on).map(([event, target]) => ({ event, target: `${actorBase}.${target}` })),
			};
		}
		if (state.kind === "reply") {
			return {
				...common,
				kind: "reply" as const,
				actorMessageDefinition: replyActorMessageDefinition(actor, state),
				transitions: [{ event: state.event ?? "reply", target: `${actorBase}.${state.target}` }],
			};
		}
		if (state.kind === "send" || state.kind === "sendBatch") {
			const targetLabel = state.self === true ? "self()" : state.to;
			return {
				...common,
				kind: state.kind,
				task: `${state.event} → ${targetLabel}`,
				actorMessageLink: { kind: state.kind, to: state.to, event: state.event, ...(state.self === true ? { self: true as const } : {}) },
				actorMessageDefinition: outgoingActorMessageDefinition(ast, state),
				transitions: [{ event: "ENQUEUED", target: `${actorBase}.${state.target}` }],
			};
		}
		return {
			...common,
			kind: state.kind,
			task: `${state.event} → ${state.to}`,
			actorMessageLink: { kind: state.kind, to: state.to, event: state.event },
			actorMessageDefinition: outgoingActorMessageDefinition(ast, state),
			transitions: actorTransitionEntries(actorBase, state),
		};
	});
}

function actorTransitionEntries(actorBase: string, state: ActorWorkflowStateAst): HyperchartInspectTransition[] {
	if (state.kind === "send" || state.kind === "sendBatch") return [{ event: "ENQUEUED", target: `${actorBase}.${state.target}` }];
	if (state.kind === "reply") return [{ event: state.event ?? "reply", target: `${actorBase}.${state.target}` }];
	if (state.kind === "receive") return Object.entries(state.on).map(([event, target]) => ({ event, target: `${actorBase}.${target}` }));
	if ((state.kind === "call" || state.kind === "callBatch") && state.target !== undefined) return [{ event: "ACTOR_REPLY", target: `${actorBase}.${state.target}` }];
	if (state.kind === "call") return Object.entries(state.transitions).map(([event, transition]) => ({ event, target: `${actorBase}.${transition.target}` }));
	return Object.entries(state.transitions).map(([event, transition]) => ({ event, target: `${actorBase}.${transition.target}` }));
}

function isInitialState(ast: ChartAst, path: string, state: StateAst): boolean {
	if (state.parent === undefined) return path === ast.initial;
	const parent = ast.states[state.parent];
	return parent !== undefined && "initial" in parent && parent.initial === state.id;
}

function stateFromAst(ast: ChartAst, path: string, state: Exclude<StateAst, { kind: "final" }>, options: { agentDefaults?: (agentName: string) => HyperchartInspectAgentDefaults | undefined } = {}): HyperchartInspectState {
	if (state.kind === "state") return actionStateFromAst(ast, path, state, options);
	if (state.kind === "send" || state.kind === "sendBatch") return { id: path, kind: state.kind, task: `${state.event} → ${state.to}`, actorMessageLink: { kind: state.kind, to: state.to, event: state.event }, actorMessageDefinition: outgoingActorMessageDefinition(ast, state) };
	if (state.kind === "call" || state.kind === "callBatch") return { id: path, kind: state.kind, task: `${state.event} → ${state.to}`, actorMessageLink: { kind: state.kind, to: state.to, event: state.event }, actorMessageDefinition: outgoingActorMessageDefinition(ast, state) };
	if (state.kind === "map") {
		const refs = [inputRefInfo(state.over)];
		const inputs = inputDefinitions(state.input);
		const overSchema = inputRefSchema(state.over, ast, path);
		return {
			id: path,
			kind: "map",
			over: inputRefPreview(state.over),
			...(overSchema === undefined ? {} : { overSchema }),
			refs,
			...(inputs === undefined ? {} : { inputs }),
			...(state.onReenter === undefined ? {} : { onReenter: onReenterInfo(state.onReenter) }),
			...(state.concurrency === undefined ? {} : { concurrency: state.concurrency }),
		};
	}
	if (state.kind === "parallel") {
		const regions = state.regions.map((region) => `${path}.${region}`);
		return { id: path, kind: "parallel", regions, branches: branchInfos(ast, path, regions) };
	}
	return { id: path, kind: state.kind };
}

function branchInfos(ast: ChartAst, _path: string, regions: string[]): HyperchartInspectBranch[] {
	return regions.map((regionPath) => {
		const region = ast.states[regionPath];
		const initialPath = region?.kind === "region" ? `${regionPath}.${region.initial}` : undefined;
		const initial = initialPath === undefined ? undefined : ast.states[initialPath];
		const action = initial?.kind === "state" ? initial.action : undefined;
		const task = action === undefined
			? undefined
			: action.kind === "script"
				? [action.command, ...action.args].join(" ")
				: templatePreview(action.kind === "agent" ? action.task : action.prompt);
		return {
			id: regionPath,
			...(action?.kind === "agent" ? { agent: action.name } : {}),
			...(task === undefined ? {} : { task }),
		};
	});
}

function actionStateFromAst(ast: ChartAst, path: string, state: Extract<StateAst, { kind: "state" }>, options: { agentDefaults?: (agentName: string) => HyperchartInspectAgentDefaults | undefined } = {}): HyperchartInspectState {
	const action = state.action;
	const refs = actionRefs(action);
	const reads = action.kind === "agent"
		? (action.reads ?? []).map((read) => read.kind === "artifactOf" || read.kind === "joinArtifactOf" ? artifactRefPreview(read) : templatePreview(read)).filter((read): read is string => read !== undefined)
		: [];
	const readArtifacts = action.kind === "agent" ? referencedReadArtifacts(action, ast) : [];
	const artifacts = actionArtifacts(action, state.validate);
	const inputs = inputDefinitions(state.input);
	const base = {
		id: path,
		...(reads.length === 0 ? {} : { reads: [...new Set(reads)] }),
		...(readArtifacts.length === 0 ? {} : { readArtifacts }),
		...(refs.length === 0 ? {} : { refs }),
		...(inputs === undefined ? {} : { inputs }),
		...(state.onReenter === undefined ? {} : { onReenter: onReenterInfo(state.onReenter) }),
		...(artifacts.length === 0 ? {} : { artifacts }),
		...(action.reply === undefined ? {} : { reply: action.reply.schema }),
		...(state.validate === undefined ? {} : { guard: guardInfo(state.validate, ast, path), onReject: state.onReject ?? "resume" }),
		...(state.retries === undefined ? {} : { retries: state.retries }),
	};
	if (action.kind === "agent") {
		const task = templatePreview(action.task);
		const defaults = options.agentDefaults?.(action.name);
		const description = defaults?.description;
		const role = defaults?.role;
		const model = action.model ?? defaults?.model;
		const resolvedModel = action.model ?? defaults?.resolvedModel ?? (defaults?.role === undefined ? model : undefined);
		const thinking = action.thinking ?? defaults?.thinking;
		const toolset = defaults?.toolset;
		const tools = action.tools ?? defaults?.tools;
		const resolvedTools = action.tools === undefined
			? (defaults?.resolvedTools ?? (tools === undefined || defaults?.toolset !== undefined ? undefined : withFinishTool(tools)))
			: withFinishTool(action.tools);
		return {
			...base,
			kind: "agent",
			agent: action.name,
			...(description === undefined ? {} : { description }),
			...(task === undefined ? {} : { task }),
			...(role === undefined ? {} : { role }),
			...(model === undefined ? {} : { model }),
			...(resolvedModel === undefined ? {} : { resolvedModel }),
			...(thinking === undefined ? {} : { thinking }),
			...(toolset === undefined ? {} : { toolset }),
			...(tools === undefined ? {} : { tools }),
			...(resolvedTools === undefined ? {} : { resolvedTools }),
			...(defaults?.agentDefinitionUnavailable === true ? { agentDefinitionUnavailable: true } : {}),
		};
	}
	if (action.kind === "script") {
		const env = envInfo(action.env, ast, path);
		return {
			...base,
			kind: "script",
			command: [action.command, ...action.args].join(" "),
			...(env === undefined ? {} : { env }),
		};
	}
	const task = templatePreview(action.prompt);
	return { ...base, kind: "user", ...(task === undefined ? {} : { task }) };
}

function withFinishTool(tools: readonly string[]): string[] {
	return [...new Set([...tools, "finish"])];
}

function guardInfo(guard: GuardRefAst, ast: ChartAst, statePath: string): HyperchartInspectGuard {
	if (guard.kind === "script") {
		const env = envInfo(guard.env, ast, statePath);
		const artifacts = "artifacts" in guard ? actionArtifactsFromMap(guard.artifacts as Readonly<Record<string, ArtifactAst>>) : [];
		return {
			kind: "script",
			command: guard.command,
			...(guard.args === undefined ? {} : { args: [...guard.args] }),
			...(env === undefined ? {} : { env }),
			...(artifacts.length === 0 ? {} : { artifacts }),
			...(guard.reply === undefined ? {} : { reply: (guard.reply as SchemaAst).schema }),
		};
	}
	return { kind: "tsImport", module: guard.module, export: guard.export };
}

function envInfo(env: Readonly<Record<string, string | TemplateAst | ArtifactOfAst | JoinArtifactOfAst>> | undefined, ast: ChartAst, statePath: string): HyperchartInspectEnv[] | undefined {
	if (env === undefined) return undefined;
	const entries = Object.entries(env).map(([name, value]): HyperchartInspectEnv => {
		if (typeof value === "string") return { name, type: "string", value };
		if (value.kind === "artifactOf") return { name, type: "string (artifact path)", value: artifactRefPreview(value) };
		if (value.kind === "joinArtifactOf") return { name, type: "string (joined artifact paths)", value: artifactRefPreview(value) };
		const preview = templatePreview(value);
		const schema = jsonTemplateSchema(value, ast, statePath);
		return {
			name,
			type: schema === undefined ? (value.refs.length === 0 ? "string" : "string template") : "JSON string",
			...(preview === undefined ? {} : { value: preview }),
			...(schema === undefined ? {} : { schema }),
		};
	});
	return entries.length === 0 ? undefined : entries;
}

function jsonTemplateSchema(template: TemplateAst, ast: ChartAst, statePath: string): JsonSchema | undefined {
	if (template.refs.length !== 1 || template.strings.some((chunk) => chunk !== "")) return undefined;
	const ref = template.refs[0];
	if (ref === undefined || ref.json !== true) return undefined;
	return inputRefSchema(ref, ast, statePath);
}

function inputRefSchema(ref: InputRef, ast: ChartAst, statePath: string): JsonSchema | undefined {
	switch (ref.kind) {
		case "result": {
			const state = ast.states[ref.state];
			const schema = state?.kind === "state" ? state.action.reply?.schema : undefined;
			return schema === undefined ? undefined : jsonSchemaAtPath(schema, ref.path);
		}
		case "input": {
			const state = ast.states[statePath];
			const schema = state?.kind === "state" || state?.kind === "map" ? state.input?.[ref.name]?.schema : undefined;
			return schema === undefined ? undefined : jsonSchemaAtPath(schema, ref.path);
		}
		case "visit":
			return { type: "integer" };
		case "key":
			return { type: "string" };
		case "actorInput":
		case "messageInput":
		default:
			return undefined;
	}
}

function jsonSchemaAtPath(schema: JsonSchema, path: string | undefined): JsonSchema | undefined {
	if (path === undefined || path.length === 0) return schema;
	let current: JsonSchema | undefined = schema;
	for (const segment of path.split(".")) {
		if (current === undefined) return undefined;
		const properties = current.properties as Record<string, JsonSchema> | undefined;
		const arrayItems = current.items as JsonSchema | undefined;
		const additionalProperties = current.additionalProperties as JsonSchema | boolean | undefined;
		if (properties?.[segment] !== undefined) current = properties[segment];
		else if (current.type === "array" && arrayItems !== undefined) current = arrayItems;
		else if (typeof additionalProperties === "object" && additionalProperties !== null) current = additionalProperties;
		else return undefined;
	}
	return current;
}

function inputDefinitions(input: Readonly<Record<string, SchemaAst>> | undefined): HyperchartInspectInput[] | undefined {
	if (input === undefined) return undefined;
	const entries = Object.entries(input).map(([name, schema]) => {
		const record = schema.schema as Record<string, unknown>;
		return {
			name,
			schema: schema.schema,
			required: !("default" in record),
			...("default" in record ? { defaultValue: record.default } : {}),
		};
	});
	return entries.length === 0 ? undefined : entries;
}

function onReenterInfo(value: OnReenterAst): HyperchartInspectOnReenter {
	if (value === "restart") return { mode: "restart" };
	const refs = templateRefs(value.message);
	const message = templatePreview(value.message);
	return { mode: "resume", ...(message === undefined ? {} : { message }), ...(refs.length === 0 ? {} : { refs }) };
}

function artifactInfo(name: string, artifact: ArtifactAst): HyperchartInspectArtifact {
	const path = templatePreview(artifact.path);
	return {
		name,
		...(path === undefined ? {} : { path }),
		...(artifact.shape === undefined ? {} : { shape: artifact.shape.schema }),
	};
}

function actionArtifacts(action: StateActionAst, guard: GuardRefAst | undefined): HyperchartInspectArtifact[] {
	const entries = action.kind === "user" ? [] : Object.entries(action.artifacts ?? {});
	const guardEntries = guard?.kind === "script" && "artifacts" in guard ? Object.entries(guard.artifacts ?? {}) : [];
	return [...entries, ...guardEntries].map(([name, artifact]) => artifactInfo(name, artifact));
}

function actionArtifactsFromMap(artifacts: Readonly<Record<string, ArtifactAst>> | undefined): HyperchartInspectArtifact[] {
	return Object.entries(artifacts ?? {}).map(([name, artifact]) => artifactInfo(name, artifact));
}

function referencedReadArtifacts(action: AgentActionAst, ast: ChartAst): HyperchartInspectArtifact[] {
	return referencedArtifacts(action.reads ?? [], ast);
}

function referencedArtifacts(reads: readonly (TemplateAst | ArtifactOfAst | JoinArtifactOfAst)[], ast: ChartAst): HyperchartInspectArtifact[] {
	const artifacts = reads.flatMap((read) => {
		if (read.kind !== "artifactOf" && read.kind !== "joinArtifactOf") return [];
		const producer = ast.states[read.state];
		if (producer?.kind !== "state") return [];
		const declared = actionArtifacts(producer.action, producer.validate);
		const artifact = read.artifact === undefined
			? declared.length === 1 ? declared[0] : undefined
			: declared.find((candidate) => candidate.name === read.artifact);
		return artifact === undefined ? [] : [{
			...artifact,
			sourceState: read.state,
			...(read.kind === "joinArtifactOf" ? { readKind: "join" as const } : {}),
		}];
	});
	return artifacts.filter((artifact, index) => artifacts.findIndex((candidate) => candidate.sourceState === artifact.sourceState && candidate.name === artifact.name && candidate.path === artifact.path && candidate.readKind === artifact.readKind) === index);
}

function transitionEntries(state: Exclude<StateAst, { kind: "final" }>): HyperchartInspectTransition[] {
	const entries = Object.entries(state.transitions).map(([event, transition]) => ({
		event,
		target: siblingStatePath(state.parent, transition.target),
		...(transition.input === undefined ? {} : { input: eventBindingsInfo(transition.input) }),
	}));
	if (state.kind === "send" || state.kind === "sendBatch") {
		entries.push({ event: "ENQUEUED", target: siblingStatePath(state.parent, state.target) });
	}
	if ((state.kind === "call" || state.kind === "callBatch") && state.target !== undefined) {
		entries.push({ event: "ACTOR_REPLY", target: siblingStatePath(state.parent, state.target) });
	}
	if (state.kind === "compound" || state.kind === "parallel" || state.kind === "map") {
		entries.push({ event: "onDone", target: siblingStatePath(state.parent, state.onDone) });
	}
	if (state.kind === "state" && state.after !== undefined) {
		entries.push({
			event: `after:${state.after.delayMs}ms`,
			target: siblingStatePath(state.parent, state.after.target),
		});
	}
	return entries;
}

function eventBindingsInfo(input: Readonly<Record<string, EventBindingAst>>): Record<string, string> {
	return Object.fromEntries(Object.entries(input).map(([name, binding]) => [name, eventBindingPreview(binding)]));
}

function eventBindingPreview(binding: EventBindingAst): string {
	return binding.path === undefined ? "event()" : `event:${binding.path}`;
}

function siblingStatePath(parent: string | undefined, localId: string): string {
	return parent === undefined ? localId : `${parent}.${localId}`;
}

function actionRefs(action: StateActionAst): HyperchartInspectRef[] {
	const refs: HyperchartInspectRef[] = [];
	if (action.kind === "agent") {
		for (const read of action.reads ?? []) appendReadRefs(refs, read);
		appendTemplateRefs(refs, action.task);
	} else if (action.kind === "script") {
		for (const value of Object.values(action.env ?? {})) appendReadRefs(refs, value);
	} else {
		appendTemplateRefs(refs, action.prompt);
	}
	return uniqueRefs(refs);
}

function appendReadRefs(refs: HyperchartInspectRef[], value: TemplateAst | ArtifactOfAst | JoinArtifactOfAst): void {
	if (value.kind === "artifactOf" || value.kind === "joinArtifactOf") {
		const path = [value.artifact, value.kind === "artifactOf" ? value.select : undefined].filter(Boolean).join(".");
		refs.push({
			kind: value.kind,
			preview: artifactRefPreview(value),
			state: value.state,
			...(path === "" ? {} : { path }),
		});
		return;
	}
	appendTemplateRefs(refs, value);
}

function appendTemplateRefs(refs: HyperchartInspectRef[], value: TemplateAst | undefined): void {
	refs.push(...templateRefs(value));
}

function templateRefs(value: TemplateAst | undefined): HyperchartInspectRef[] {
	if (value === undefined) return [];
	return value.refs.map(inputRefInfo);
}

function templatePreview(value: TemplateAst | undefined): string | undefined {
	if (value === undefined) return undefined;
	const rendered = value.strings.reduce((acc, chunk, index) => {
		const ref = value.refs[index];
		return ref === undefined ? `${acc}${chunk}` : `${acc}${chunk}{${inputRefPreview(ref)}}`;
	}, "");
	return rendered.trim() || undefined;
}

function inputRefInfo(ref: InputRef): HyperchartInspectRef {
	const preview = inputRefPreview(ref);
	const common = { kind: ref.kind, preview, ...(ref.json === true ? { json: true } : {}) };
	switch (ref.kind) {
		case "arg":
			return { ...common, name: ref.name };
		case "result":
			return { ...common, state: ref.state, ...(ref.path === undefined ? {} : { path: ref.path }) };
		case "key":
			return { ...common, ...(ref.map === undefined ? {} : { state: ref.map }) };
		case "item":
			return { ...common, ...(ref.map === undefined ? {} : { state: ref.map }), ...(ref.path === undefined ? {} : { path: ref.path }) };
		case "input":
			return { ...common, name: ref.name, ...(ref.path === undefined ? {} : { path: ref.path }) };
		case "visit":
			return { ...common, ...(ref.state === undefined ? {} : { state: ref.state }) };
		case "actorInput":
			return { ...common, ...(ref.path === undefined ? {} : { path: ref.path }) };
		case "messageInput":
			return { ...common, name: ref.message, ...(ref.path === undefined ? {} : { path: ref.path }) };
	}
}

function literal(value: string): string {
	return JSON.stringify(value);
}

function artifactRefPreview(ref: ArtifactOfAst | JoinArtifactOfAst): string {
	if (ref.kind === "joinArtifactOf") {
		const options = ref.artifact === undefined ? undefined : `{ artifact: ${literal(ref.artifact)} }`;
		return options === undefined ? `joinArtifactOf(${literal(ref.state)})` : `joinArtifactOf(${literal(ref.state)}, ${options})`;
	}
	const entries = [ref.artifact === undefined ? undefined : `artifact: ${literal(ref.artifact)}`, ref.select === undefined ? undefined : `select: ${literal(ref.select)}`].filter((entry): entry is string => entry !== undefined);
	return entries.length === 0 ? `artifactOf(${literal(ref.state)})` : `artifactOf(${literal(ref.state)}, { ${entries.join(", ")} })`;
}

function inputRefPreview(ref: InputRef): string {
	const rendered = inputRefPreviewBase(ref);
	return ref.json === true ? `json(${rendered})` : rendered;
}

function inputRefPreviewBase(ref: InputRef): string {
	switch (ref.kind) {
		case "arg":
			return `arg(${literal(ref.name)})`;
		case "result":
			return ref.path === undefined ? `result(${literal(ref.state)})` : `result(${literal(ref.state)}, ${literal(ref.path)})`;
		case "key":
			return ref.map === undefined ? "key()" : `key(${literal(ref.map)})`;
		case "item":
			if (ref.map !== undefined) return ref.path === undefined ? `item(${literal(ref.map)})` : `item(${literal(ref.map)}, ${literal(ref.path)})`;
			return ref.path === undefined ? "item()" : `item(${literal(ref.path)})`;
		case "input":
			return ref.path === undefined ? `input(${literal(ref.name)})` : `input(${literal(ref.name)}, ${literal(ref.path)})`;
		case "visit":
			return ref.state === undefined ? "visit()" : `visit(${literal(ref.state)})`;
		case "actorInput":
			return ref.path === undefined ? "actorInput()" : `actorInput(${literal(ref.path)})`;
		case "messageInput":
			return ref.path === undefined
				? `messageInput(${literal(ref.message)})`
				: `messageInput(${literal(ref.message)}, ${literal(ref.path)})`;
	}
}

function uniqueRefs(refs: HyperchartInspectRef[]): HyperchartInspectRef[] {
	const seen = new Set<string>();
	const unique: HyperchartInspectRef[] = [];
	for (const ref of refs) {
		const key = JSON.stringify(ref);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(ref);
	}
	return unique;
}
