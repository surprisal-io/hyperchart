import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { StateDetails } from "../packages/hyperchart/src/react/components/inspector/details/StateDetails.js";
import { buildGraph } from "../packages/hyperchart/src/react/components/inspector/graph/graphModel.js";
import { inspectorPanelSpecs } from "../packages/hyperchart/src/react/stories/inspector-panel/specs.js";
import { inspectorPanelScenario } from "../packages/hyperchart/src/react/stories/inspector-panel/runtime.js";
import { captureCompletionStory, completionScenario } from "../packages/hyperchart/src/react/fixtures/completion-fixture.js";
import { captureCallBatchResultStory, captureSingletonCallStory } from "../packages/hyperchart/src/react/fixtures/call-batch-result-fixture.js";
import { captureAtlasStatus } from "../packages/hyperchart/src/react/fixtures/atlas-status-fixtures.js";

describe("completion Storybook pipeline", () => {
	it("captures running, completed and failed function/compound cards through the real loop", async () => {
		for (const [snapshot, stateId, status] of [
			["compound-running", "scope", "running"],
			["compound-done", "scope", "done"],
			["function-running", "execute", "running"],
			["function-failed", "execute", "failed"],
		] as const) {
			const run = await captureAtlasStatus(snapshot);
			expect(run.states.find((state) => state.id === stateId)?.status).toBe(status);
			expect(buildGraph(run, new Set([stateId])).nodes[0]?.data.state.status).toBe(status);
		}
	});
	it("puts notify and waitFor definitions and executed statuses on a dedicated Actor State Details board", () => {
		const story = (name: string) => readFileSync(new URL(`../packages/hyperchart/src/react/stories/${name}`, import.meta.url), "utf8");
		expect(story("StateDetailsActors.stories.tsx")).toContain("export const NotifyAndWaitFor");
		expect(story("StateDetailsActors.stories.tsx")).toContain('groupId="actorCompletion"');
		expect(story("StateDetailsActors.stories.tsx")).toContain("<ActorCompletionCases />");
		const cases = story("components/ActorCompletionBoards.tsx");
		for (const snapshot of ["notify-in-flight", "notification-retained", "notify-failed", "waiting", "consumed"]) {
			expect(cases).toContain(`"${snapshot}"`);
		}
		for (const title of ["Wait For · definition", "Notify · definition"]) {
			expect(inspectorPanelSpecs.find((spec) => spec.title === title)?.group).toBe("actorCompletion");
		}
		expect(story("InspectorGraphActors.stories.tsx")).toContain("<CompletionRuntimePair />");
		expect(story("card-atlas/runtime-cards.tsx")).toContain('case "notify"');
		expect(story("card-atlas/runtime-cards.tsx")).toContain('case "waitFor"');
		expect(story("card-atlas/TypeBoard.tsx")).toContain("--notify-and-wait-for");
		expect(story("InspectorDialogActors.stories.tsx")).toContain("export const ChartOwnedCompletion");
	});
	it("renders a fully settled input-ordered callBatch result in its downstream reader", async () => {
		const run = await captureCallBatchResultStory();
		expect(run.states.find((state) => state.id === "batch")?.type).toBe("callBatch");
		expect(run.states.find((state) => state.id === "batch")?.status).toBe("done");
		expect(run.states.find((state) => state.id === "use")?.status).toBe("done");
		expect(run.states.find((state) => state.id === "use")?.visitHistory?.[0]?.invocation).toMatchObject({
			kind: "agent", task: 'Ordered replies: [{"id":1},{"id":0}]',
		});
	});
	it("marks a resolved singleton call done from its durable actor_call_resolved fact", async () => {
		const run = await captureSingletonCallStory();
		expect(run.states.find((state) => state.id === "request")).toMatchObject({
			type: "call", status: "done", completedEvent: "ACTOR_REPLY",
		});
	});
	it("executes, replay-validates and projects both completion node kinds and retained/consumed visits", async () => {
		const retained = await captureCompletionStory("notification-retained");
		const waiting = await captureCompletionStory("waiting");
		const consumed = await captureCompletionStory("consumed");
		const validating = await captureCompletionStory("notify-in-flight");
		const failed = await captureCompletionStory("notify-failed");
		for (const run of [retained, waiting, consumed]) {
			expect(run.states.find((state) => state.id === "wait")?.type).toBe("waitFor");
			expect(run.states.find((state) => state.id === "@worker.publish")?.type).toBe("notify");
		}
		expect(validating.states.find((state) => state.id === "@worker.publish")?.status).toBe("running");
		expect(failed.states.find((state) => state.id === "@worker.publish")?.status).toBe("failed");
		expect(retained.states.find((state) => state.id === "@worker.publish")?.status).toBe("done");
		expect(retained.states.find((state) => state.id === "@worker.publish")?.completionPublication).toMatchObject({
			endpoint: "done", event: "DONE", payload: { value: "from worker" }, seqId: expect.any(Number),
		});
		expect(failed.states.find((state) => state.id === "@worker.publish")?.completionPublication).toBeUndefined();
		expect(retained.states.find((state) => state.id === "wait")?.status).toBe("pending");
		for (const stateId of ["@worker.publish", "wait"]) {
			expect(completionScenario.staticRun().states.find((state) => state.id === stateId)?.completion?.schema).toMatchObject({
				type: "object", properties: { value: { type: "string" } }, required: ["value"],
			});
		}
		expect(waiting.states.find((state) => state.id === "wait")?.status).toBe("running");
		expect(consumed.states.find((state) => state.id === "wait")?.status).toBe("done");
		for (const [title, stateId, kind] of [
			["Wait For · definition", "wait", "waitFor"],
			["Notify · definition", "@worker.publish", "notify"],
		] as const) {
			const spec = inspectorPanelSpecs.find((candidate) => candidate.title === title);
			expect(spec).toBeDefined();
			const atlas = inspectorPanelScenario(spec!);
			expect(atlas?.run.states.find((state) => state.id === stateId)?.type).toBe(kind);
		}
		for (const [run, stateId, status] of [
			[retained, "@worker.publish", "done"],
			[retained, "wait", "pending"],
			[waiting, "wait", "running"],
			[consumed, "wait", "done"],
		] as const) {
			const graph = buildGraph(run, new Set([stateId]));
			expect(graph.nodes).toHaveLength(1);
			expect(graph.nodes[0]?.data.state.status).toBe(status);
		}
		const edgeGraph = buildGraph(completionScenario.staticRun(), new Set(["wait", "@worker.publish"]));
		expect(edgeGraph.edges).toEqual(expect.arrayContaining([
			expect.objectContaining({ source: "@worker.publish", target: "wait", label: "completion · DONE" }),
		]));
		for (const stateId of ["wait", "@worker.publish"] as const) {
			const state = consumed.states.find((candidate) => candidate.id === stateId)!;
			const markup = renderToStaticMarkup(createElement(StateDetails, { state, allStates: consumed.states }));
			expect(markup).toContain(state.type!);
			expect(markup).toContain(stateId === "wait" ? "Wait For" : "Notify");
			expect(markup).toContain("event payload shape");
			expect(markup).toContain("DONE");
			if (stateId === "wait") {
				expect(markup).toContain("Received event");
				expect(markup).toContain("from worker");
			} else {
				expect(markup).toContain("Published event");
				expect(markup).toContain("sent payload");
				expect(markup).toContain("from worker");
			}
			expect(state.visitHistory?.length).toBeGreaterThan(0);
			expect(buildGraph(completionScenario.staticRun(), new Set([stateId])).nodes).toHaveLength(1);
		}
	});
});
