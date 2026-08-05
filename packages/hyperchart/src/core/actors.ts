import type { ActorDeclarationAst, ActorWorkflowStateAst, ChartAst, StatePath } from "./types.js";
import { instancePathFor, templatePath } from "./paths.js";

const declarationsByChart = new WeakMap<ChartAst, readonly ActorDeclarationAst[]>();

function sortedActorDeclarations(ast: ChartAst): readonly ActorDeclarationAst[] {
	const cached = declarationsByChart.get(ast);
	if (cached !== undefined) return cached;
	const declarations = Object.values(ast.actors).sort((left, right) => right.path.length - left.path.length);
	declarationsByChart.set(ast, declarations);
	return declarations;
}

export function actorOccurrencePath(declaration: ActorDeclarationAst, ownerOccurrence?: StatePath): StatePath {
	return ownerOccurrence === undefined ? declaration.path : instancePathFor(declaration.path, ownerOccurrence);
}

export function actorGenerationPath(logicalOccurrence: StatePath, generation: number): StatePath {
	return generation === 1 ? logicalOccurrence : `${logicalOccurrence}~${generation}`;
}

export function actorStatePath(occurrence: StatePath, localState: StatePath): StatePath {
	return `${occurrence}.${localState}`;
}

export function actorDeclarationForOccurrence(ast: ChartAst, occurrence: StatePath): ActorDeclarationAst | undefined {
	return ast.actors[templatePath(occurrence)];
}

export function actorContextForState(
	ast: ChartAst,
	statePath: StatePath,
): { declaration: ActorDeclarationAst; occurrence: StatePath; localState: StatePath; node: ActorWorkflowStateAst } | undefined {
	const template = templatePath(statePath);
	const declaration = sortedActorDeclarations(ast).find((actor) => template.startsWith(`${actor.path}.`));
	if (declaration === undefined) return undefined;
	const localState = template.slice(declaration.path.length + 1);
	const node = declaration.states[localState];
	if (node === undefined) return undefined;
	const suffixSegments = localState.split(".").length;
	const occurrence = statePath.split(".").slice(0, -suffixSegments).join(".");
	return { declaration, occurrence, localState, node };
}

export function actorNodeAt(ast: ChartAst, statePath: StatePath): ActorWorkflowStateAst | undefined {
	return actorContextForState(ast, statePath)?.node;
}
