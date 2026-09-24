import type { HyperchartRunInfo, HyperchartStateInfo, HyperchartStateType } from "../../types.js";
import {
	actorMapLocalRun,
	actorNamedReplyRun,
	actorPendingCallRun,
	actorPoolCrowdedRun,
	actorSelfSendRun,
	actorSendVoidRun,
	allActorPoolRuns,
	allActorRuns,
} from "../../fixtures/actor-fixtures.js";
import { allRunStripRuns } from "../../fixtures/hyperchart-fixtures.js";
import { inspectorPanelSpecs } from "../inspector-panel/specs.js";
import { inspectorPanelScenario } from "../inspector-panel/runtime.js";
import { storyScenario } from "../../fixtures/story-scenario.js";

export type AtlasCase = {
	title: string;
	run: HyperchartRunInfo;
	stateId: string;
	status: HyperchartStateInfo["status"];
};

/** Every candidate is already normalized, replay-checked and host-projected. Never construct a state model here. */
const runtimeRuns = [
	...allActorRuns.filter((run) => run.runId !== "actor:broken-replay"),
	...allActorPoolRuns,
	actorPoolCrowdedRun,
	actorSelfSendRun,
	actorSendVoidRun,
	actorNamedReplyRun,
	actorPendingCallRun,
	actorMapLocalRun,
	...allRunStripRuns,
];

function fromRun(run: HyperchartRunInfo, state: HyperchartStateInfo, title: string): AtlasCase {
	return { title, run, stateId: state.id, status: state.status };
}

export function atlasCases(kind: HyperchartStateType): AtlasCase[] {
	const cases: AtlasCase[] = [];
	for (const spec of inspectorPanelSpecs) {
		if (spec.runtime.selectedStateId === null) {
			continue;
		}
		const scenario = inspectorPanelScenario(spec);
		if (scenario === undefined || scenario.selectedStateId === null) {
			throw new Error(`Card Atlas scenario unavailable: ${spec.title}`);
		}
		const state = scenario.run.states.find((candidate) => candidate.id === scenario.selectedStateId);
		if (state?.type === kind) {
			cases.push(fromRun(scenario.run, state, spec.title));
		}
	}
	// Fill missing statuses from captured actor/dialog runs. One canonical card per
	// previously uncovered status; type-specific variants below remain separate.
	const statuses = new Set(cases.map((entry) => entry.status));
	for (const run of runtimeRuns) {
		for (const state of run.states) {
			if (state.type !== kind || statuses.has(state.status)) {
				continue;
			}
			cases.push(fromRun(run, state, `${kind} · ${state.status}`));
			statuses.add(state.status);
		}
	}
	if (kind === "region" || kind === "compound" || kind === "gate") {
		const title =
			kind === "region" ? "Parallel branch scope" : kind === "compound" ? "Compound scope" : "Pending host gate";
		const spec = inspectorPanelSpecs.find((candidate) => candidate.title === title);
		if (spec === undefined || spec.runtime.selectedStateId === null) {
			throw new Error(`Missing ${kind} fixture`);
		}
		const run = storyScenario(spec.chart).staticRun();
		const state = run.states.find((candidate) => candidate.id === spec.runtime.selectedStateId);
		if (state?.type !== kind || state.status !== "pending") {
			throw new Error(`Expected pending ${kind} fixture`);
		}
		cases.unshift(fromRun(run, state, `${kind} · definition only`));
	}
	if (kind === "region") {
		const spec = inspectorPanelSpecs.find((candidate) => candidate.title === "Completed parallel");
		if (spec === undefined) {
			throw new Error("Missing completed parallel fixture");
		}
		const run = inspectorPanelScenario(spec)?.run;
		const state = run?.states.find((candidate) => candidate.type === "region" && candidate.status === "done");
		if (run === undefined || state === undefined) {
			throw new Error("Expected completed parallel region fixture");
		}
		cases.push(fromRun(run, state, "Parallel branch · completed"));
	}
	if (kind === "actor-occurrence") {
		for (const [title, run, id] of [
			["Pool · busy workers", actorPoolCrowdedRun, "@workers"],
			["Pool · idle", allActorPoolRuns[0]!, "@workers"],
			["Pool · completed", allActorPoolRuns[3]!, "@workers"],
		] as const) {
			const state = run.states.find((candidate) => candidate.id === id);
			if (state?.type === kind && !cases.some((entry) => entry.run === run && entry.stateId === id)) {
				cases.push(fromRun(run, state, title));
			}
		}
	}
	if (kind === "sendBatch") {
		const state = actorSelfSendRun.states.find((candidate) => candidate.id === "@workers.$worker.fanout");
		if (state?.type === kind && !cases.some((entry) => entry.run === actorSelfSendRun && entry.stateId === state.id)) {
			cases.push(fromRun(actorSelfSendRun, state, "Self-send · pool endpoint"));
		}
	}
	if (kind === "reply") {
		const state = actorNamedReplyRun.states.find(
			(candidate) => candidate.type === "reply" && candidate.status === "done",
		);
		if (state !== undefined && !cases.some((entry) => entry.run === actorNamedReplyRun && entry.stateId === state.id)) {
			cases.push(fromRun(actorNamedReplyRun, state, "Named reply · completed"));
		}
	}
	if (cases.length === 0) {
		throw new Error(`No adapter-derived Card Atlas case for ${kind}`);
	}
	return cases;
}
