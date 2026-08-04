import type { HyperchartStateInfo, HyperchartStateType } from "../../../types.js";
import { isImplicitFailedFinal, localStateId } from "./state.js";

export function immediateMapScopeId(stateId: string): string | undefined {
	const idx = stateId.lastIndexOf("#");
	if (idx !== -1) return stateId.slice(0, idx);
	const dot = stateId.lastIndexOf(".");
	return dot === -1 ? undefined : stateId.slice(0, dot);
}

export function stateScopeParentId(state: HyperchartStateInfo): string | undefined {
	return state.scopeParentId ?? immediateMapScopeId(state.id);
}

/** Scope stack required to reveal a concrete state in the graph. */
export function scopeStackForState(states: readonly HyperchartStateInfo[], stateId: string): string[] {
	const byId = new Map(states.map((state) => [state.id, state]));
	const stack: string[] = [];
	let cursor = byId.get(stateId);
	const seen = new Set<string>();
	while (cursor !== undefined) {
		const parentId = stateScopeParentId(cursor);
		if (parentId === undefined || seen.has(parentId)) break;
		seen.add(parentId);
		const parent = byId.get(parentId);
		if (parent === undefined) break;
		stack.unshift(parent.id);
		cursor = parent;
	}
	return stack;
}

export function visibleStateIdsForScope(
	states: HyperchartStateInfo[],
	options: {
		scopeId?: string | null;
		showDone?: boolean;
		showPending?: boolean;
		showSkipped?: boolean;
		showMapWorkers?: boolean;
	} = {},
): Set<string> {
	const visible = new Set<string>();
	const scopeId = options.scopeId ?? null;
	const showDone = options.showDone ?? true;
	const showPending = options.showPending ?? true;
	const showSkipped = options.showSkipped ?? false;
	const showMapWorkers = options.showMapWorkers ?? false;
	for (const state of states) {
		if (isImplicitFailedFinal(state)) continue;
		if (!state.final) {
			if (!showDone && state.status === "done") continue;
			if (!showPending && (state.status === "pending" || state.status === "stale")) continue;
			if (!showSkipped && state.status === "skipped") continue;
		}
		const directScope = stateScopeParentId(state);
		if (scopeId) {
			if (directScope !== scopeId) continue;
		} else if (!showMapWorkers && directScope !== undefined) {
			continue;
		}
		visible.add(state.id);
	}
	return visible;
}

export function effectiveDisplayType(
	state: HyperchartStateInfo,
	stateById: Map<string, HyperchartStateInfo>,
): HyperchartStateType | undefined {
	const parent = stateScopeParentId(state);
	const parentState = parent ? stateById.get(parent) : undefined;
	if (state.type === "compound" && parentState?.type === "parallel") return "region";
	return state.type;
}

function directChildrenOf(state: HyperchartStateInfo, states: HyperchartStateInfo[]): HyperchartStateInfo[] {
	return states.filter(
		(candidate) => stateScopeParentId(candidate) === state.id && !isImplicitFailedFinal(candidate),
	);
}

export function childPreviewForState(
	state: HyperchartStateInfo,
	states: HyperchartStateInfo[],
	stateById: Map<string, HyperchartStateInfo>,
): string | undefined {
	const displayType = effectiveDisplayType(state, stateById);
	if (displayType !== "region" && displayType !== "compound") return undefined;
	const children = directChildrenOf(state, states);
	const activeChildren = children.filter((child) => !child.final);
	const finalChildren = children.filter((child) => child.final).map((child) => localStateId(child.id));
	if (activeChildren.length === 0 && finalChildren.length === 0) return undefined;
	const active = activeChildren.map((child) => localStateId(child.id)).join(" + ");
	const done = finalChildren.length > 0 ? finalChildren.join(" / ") : "final";
	return active ? `${active} → ${done}` : `→ ${done}`;
}
