import { actionUidKey } from "../core/action_uid.js";
import { childPath, nodeAt, parentPath, siblingPath, templatePath } from "../core/paths.js";
import type { BranchProjection } from "../core/projection.js";
import type { ActionStateAst, ChartAst, StatePath } from "../core/types.js";

export type ProjectionRetentionPlan = Readonly<{
	/** Result producer template path -> every statically discovered reader template path. */
	resultReaders: ReadonlyMap<StatePath, ReadonlySet<StatePath>>;
	/** Map scopes whose values may be read from outside the scope. */
	externallyReadMapScopes: ReadonlySet<StatePath>;
	/** Template action UID keys whose session may be resumed on re-entry. */
	resumableActions: ReadonlySet<string>;
	/** States that are initial/transition targets or explicitly define re-entry behavior. */
	reenterableStates: ReadonlySet<StatePath>;
}>;

/**
 * Compile facts that are safe to discover from the normalized AST alone.
 *
 * This intentionally is not a whole-chart liveness proof. Dynamic map instances,
 * guards, loops and actor-local control retain projection values until a separately
 * approved data-flow analysis can prove their final read has passed.
 */
export function compileProjectionRetention(ast: ChartAst): ProjectionRetentionPlan {
	const resultReaders = new Map<StatePath, Set<StatePath>>();
	const externallyReadMapScopes = new Set<StatePath>();
	const resumableActions = new Set<string>();
	const reenterableStates = new Set<StatePath>([ast.initial]);
	const mapScopes = Object.entries(ast.states).flatMap(([path, node]) => node.kind === "map" ? [path] : []);

	for (const [readerPath, node] of Object.entries(ast.states)) {
		for (const resultState of resultRefs(node)) {
			const readers = resultReaders.get(resultState) ?? new Set<StatePath>();
			readers.add(readerPath);
			resultReaders.set(resultState, readers);
			for (const mapPath of mapScopes) {
				if ((resultState === mapPath || resultState.startsWith(`${mapPath}.`)) && !(readerPath === mapPath || readerPath.startsWith(`${mapPath}.`))) {
					externallyReadMapScopes.add(mapPath);
				}
			}
		}
		if ("transitions" in node) {
			for (const transition of Object.values(node.transitions)) {
				reenterableStates.add(siblingPath(readerPath, transition.target));
			}
		}
		if ("target" in node && typeof node.target === "string") {
			reenterableStates.add(siblingPath(readerPath, node.target));
		}
		if (node.kind === "state" && node.after !== undefined) {
			reenterableStates.add(siblingPath(readerPath, node.after.target));
		}
		if (node.kind === "parallel") {
			for (const region of node.regions) {
				const regionPath = childPath(readerPath, region);
				reenterableStates.add(regionPath);
				const regionNode = ast.states[regionPath];
				if (regionNode?.kind === "region") reenterableStates.add(childPath(regionPath, regionNode.initial));
			}
			reenterableStates.add(siblingPath(readerPath, node.onDone));
		}
		if (node.kind === "compound" || node.kind === "region") {
			reenterableStates.add(childPath(readerPath, node.initial));
			if (node.kind === "compound") reenterableStates.add(siblingPath(readerPath, node.onDone));
		}
		if (node.kind === "map") {
			reenterableStates.add(childPath(readerPath, node.initial));
			reenterableStates.add(siblingPath(readerPath, node.onDone));
		}
		if ((node.kind === "state" || node.kind === "map") && node.onReenter !== undefined) {
			reenterableStates.add(readerPath);
		}
		if (isResumableAction(ast, readerPath, node)) resumableActions.add(actionUidKey(node.action.uid));
	}

	// Actor workflow reachability is occurrence-relative and may include nested map
	// scopes. Retain their sessions until that analysis is modeled explicitly.
	for (const declaration of Object.values(ast.actors)) {
		walkValues(declaration, (value) => {
			if (isActionLike(value) && value.action.kind === "agent") resumableActions.add(actionUidKey(value.action.uid));
		});
	}

	return {
		resultReaders: new Map([...resultReaders].map(([path, readers]) => [path, new Set(readers)])),
		externallyReadMapScopes,
		resumableActions,
		reenterableStates,
	};
}

/**
 * Synchronous conservative GC seam. Only non-resumable session references are
 * currently pruned: machine.ts is their sole synchronous semantic reader. All
 * inputs/results/spawns/actor state remain when future readability is ambiguous.
 */
export function compactProjection(
	projection: BranchProjection,
	ast: ChartAst,
	retention: ProjectionRetentionPlan,
): void {
	for (const key of Object.keys(projection.sessions)) {
		const templateKey = templateActionKey(key);
		if (templateKey === undefined || retention.resumableActions.has(templateKey)) continue;
		delete projection.sessions[key];
	}
	const retainedMessageIds = new Set<string>();
	for (const endpoint of [...Object.values(projection.actors), ...Object.values(projection.actorPools)]) {
		for (const messageId of endpoint.mailbox) retainedMessageIds.add(messageId);
		if ("workers" in endpoint) {
			for (const worker of endpoint.workers) if (worker.currentMessageId !== undefined) retainedMessageIds.add(worker.currentMessageId);
		} else if (endpoint.currentMessageId !== undefined) retainedMessageIds.add(endpoint.currentMessageId);
	}
	for (const call of Object.values(projection.pendingActorCalls)) {
		if (call.kind === "singleton") retainedMessageIds.add(call.messageId);
		else for (const messageId of call.messageIds) retainedMessageIds.add(messageId);
	}
	for (const messageId of Object.keys(projection.liveActorMessages)) {
		if (!retainedMessageIds.has(messageId)) delete projection.liveActorMessages[messageId];
	}
	void ast;
}

function isResumableAction(ast: ChartAst, path: StatePath, node: unknown): node is ActionStateAst {
	if (!isActionLike(node) || node.action.kind !== "agent") return false;
	if (typeof node.onReenter === "object") return true;
	let parent = parentPath(path);
	while (parent !== undefined) {
		const ancestor = nodeAt(ast, parent);
		if (ancestor?.kind === "map" && typeof ancestor.onReenter === "object") return true;
		parent = parentPath(parent);
	}
	return false;
}

function isActionLike(value: unknown): value is ActionStateAst {
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "state" &&
		typeof (value as { action?: unknown }).action === "object" && (value as { action?: unknown }).action !== null;
}

function resultRefs(value: unknown): StatePath[] {
	const refs = new Set<StatePath>();
	walkValues(value, (candidate) => {
		if (candidate.kind === "result" && typeof candidate.state === "string") refs.add(candidate.state);
	});
	return [...refs];
}

function walkValues(value: unknown, visit: (value: Record<string, unknown>) => void): void {
	if (Array.isArray(value)) {
		for (const entry of value) walkValues(entry, visit);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	const record = value as Record<string, unknown>;
	visit(record);
	for (const child of Object.values(record)) walkValues(child, visit);
}

function templateActionKey(key: string): string | undefined {
	const first = key.indexOf(":");
	const last = key.lastIndexOf(":");
	if (first <= 0 || last <= first) return undefined;
	return `${key.slice(0, first)}:${templatePath(key.slice(first + 1, last))}:${key.slice(last + 1)}`;
}
