import type {
	ActorDefinitionAst,
	ActorEndpointDeclarationAst,
	ActorWorkflowStateAst,
	ChartAst,
	StatePath,
} from "./types.js";
import { instancePathFor, templatePath } from "./paths.js";

const declarationsByChart = new WeakMap<ChartAst, readonly ActorEndpointDeclarationAst[]>();

function sortedActorDeclarations(ast: ChartAst): readonly ActorEndpointDeclarationAst[] {
	const cached = declarationsByChart.get(ast);
	if (cached !== undefined) return cached;
	const declarations = Object.values(ast.actors).sort((left, right) => right.path.length - left.path.length);
	declarationsByChart.set(ast, declarations);
	return declarations;
}

export function actorDefinitionForEndpoint(declaration: ActorEndpointDeclarationAst): ActorDefinitionAst {
	return declaration.kind === "actorPool"
		? declaration.worker
		: {
				input: declaration.input,
				protocol: declaration.protocol,
				initial: declaration.initial,
				states: declaration.states,
			};
}

export function actorOccurrencePath(declaration: ActorEndpointDeclarationAst, ownerOccurrence?: StatePath): StatePath {
	return ownerOccurrence === undefined ? declaration.path : instancePathFor(declaration.path, ownerOccurrence);
}

export function actorGenerationPath(logicalOccurrence: StatePath, generation: number): StatePath {
	return generation === 1 ? logicalOccurrence : `${logicalOccurrence}~${generation}`;
}

export function actorLogicalOccurrencePath(occurrence: StatePath, generation: number): StatePath {
	if (generation === 1) return occurrence;
	const suffix = `~${generation}`;
	return occurrence.endsWith(suffix) ? occurrence.slice(0, -suffix.length) : occurrence;
}

/** Concrete persistent worker identity owned by one pool endpoint generation. */
export function actorPoolWorkerOccurrencePath(poolOccurrence: StatePath, index: number): StatePath {
	return `${poolOccurrence}.$worker-${index}`;
}

/** Canonical normalized worker template identity. */
export function actorPoolWorkerTemplatePath(poolDeclaration: StatePath): StatePath {
	return `${poolDeclaration}.$worker`;
}

export function parseActorPoolWorkerOccurrence(path: StatePath): { endpointOccurrence: StatePath; workerIndex: number } | undefined {
	const match = /^(.*)\.\$worker-([0-9]+)$/.exec(path);
	if (match === null) return undefined;
	const workerIndex = Number(match[2]);
	if (!Number.isSafeInteger(workerIndex)) return undefined;
	return { endpointOccurrence: match[1] ?? "", workerIndex };
}

export function actorStatePath(occurrence: StatePath, localState: StatePath): StatePath {
	return `${occurrence}.${localState}`;
}

export function actorDeclarationForOccurrence(ast: ChartAst, occurrence: StatePath): ActorEndpointDeclarationAst | undefined {
	const worker = parseActorPoolWorkerOccurrence(occurrence);
	const endpoint = worker?.endpointOccurrence ?? occurrence;
	return ast.actors[templatePath(endpoint)];
}

export type ActorStateContext = {
	declaration: ActorEndpointDeclarationAst;
	/** Executable occurrence: the actor endpoint or one concrete pool worker. */
	occurrence: StatePath;
	/** Endpoint occurrence. Equal to occurrence for ordinary actors. */
	endpointOccurrence: StatePath;
	localState: StatePath;
	node: ActorWorkflowStateAst;
	workerIndex?: number;
};

export function actorContextForState(ast: ChartAst, statePath: StatePath): ActorStateContext | undefined {
	const template = templatePath(statePath);
	const declaration = sortedActorDeclarations(ast).find((endpoint) => {
		const prefix = endpoint.kind === "actorPool" ? `${endpoint.path}.$worker.` : `${endpoint.path}.`;
		return template.startsWith(prefix);
	});
	if (declaration === undefined) return undefined;
	const canonicalOccurrence = declaration.kind === "actorPool" ? `${declaration.path}.$worker` : declaration.path;
	const localState = template.slice(canonicalOccurrence.length + 1);
	const node = actorDefinitionForEndpoint(declaration).states[localState];
	if (node === undefined) return undefined;
	const suffixSegments = localState.split(".").length;
	const occurrence = statePath.split(".").slice(0, -suffixSegments).join(".");
	if (declaration.kind !== "actorPool") {
		return { declaration, occurrence, endpointOccurrence: occurrence, localState, node };
	}
	const parsed = parseActorPoolWorkerOccurrence(occurrence);
	if (parsed === undefined) return undefined;
	return {
		declaration,
		occurrence,
		endpointOccurrence: parsed.endpointOccurrence,
		localState,
		node,
		workerIndex: parsed.workerIndex,
	};
}

export function actorNodeAt(ast: ChartAst, statePath: StatePath): ActorWorkflowStateAst | undefined {
	return actorContextForState(ast, statePath)?.node;
}
