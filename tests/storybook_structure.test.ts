import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { explainReplay } from "../packages/hyperchart/src/core/replay_check.js";
import { buildGraph } from "../packages/hyperchart/src/react/components/inspector/graph/graphModel.js";
import { inspectorPanelSpecs } from "../packages/hyperchart/src/react/stories/inspector-panel/specs.js";
import { inspectorPanelScenario } from "../packages/hyperchart/src/react/stories/inspector-panel/runtime.js";
import {
	actorBrokenReplayRun,
	actorBusyFifoRun,
	actorDrainingRun,
	actorFailureRun,
	actorIdleRun,
	actorMapLocalRun,
	actorCallAst,
	actorNamedReplyRecords,
	actorReentryRun,
	actorNamedReplyRun,
	actorPendingCallRun,
	actorSendVoidRun,
	actorOverflowRun,
	actorPoolIdleRun,
	actorPoolBusyRun,
	actorPoolPartialBatchRun,
	actorPoolOutOfOrderRun,
	actorPoolDrainingRun,
	actorPoolMapReentryRun,
	allActorRuns,
	allActorPoolRuns,
} from "../packages/hyperchart/src/react/fixtures/actor-fixtures.js";
import {
	blockedRun,
	blockedRunRecords,
	completedRunRecords,
	failedRun,
	failedRunRecords,
	inspectRun,
	inspectorDialogAst,
	inspectorDialogInspectResult,
	runningRun,
	runningRunRecords,
} from "../packages/hyperchart/src/react/fixtures/hyperchart-fixtures.js";

const storyDirectory = join(process.cwd(), "packages/hyperchart/src/react/stories");
const forbiddenTitleSegments = ["Components", "Features", "Examples", "Visual Tests", "Internal"];

function storyFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return storyFiles(path);
		return entry.name.endsWith(".stories.tsx") ? [path] : [];
	});
}

