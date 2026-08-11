import type { HyperchartRunInfo, HyperchartStateInfo } from "../../../types.js";
import { isImplicitFailedFinal } from "../helpers/state.js";

export type StateTransitionEdge = { source: string; target: string; labels: string[]; kind?: "transition" | "send" | "sendBatch" | "call" | "callBatch" | "reply" };

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
		const link = state.actorMessageLink;
		if (link !== undefined && visibleIds.has(link.to) && link.to !== state.id) {
			const key = `${state.id}\u0000${link.to}\u0000${link.kind}`;
			grouped.set(key, { source: state.id, target: link.to, labels: [link.event ?? link.kind], kind: link.kind });
		}
		const occurrence = state.actorOccurrence;
		const caller = occurrence?.pendingCaller;
		if (caller !== undefined && visibleIds.has(caller.state) && caller.state !== state.id) {
			const key = `${state.id}\u0000${caller.state}\u0000reply`;
			grouped.set(key, { source: state.id, target: caller.state, labels: [state.actorOccurrence?.currentMessage?.replyEvent ?? "reply"], kind: "reply" });
		}
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
