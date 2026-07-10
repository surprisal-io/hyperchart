import type { HyperchartRunInfo, HyperchartStateInfo } from "../../../types.js";
import { isImplicitFailedFinal } from "../helpers/state.js";

export type StateTransitionEdge = { source: string; target: string; labels: string[] };

export type GraphInput = {
	stateById: Map<string, HyperchartStateInfo>;
	stateOrder: Map<string, number>;
	visibleStates: HyperchartStateInfo[];
	effectiveVisibleIds: Set<string>;
	transitionEdges: StateTransitionEdge[];
	useStateTransitions: boolean;
};

function stateTransitionEdges(run: HyperchartRunInfo, visibleIds: Set<string>): StateTransitionEdge[] {
	const grouped = new Map<string, StateTransitionEdge>();
	for (const state of run.states) {
		if (!visibleIds.has(state.id)) continue;
		for (const transition of state.transitions ?? []) {
			if (transition.target === state.id || !visibleIds.has(transition.target)) continue;
			const key = `${state.id}\u0000${transition.target}`;
			const existing = grouped.get(key);
			if (existing) {
				if (!existing.labels.includes(transition.event)) existing.labels.push(transition.event);
			} else {
				grouped.set(key, { source: state.id, target: transition.target, labels: [transition.event] });
			}
		}
	}
	return [...grouped.values()];
}

export function graphInput(run: HyperchartRunInfo, visibleIds: Set<string>): GraphInput {
	const stateById = new Map(run.states.map((state) => [state.id, state]));
	const stateOrder = new Map(run.states.map((state, index) => [state.id, index]));
	const visibleStates = run.states.filter((state) => visibleIds.has(state.id) && !isImplicitFailedFinal(state));
	const effectiveVisibleIds = new Set(visibleStates.map((state) => state.id));
	const transitionEdges = stateTransitionEdges(run, effectiveVisibleIds);
	return {
		stateById,
		stateOrder,
		visibleStates,
		effectiveVisibleIds,
		transitionEdges,
		useStateTransitions: transitionEdges.length > 0,
	};
}