describe("Storybook information architecture", () => {
	it("organizes every visible story by product surface", () => {
		const files = storyFiles(storyDirectory);
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			expect(file).not.toMatch(/Stress/);
			expect(source, file).not.toMatch(/ManyActorsAndMessages|FullStressBoard/);
			const title = source.match(/title:\s*["`]([^"`]+)["`]/)?.[1];
			expect(title, file).toBeDefined();
			expect(title, file).toMatch(/^Hyperchart\/(Inspector|Launch|TUI)(?:\/|$)/);
			const titleSegments = title?.split("/") ?? [];
			for (const segment of forbiddenTitleSegments) expect(titleSegments, file).not.toContain(segment);
			expect(source, file).not.toMatch(/export const Playground\b|\bname:\s*["`]Playground["`]/i);
		}
	});

	it("keeps graph Card Atlas limited to visually distinct nodes", () => {
		const hiddenTitles = new Set([
			"Long prompt",
			"Inputs, refs, re-entry",
			"Imported validation guard",
			"Map item worker",
			"Map parent overflow",
			"Parallel branch scope",
		]);
		for (const spec of inspectorPanelSpecs) {
			if (hiddenTitles.has(spec.title)) expect(spec.graphAtlas, spec.title).toBe(false);
		}
		expect(inspectorPanelSpecs.find((spec) => spec.title === "Rich agent")?.graphAtlas).not.toBe(false);
		expect(inspectorPanelSpecs.find((spec) => spec.title === "Validation failure")?.graphAtlas).not.toBe(false);
		const visualState = (title: string) => {
			const spec = inspectorPanelSpecs.find((candidate) => candidate.title === title);
			expect(spec?.graphAtlas, title).not.toBe(false);
			const scenario = spec === undefined ? undefined : inspectorPanelScenario(spec);
			return scenario?.selectedStateId === null ? undefined : scenario?.run.states.find((state) => state.id === scenario?.selectedStateId);
		};
		expect(visualState("Send batch state")).toMatchObject({
			type: "sendBatch",
			actorMessageLink: { kind: "sendBatch", to: "@editor", event: "APPLY" },
		});
		expect(visualState("Call batch state")).toMatchObject({
			type: "callBatch",
			actorMessageLink: { kind: "callBatch", to: "@workers", event: "WORK" },
		});
		expect(visualState("Empty pending map")).toMatchObject({
			status: "pending",
			mapConfig: expect.not.objectContaining({ items: expect.anything() }),
		});
		expect(visualState("Map parent")?.status).toBe("running");
		expect(visualState("Completed map")).toMatchObject({ status: "done", subProgress: { done: 3, total: 3 } });
		expect(visualState("Empty pending parallel")?.status).toBe("pending");
		expect(visualState("Parallel fan-out")?.status).toBe("running");
		expect(visualState("Completed parallel")).toMatchObject({ status: "done", subProgress: { done: 3, total: 3 } });
		expect(visualState("Final notification")?.finalConfig).toMatchObject({
			outcome: "complete",
			notify: {
				prompt: expect.stringContaining('result("prepare", "summary")'),
				scope: "prepare",
				artifacts: [expect.objectContaining({ name: "report", sourceState: "prepare", path: "artifacts/final-report.json" })],
			},
		});
		expect(visualState("Failed final")?.finalConfig).toEqual({ outcome: "failed" });
		expect(inspectorPanelSpecs.some((spec) => spec.title === "Session failure issue")).toBe(false);
		const failedAction = visualState("Failed action issue");
		expect(failedAction?.taskPrompt?.length).toBeGreaterThan(400);
		expect(failedAction?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "action_failed", source: "durable_log" })]));
		const richAgent = visualState("Rich agent");
		expect(richAgent?.reads).toContain('notes/rich-agent-visit-{visit("rich-agent")}.md');
		expect(richAgent?.reads?.some((read) => read.startsWith('joinArtifactOf("source-map.collect"'))).toBe(true);
		expect(richAgent?.readArtifacts).toHaveLength(3);
		expect(richAgent?.readArtifacts?.find((artifact) => artifact.name === "brief")?.readKind).toBe("join");
		expect(richAgent?.artifacts).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: "note", path: 'artifacts/implementation-note-{visit("rich-agent")}.json', schema: expect.any(Object) }),
			expect.objectContaining({ name: "appendix", path: 'artifacts/implementation-note-{visit("rich-agent")}.md' }),
		]));
		expect(richAgent?.visitHistory).toHaveLength(2);
		expect(richAgent?.visitHistory?.map((visit) => visit.status)).toEqual(["done", "running"]);
		expect(richAgent?.transitions).toEqual(expect.arrayContaining([
			expect.objectContaining({
				event: "REVIEW_REQUIRED",
				target: "review-follow-up",
				input: {
					draft: "event:draft",
					primaryRisk: "event:review.risks.0",
					evidence: "event:review.evidence",
					score: "event:review.score",
				},
			}),
		]));
		const firstVisitReads = richAgent?.visitHistory?.[0]?.invocation.kind === "agent" ? richAgent.visitHistory[0].invocation.reads?.map((read) => read.path) : [];
		expect(richAgent?.visitHistory?.[0]?.invocation.kind === "agent" ? richAgent.visitHistory[0].invocation.reads?.filter((read) => read.readKind === "join") : []).toHaveLength(2);
		expect(firstVisitReads).toEqual(expect.arrayContaining([
			"artifacts/source-api.json",
			"artifacts/source-runtime.json",
			"notes/rich-agent-visit-1.md",
		]));
		expect(richAgent?.visitHistory?.[1]?.invocation.kind === "agent" ? richAgent.visitHistory[1].invocation.reads?.map((read) => read.path) : []).toContain("notes/rich-agent-visit-2.md");
		expect(richAgent?.visitHistory?.[0]?.invocation.kind === "agent" ? richAgent.visitHistory[0].invocation.artifacts?.map((artifact) => artifact.path) : []).toEqual([
			"artifacts/implementation-note-1.json",
			"artifacts/implementation-note-1.md",
		]);
		expect(richAgent?.visitHistory?.[1]?.invocation.kind === "agent" ? richAgent.visitHistory[1].invocation.artifacts?.map((artifact) => artifact.path) : []).toEqual([
			"artifacts/implementation-note-2.json",
			"artifacts/implementation-note-2.md",
		]);
	});

	it("derives dialog stories from one inspected chart and durable runtime facts", () => {
		const definitionStateIds = inspectorDialogInspectResult.states.map((state) => state.id).sort();
		expect(inspectRun.mode).toBe("static");
		expect(inspectRun.states.map((state) => state.id).sort()).toEqual(definitionStateIds);
		expect(inspectRun.states.every((state) => state.status === "pending")).toBe(true);

		expect(runningRun.mode).toBe("run");
		expect(runningRun.states.map((state) => state.id).sort()).toEqual(definitionStateIds);
		expect(runningRun.states.find((state) => state.id === "research-plan")?.status).toBe("done");
		expect(runningRun.states.find((state) => state.id === "visual-review")?.status).toBe("running");
		expect(runningRun.states.find((state) => state.id === "done")?.status).toBe("pending");
		expect(blockedRun).toMatchObject({ status: "blocked" });
		expect(blockedRun.states.find((state) => state.id === "approval")?.status).toBe("waiting");

		for (const records of [runningRunRecords, blockedRunRecords, completedRunRecords, failedRunRecords]) {
			expect(explainReplay(inspectorDialogAst, records)).toMatchObject({
				prefixEnd: records.length,
				stale: [],
				skipped: [],
			});
		}

		for (const record of runningRunRecords) {
			if (record.type === "state_action" && record.kind === "complete") expect(record).not.toHaveProperty("definition");
		}
		expect(failedRunRecords.at(-1)?.type).toBe("failure_intent");
		expect(failedRun.mode).toBe("run");
		expect(failedRun.status).toBe("failed");
		expect(failedRun.states.find((state) => state.id === "visual-review")?.status).toBe("failed");
		expect(failedRun.issues).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "run_failed", source: "durable_log", stateId: "visual-review" }),
		]));
	});

	it("projects focused graph cards without mutating adapter-derived runs", () => {
		const states = [...runningRun.states];
		const selected = runningRun.states.find((state) => state.id === "visual-review");
		const graph = buildGraph(runningRun, new Set(["visual-review"]));
		expect(graph.nodes).toHaveLength(1);
		expect(runningRun.states).toEqual(states);
		expect(runningRun.states.find((state) => state.id === "visual-review")).toBe(selected);
	});

	it("keeps all actor surfaces adapter-derived", () => {
		expect(actorIdleRun.actorOccurrences?.[0]).toMatchObject({ status: "idle", mailbox: { totalCount: 0 } });
		expect(actorBusyFifoRun.actorOccurrences?.[0]).toMatchObject({ status: "busy", mailbox: { totalCount: 3 }, pendingCaller: { state: "apply-call", callId: "apply-call:1" } });
		expect(actorBusyFifoRun.actorOccurrences?.[0]?.mailbox.entries).toHaveLength(3);
		expect(actorBusyFifoRun.actorOccurrences?.[0]?.mailbox.entries).not.toContainEqual(actorBusyFifoRun.actorOccurrences?.[0]?.currentMessage);
		expect(actorMapLocalRun.actorOccurrences).toHaveLength(2);
		expect(actorReentryRun.actorOccurrences).toHaveLength(1);
		expect(actorReentryRun.states.filter((state) => state.id.startsWith("phase")).map((state) => state.status)).toEqual([
			"stale", "stale", "stale", "stale", "stale", "stale",
		]);
		expect(actorReentryRun.states.find((state) => state.id === "between")?.status).toBe("running");
		expect(actorReentryRun.states.find((state) => state.id === "done")?.status).toBe("pending");
		expect(actorReentryRun.actorOccurrences?.[0]).toMatchObject({
			logicalPath: "phase.@auditor",
			occurrencePath: "phase.@auditor~3",
			generation: 3,
			input: { journal: "audit.log", retentionDays: 30 },
			messageHistory: [
				expect.objectContaining({ messageId: "phase.record:message:1:0", status: "settled", receiveState: "phase.@auditor.idle" }),
				expect.objectContaining({ messageId: "phase.record:message:2:0", status: "settled", receiveState: "phase.@auditor.idle" }),
				expect.objectContaining({ messageId: "phase.record:message:3:0", status: "settled", receiveState: "phase.@auditor.idle" }),
			],
			generationHistory: [
				{ visit: 1, inputs: { input: { journal: "audit.log", retentionDays: 30 } } },
				{ visit: 2, inputs: { input: { journal: "audit.log", retentionDays: 30 } } },
				{ visit: 3, inputs: { input: { journal: "audit.log", retentionDays: 30 } } },
			],
		});
		expect(actorReentryRun.actorOccurrences?.[0]?.messageHistory?.every((message) => message.validation === undefined)).toBe(true);
		const reentryReceiveHistory = actorReentryRun.states.find((state) => state.id === "phase.@auditor.idle")?.actorMessageHistory;
		const reentryReplyHistory = actorReentryRun.states.find((state) => state.id === "phase.@auditor.settle")?.actorMessageHistory;
		expect(reentryReceiveHistory).toHaveLength(1);
		expect(reentryReplyHistory).toHaveLength(1);
		expect(reentryReceiveHistory?.every((message) => message.receiveState === "phase.@auditor.idle")).toBe(true);
		expect(reentryReplyHistory?.every((message) => message.replyState === "phase.@auditor.settle")).toBe(true);
		const reentryReceiveGenerations = actorReentryRun.states.find((state) => state.id === "phase.@auditor.idle")?.actorInternal?.generations;
		const reentryReplyGenerations = actorReentryRun.states.find((state) => state.id === "phase.@auditor.settle")?.actorInternal?.generations;
		expect(reentryReceiveGenerations?.map((generation) => generation.actorMessageHistory?.length ?? 0)).toEqual([1, 1, 1]);
		expect(reentryReplyGenerations?.map((generation) => generation.actorMessageHistory?.length ?? 0)).toEqual([1, 1, 1]);
		expect(actorPendingCallRun.actorOccurrences?.[0]?.pendingCaller).toBeDefined();
		expect(actorSendVoidRun.actorOccurrences?.[0]?.status).toBe("stopped");
		expect(actorNamedReplyRun.actorOccurrences?.[0]?.pendingCaller?.waitReason).toBe("reply");
		expect(actorDrainingRun.states.find((state) => state.id === "phase.dispatch")).toMatchObject({ type: "sendBatch", status: "done" });
		expect(actorDrainingRun.states.find((state) => state.id === "phase.finished")).toMatchObject({ type: "final", status: "waiting" });
		expect(actorDrainingRun.status).toBe("running");
		expect(actorDrainingRun.actorOccurrences?.[0]).toMatchObject({
			logicalPath: "phase.@worker",
			ownerPath: "phase",
			status: "draining",
			mailbox: { totalCount: 3, entries: expect.arrayContaining([expect.objectContaining({ status: "queued" })]) },
			currentMessage: expect.objectContaining({ status: "accepted" }),
			drain: { current: 1, queued: 3, settled: 0 },
		});
		expect(actorDrainingRun.states.some((state) => state.type === "call")).toBe(false);
		expect(actorDrainingRun.actorOccurrences?.[0]?.pendingCaller).toBeUndefined();
		expect(actorFailureRun.actorOccurrences?.[0]).toMatchObject({ status: "failed" });
		expect(actorFailureRun.states.find((state) => state.id === "apply")?.status).toBe("failed");
		expect(actorFailureRun.states.find((state) => state.id === "@editor")?.status).toBe("failed");
		expect(actorFailureRun.states.find((state) => state.id === "done")?.status).toBe("pending");
		expect(actorFailureRun.states.some((state) => state.status === "running")).toBe(false);
		expect(actorFailureRun.actorOccurrences?.[0]?.pendingCaller).toBeUndefined();
		expect(actorOverflowRun.actorDeclarations).toHaveLength(1);
		expect(actorOverflowRun.actorOccurrences?.[0]?.mailbox.totalCount).toBe(50);
		const fittingProtocol = actorNamedReplyRun.actorDeclarations?.[0]?.protocol[0];
		const overflowProtocol = actorOverflowRun.actorDeclarations?.[0]?.protocol[0];
		expect(overflowProtocol?.event).not.toBe(fittingProtocol?.event);
		expect(Object.keys(overflowProtocol?.reply.schemas ?? {})).toHaveLength(6);
		expect(actorBrokenReplayRun.issues).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "replay_warning" })]));
		expect(allActorPoolRuns).toEqual([
			actorPoolIdleRun, actorPoolBusyRun, actorPoolPartialBatchRun, actorPoolOutOfOrderRun, actorPoolDrainingRun, actorPoolMapReentryRun,
		]);
		expect(actorPoolIdleRun.actorOccurrences?.[0]).toMatchObject({ kind: "actorPool", concurrency: 2, activeCount: 0, idleCount: 2, workers: [{ index: 0 }, { index: 1 }] });
		expect(actorPoolBusyRun.actorOccurrences?.[0]).toMatchObject({ kind: "actorPool", activeCount: 2, mailbox: { totalCount: 2 }, workers: [{ currentState: "work" }, { currentState: "settle" }] });
		expect(actorPoolPartialBatchRun.actorOccurrences?.[0]).toMatchObject({
			activeCount: 1,
			workers: expect.arrayContaining([expect.objectContaining({ currentStateId: "@workers.$worker.work" })]),
			batchCalls: [expect.objectContaining({ callId: "batch:1", settled: 1, total: 4, items: expect.any(Array) })],
		});
		expect(actorPoolPartialBatchRun.actorOccurrences?.[0]?.workers?.some((worker) => "nextMessageId" in worker)).toBe(false);
		expect(actorPoolOutOfOrderRun.actorOccurrences?.[0]?.workers?.[1]).toMatchObject({ visits: 2, messageHistory: expect.arrayContaining([expect.objectContaining({ messageId: "batch:message:1:2", batchIndex: 2 })]) });
		expect(actorPoolOutOfOrderRun.actorOccurrences?.[0]?.messageHistory?.map((message) => message.batchIndex)).toEqual([0, 1, 2, 3]);
		expect(actorPoolDrainingRun.actorOccurrences?.[0]).toMatchObject({ status: "draining", activeCount: 2, mailbox: { totalCount: 2 } });
		expect(actorPoolMapReentryRun.actorOccurrences?.[0]).toMatchObject({ occurrencePath: "projects#a.@workers~2", generation: 2, generationHistory: [{ visit: 1 }, { visit: 2 }] });
		expect(actorPoolPartialBatchRun.states.some((state) => state.id === "@workers.$worker.work")).toBe(true);
		const replyFact = actorNamedReplyRecords.find((record) => record.type === "actor_message" && record.kind === "replied");
		const editorActor = actorCallAst.actors["@editor"];
		const settle = editorActor?.kind === "actor" ? editorActor.states.settle : undefined;
		expect(settle?.kind).toBe("reply");
		if (replyFact?.type !== "actor_message" || replyFact.kind !== "replied" || settle?.kind !== "reply") throw new Error("expected named reply fixture facts");
		expect(replyFact).toMatchObject({ message: settle.message, replyEvent: settle.event, output: settle.output });
	});

	it("projects distinct fitting and overflow map values", () => {
		const project = (title: string) => {
			const spec = inspectorPanelSpecs.find((candidate) => candidate.group === "map" && candidate.title === title);
			const scenario = spec === undefined ? undefined : inspectorPanelScenario(spec);
			return scenario?.run.states.find((state) => state.id === scenario.selectedStateId);
		};
		const fitting = project("Map parent");
		const overflow = project("Map parent overflow");
		expect(fitting?.mapConfig?.items?.length).toBe(3);
		expect(overflow?.mapConfig?.items?.length).toBe(14);
		expect(overflow?.mapConfig?.items?.[0]?.summary?.length).toBeGreaterThan(200);
	});

	it("ties concrete session metadata to normalized actions and durable invoke time", () => {
		const runtimeSource = readFileSync(join(storyDirectory, "RuntimeSection.stories.tsx"), "utf8");
		expect(runtimeSource).not.toContain("deepseek/deepseek-v4-pro");
		expect(runtimeSource).toContain("model: researchAction.model");
		expect(runtimeSource).toContain("thinking: researchAction.thinking");

		const dialogSource = readFileSync(join(storyDirectory, "AgentSessionDialog.stories.tsx"), "utf8");
		expect(dialogSource).toContain('storyInvoke(sessionScenario.ast, "draft", 2, draftInvokedAt)');
		expect(dialogSource.match(/startedAt: draftInvokedAt/g)).toHaveLength(3);
		expect(dialogSource).toContain("model: draftAction.model");
		expect(dialogSource).toContain("thinking: draftAction.thinking");
	});

	it("does not restore hand-authored semantic Storybook models", () => {
		const semanticFiles = [
			...storyFiles(storyDirectory),
			join(process.cwd(), "packages/hyperchart/src/react/fixtures/actor-fixtures.ts"),
			join(process.cwd(), "packages/hyperchart/src/react/fixtures/actor-runtime-fixtures.ts"),
			join(process.cwd(), "packages/hyperchart/src/react/fixtures/hyperchart-fixtures.ts"),
		];
		for (const file of semanticFiles) {
			const source = readFileSync(file, "utf8");
			expect(source, file).not.toMatch(/:\s*Hyperchart(?:Run|State|ActorDeclaration|ActorOccurrence|ActorMailbox)Info\s*=\s*\{/);
			expect(source, file).not.toMatch(/function\s+(?:run|state|actorState|occurrence)\s*\(/);
			expect(source, file).not.toMatch(/\.\.\.\s*state\s*,\s*session\s*:/);
			expect(source, file).not.toMatch(/const\s+\w*Session\s*=\s*\{/);
			expect(source, file).not.toMatch(/args\s*:\s*\{\s*session\s*:\s*\{/);
		}
		expect(readFileSync(join(process.cwd(), "packages/hyperchart/src/react/stories/InspectorGraph.stories.tsx"), "utf8")).not.toContain("singleStateRun");
	});

	it("keeps actor dialog and graph coverage visual-state driven", () => {
		expect(allActorRuns.map((run) => run.runId)).toEqual([
			"actor:idle",
			"actor:busy-fifo",
			"actor:reentry",
			"actor:draining",
			"actor:failure",
			"actor:broken-replay",
		]);

		const dialogSource = readFileSync(join(storyDirectory, "InspectorDialogActors.stories.tsx"), "utf8");
		const exports = [...dialogSource.matchAll(/export const (\w+): Story/g)].map((match) => match[1]);
		expect(exports).toEqual([
			"RootActorIdle",
			"BusyFifoMailbox",
			"ActorReentry",
			"PoolIdle",
			"PoolBusyBacklog",
			"PoolPartialBatch",
			"PoolMapGenerationReentry",
			"ClosingAndDraining",
			"PoolDraining",
			"Failure",
			"BrokenReplayWarning",
		]);
		expect(dialogSource).not.toMatch(/PendingTypedCall|FireAndForgetVoidSettlement|NamedReplyVariants/);

		const graphSource = readFileSync(join(storyDirectory, "InspectorGraphActors.stories.tsx"), "utf8");
		expect(graphSource.match(/<GraphTile\b/g)).toHaveLength(6);
		expect(graphSource).toContain("structured drain · SEND-only");
		expect(graphSource).toContain("visibleStateIds={drainingRootStateIds}");
		expect(graphSource).not.toMatch(/actorNamedReplyRun|actorSendVoidRun/);

		const atlasSource = readFileSync(join(storyDirectory, "ActorHistoryAtlas.stories.tsx"), "utf8");
		expect(atlasSource).toMatch(/Receive History · selected receive state/);
		expect(atlasSource).toMatch(/Reply History · selected reply state/);
		expect(atlasSource).toMatch(/name: "Show history"/);
		expect(atlasSource).toMatch(/userEvent\.click\(receive\.getAllByRole\("button"\)\[0\]!\)/);
		expect(atlasSource).toMatch(/Pool Worker History · persistent reuse/);
	});

	it("does not restore mechanism-named story files", () => {
		const names = storyFiles(storyDirectory).map((file) => file.slice(storyDirectory.length + 1));
		expect(names.some((name) => /\.(features|visual)\.stories\./.test(name))).toBe(false);
		expect(names).not.toContain("Adapters.stories.tsx");
		expect(names).not.toContain("HyperchartInspectorDialog.stories.tsx");
	});
});
