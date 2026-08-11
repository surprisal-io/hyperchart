import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { actor, chart, final, message, protocol, receive, reply, send } from "../packages/hyperchart/src/core/dsl.js";
import type { DurableLogRecord } from "../packages/hyperchart/src/core/durable_events.js";
import { HyperchartInspectorSidePanel } from "../packages/hyperchart/src/react/components/inspector/HyperchartInspectorSidePanel.js";
import { ActorMailboxCard } from "../packages/hyperchart/src/react/components/inspector/details/ActorMailboxCard.js";
import { ActorInternalMessageHistory } from "../packages/hyperchart/src/react/components/inspector/details/RuntimeSection.js";
import { StateDetails } from "../packages/hyperchart/src/react/components/inspector/details/StateDetails.js";
import { buildGraph } from "../packages/hyperchart/src/react/components/inspector/graph/graphModel.js";
import { visibleStateIdsForScope } from "../packages/hyperchart/src/react/components/inspector/helpers/scope.js";
import { stateKindMeta } from "../packages/hyperchart/src/react/components/inspector/helpers/state.js";
import { actorDrainingRun, actorReentryRun } from "../packages/hyperchart/src/react/fixtures/actor-fixtures.js";
import {
	actorRuntimeAdapterRun,
	actorStaticAdapterRun,
	mailboxReentryRun,
} from "../packages/hyperchart/src/react/fixtures/actor-runtime-fixtures.js";
import { storyScenario } from "../packages/hyperchart/src/react/fixtures/story-scenario.js";
import { inspectorPanelTileProps } from "../packages/hyperchart/src/react/stories/inspector-panel/runtime.js";
import { inspectorPanelSpecs } from "../packages/hyperchart/src/react/stories/inspector-panel/specs.js";

describe("React actor inspector structure", () => {
	it("builds every actor inspector board case from normalized runtime data", () => {
		const actorSpecs = inspectorPanelSpecs.filter((spec) => spec.group === "actors");
		expect(actorSpecs.map((spec) => spec.title)).toEqual([
			"Actor definition-only",
			"Actor runtime and mailbox",
			"Mailbox across re-entry",
			"Actor pool definition-only",
			"Actor pool workers and backlog",
			"Send state",
			"Send batch state",
			"Call state",
			"Call batch state",
			"Receive state",
			"Receive state across re-entry",
			"Reply state",
			"Reply state across re-entry",
		]);
		for (const spec of actorSpecs) {
			const tile = inspectorPanelTileProps(spec);
			expect(tile.variant).toBe("panel");
			if (tile.variant !== "panel" || tile.selectedStateId === null) continue;
			expect(tile.run.states.some((state) => state.id === tile.selectedStateId)).toBe(true);
			expect(tile.runtimeSources.map((source) => source.title)).toEqual(expect.arrayContaining([
				"Definition",
				"log records",
				"status.json",
			]));
		}
		const batchStates = [];
		for (const [title, kind] of [["Send batch state", "sendBatch"], ["Call batch state", "callBatch"]] as const) {
			const tile = inspectorPanelTileProps(actorSpecs.find((spec) => spec.title === title)!);
			if (tile.variant !== "panel" || tile.selectedStateId === null) throw new Error(`missing ${title} fixture`);
			const state = tile.run.states.find((candidate) => candidate.id === tile.selectedStateId);
			expect(state?.type).toBe(kind);
			if (state !== undefined) batchStates.push(state);
			const markup = state === undefined ? "" : renderToStaticMarkup(createElement(StateDetails, { state, allStates: tile.run.states, onNavigateToState: () => undefined }));
			expect(markup).toContain(kind);
			expect(markup).toContain("Outgoing message definition");
			expect(markup).toContain("inputs expression");
			expect(markup).toContain("message contract");
		}
		expect(batchStates).toHaveLength(2);
		expect(stateKindMeta(batchStates[0]!).Icon).not.toBe(stateKindMeta(batchStates[1]!).Icon);

		const poolTile = inspectorPanelTileProps(actorSpecs.find((spec) => spec.title === "Actor pool workers and backlog")!);
		expect(poolTile.variant).toBe("panel");
		if (poolTile.variant !== "panel" || poolTile.selectedStateId === null) throw new Error("missing actor pool panel fixture");
		const poolState = poolTile.run.states.find((state) => state.id === poolTile.selectedStateId);
		expect(poolState?.actorOccurrence).toMatchObject({ kind: "actorPool", activeCount: 2, concurrency: 2, mailbox: { totalCount: 4 } });
		const poolMarkup = poolState === undefined ? "" : renderToStaticMarkup(createElement(StateDetails, { state: poolState, allStates: poolTile.run.states, onNavigateToState: () => undefined }));
		expect(poolMarkup).toContain("Workers · 2/2 active");
		expect(poolMarkup).toContain("$worker-0");
		expect(poolMarkup).toContain("$worker-1");
		const poolOccurrence = poolState?.actorOccurrence;
		expect(poolOccurrence?.workers?.[0]).toMatchObject({ currentMessage: { messageId: "batch:message:1:4" }, messageHistory: [{ messageId: "batch:message:1:0" }, { messageId: "batch:message:1:2" }] });
		expect(poolOccurrence?.workers?.[1]).toMatchObject({ currentMessage: { messageId: "batch:message:1:5" }, messageHistory: [{ messageId: "batch:message:1:1" }, { messageId: "batch:message:1:3" }] });
		expect(poolTile.run.states.find((state) => state.id === "batch")?.type).toBe("callBatch");
		const poolGraph = buildGraph(poolTile.run, new Set(["batch", "@workers"]));
		expect(poolGraph.edges).toEqual(expect.arrayContaining([
			expect.objectContaining({ source: "batch", target: "@workers", label: "callBatch · WORK" }),
		]));
	});

	it("keeps re-entered actor mailboxes separated by durable generation", () => {
		const occurrence = mailboxReentryRun.actorOccurrences?.[0];
		expect(occurrence?.mailboxInstances).toHaveLength(2);
		expect(occurrence?.mailboxInstances[0]).toMatchObject({ generation: 1, status: "stopped", mailbox: { totalCount: 0 } });
		expect(occurrence?.mailboxInstances[0]?.messageHistory).toHaveLength(2);
		expect(occurrence?.mailboxInstances[1]).toMatchObject({ generation: 2, status: "busy", mailbox: { totalCount: 1 }, currentMessage: { event: "PING", status: "accepted" } });
		const receive = mailboxReentryRun.states.find((state) => state.id === "phase.@worker.idle");
		const replyState = mailboxReentryRun.states.find((state) => state.id === "phase.@worker.settle");
		expect(receive?.actorMessageHistory).toHaveLength(1);
		expect(receive?.actorInternal?.generations?.map((generation) => generation.actorMessageHistory?.length ?? 0)).toEqual([2, 1]);
		expect(replyState?.actorMessageHistory).toHaveLength(0);
		expect(replyState?.actorInternal?.generations?.map((generation) => generation.actorMessageHistory?.length ?? 0)).toEqual([2, 0]);
		const receiveMarkup = receive === undefined ? "" : renderToStaticMarkup(createElement(StateDetails, { state: receive, allStates: mailboxReentryRun.states, onNavigateToState: () => undefined }));
		expect(receiveMarkup).toContain("Latest instance");
		expect(receiveMarkup).toContain("phase.@worker · generation 2");
		expect(receiveMarkup).toContain("Show history");
		expect(receiveMarkup).not.toContain("generation 1");
		const markup = renderToStaticMarkup(createElement(ActorMailboxCard, { instances: occurrence?.mailboxInstances ?? [] }));
		expect(markup).toContain("Latest instance · generation 2");
		expect(markup).toContain("Show history");
		expect(markup).not.toContain("Processed messages");
	});

	it("separates actor-internal send runtime by parent actor generation", () => {
		const sent = (producerVisit: number, targetGeneration: number) => ({
			messageId: `forward:${producerVisit}:0`,
			producerVisit,
			batchIndex: 0,
			input: { value: producerVisit },
			status: "queued" as const,
			targetOccurrencePath: targetGeneration === 1 ? "@sink" : `@sink~${targetGeneration}`,
			targetLogicalPath: "@sink",
			targetGeneration,
		});
		const state = {
			id: "@worker.forward",
			type: "send" as const,
			status: "done" as const,
			actorMessageLink: { kind: "send" as const, to: "@sink", event: "FORWARD", messages: [sent(2, 2)] },
			actorInternal: {
				declarationPath: "@worker",
				localState: "forward",
				occurrencePath: "@worker~2",
				logicalOccurrencePath: "@worker",
				generation: 2,
				generations: [
					{ occurrencePath: "@worker", logicalPath: "@worker", generation: 1, actorStatus: "stopped" as const, stateStatus: "done" as const, actorMessages: [sent(1, 1)] },
					{ occurrencePath: "@worker~2", logicalPath: "@worker", generation: 2, actorStatus: "busy" as const, stateStatus: "done" as const, actorMessages: [sent(2, 2)] },
				],
			},
		};
		const markup = renderToStaticMarkup(createElement(StateDetails, { state, allStates: [state], onNavigateToState: () => undefined }));
		expect(markup).toContain("@worker · generation 2");
		expect(markup).toContain("target");
		expect(markup).toContain("@sink");
		expect(markup).toContain("generation 2");
		expect(markup).toContain("Show history");
		expect(markup).not.toContain("forward:1:0");
	});

	it("adapts static definitions and runtime occurrences into one navigable actor hierarchy", () => {
		expect(actorStaticAdapterRun.states).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "@editor", type: "actor-declaration", definitionSource: expect.stringContaining("editor: actor(") }),
			expect.objectContaining({ id: "@editor.idle", scopeParentId: "@editor", type: "receive" }),
			expect.objectContaining({ id: "@editor.apply", scopeParentId: "@editor", type: "agent" }),
			expect.objectContaining({ id: "@editor.settle", scopeParentId: "@editor", type: "reply" }),
		]));
		expect(actorRuntimeAdapterRun.states).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: "queue",
				type: "sendBatch",
				status: "done",
				actorMessageLink: expect.objectContaining({
					event: "APPLY",
					to: "@editor",
					messages: expect.arrayContaining([expect.objectContaining({ input: { patch: "patch-0" } })]),
				}),
			}),
			expect.objectContaining({ id: "apply-call", type: "call", status: "running" }),
			expect.objectContaining({
				id: "@editor",
				type: "actor-occurrence",
				definitionSource: expect.stringContaining("editor: actor("),
				actorDeclaration: expect.objectContaining({ declarationPath: "@editor" }),
				actorOccurrence: expect.objectContaining({ occurrencePath: "@editor" }),
			}),
			expect.objectContaining({ id: "@editor.idle", scopeParentId: "@editor", type: "receive", status: "done", completedEvent: "APPLY" }),
			expect.objectContaining({ id: "@editor.apply", scopeParentId: "@editor", type: "agent", status: "running" }),
			expect.objectContaining({ id: "@editor.settle", scopeParentId: "@editor", type: "reply" }),
		]));
		const sendBatchState = actorRuntimeAdapterRun.states.find((state) => state.id === "queue");
		expect(sendBatchState).not.toHaveProperty("taskPrompt");
		expect(sendBatchState?.actorMessageDefinition).toMatchObject({
			kind: "sendBatch",
			to: "@editor",
			event: "APPLY",
			payload: { label: "inputs", source: expect.stringContaining('patch: "patch-0"') },
			contracts: [expect.objectContaining({ event: "APPLY", input: { schema: expect.any(Object) } })],
		});
		const applyCall = actorRuntimeAdapterRun.states.find((state) => state.id === "apply-call");
		expect(applyCall).not.toHaveProperty("taskPrompt");
		expect(applyCall?.actorMessageDefinition).toMatchObject({
			kind: "call",
			to: "@editor",
			event: "APPLY",
			payload: { label: "input", source: expect.stringContaining('patch: "follow-up patch"') },
		});
		expect(actorRuntimeAdapterRun.states.find((state) => state.id === "@editor.idle")?.actorMessageDefinition).toMatchObject({
			kind: "receive",
			contracts: expect.arrayContaining([expect.objectContaining({ event: "APPLY" }), expect.objectContaining({ event: "REVIEW" })]),
		});
		expect(actorRuntimeAdapterRun.states.find((state) => state.id === "@editor.settle")?.actorMessageDefinition).toMatchObject({
			kind: "reply",
			event: "APPLIED",
			payload: { label: "output", source: expect.stringContaining('commit: "storybook-commit"'), schema: { schema: expect.any(Object) } },
		});
		expect(applyCall?.actorMessageLink).toMatchObject({
			event: "APPLY",
			messages: [expect.objectContaining({
				input: { patch: "follow-up patch" },
				messageId: "apply-call:1:0",
				targetOccurrencePath: "@editor",
				targetLogicalPath: "@editor",
				targetGeneration: 1,
			})],
		});
		expect(actorStaticAdapterRun.actorDeclarations?.[0]?.inputValue).toEqual({ file: "src/index.ts" });
		expect(actorRuntimeAdapterRun.actorOccurrences?.[0]).toMatchObject({
			input: { file: "src/index.ts" },
			pendingCaller: { state: "apply-call", callId: "apply-call:1" },
		});

		const rootScope = visibleStateIdsForScope(actorRuntimeAdapterRun.states);
		expect([...rootScope].filter((id) => id === "@editor")).toEqual(["@editor"]);
		expect(actorRuntimeAdapterRun.states.some((state) => state.id.includes("::actor"))).toBe(false);
		const actorScope = visibleStateIdsForScope(actorRuntimeAdapterRun.states, { scopeId: "@editor" });
		expect([...actorScope].sort()).toEqual([
			"@editor.apply",
			"@editor.approve",
			"@editor.archive",
			"@editor.idle",
			"@editor.review",
			"@editor.settle",
		]);
	});

	it("isolates durable histories for multiple receive and reply states", () => {
		const TestProtocol = protocol({
			A: message({ input: z.object({ value: z.string() }), replies: { A_OK: z.object({ result: z.string() }) } }),
			B: message({ input: z.object({ value: z.string() }), replies: { B_OK: z.object({ result: z.string() }) } }),
		});
		const Worker = actor({
			input: z.object({ name: z.string() }), protocol: TestProtocol, initial: "receiveA",
			states: {
				receiveA: receive({ on: { A: "replyA" } }),
				replyA: reply({ target: "receiveB", event: "A_OK", output: { result: "a" } }),
				receiveB: receive({ on: { B: "replyB" } }),
				replyB: reply({ target: "receiveA", event: "B_OK", output: { result: "b" } }),
			},
		});
		const worker = Worker({ name: "worker" });
		const scenario = storyScenario(chart({
			kind: "chart", id: "actor-history-isolation", actors: { worker }, initial: "sendA",
			states: {
				sendA: send({ to: worker, event: "A", input: { value: "input-a" }, target: "sendB" }),
				sendB: send({ to: worker, event: "B", input: { value: "input-b" }, target: "done" }),
				done: final(),
			},
		}), "test:actor-history-isolation");
		const ast = scenario.ast;
		const declaration = ast.actors["@worker"]!;
		const sendA = ast.states.sendA!;
		const sendB = ast.states.sendB!;
		const replyAContract = declaration.protocol.A!.reply;
		const replyBContract = declaration.protocol.B!.reply;
		if (sendA.kind !== "send" || sendB.kind !== "send" || replyAContract.kind !== "named" || replyBContract.kind !== "named") throw new Error("expected send states and named replies");
		const source = (definition: typeof sendA, event: "A" | "B") => ({ producerState: definition.id, kind: "send" as const, definition, targetDeclaration: "@worker", event, inputSchema: declaration.protocol[event]!.input });
		const envelope = (producerState: string, event: "A" | "B", value: string) => ({ messageId: `${event}:1:0`, event, input: { value }, producerState, producerVisit: 1, batchIndex: 0 });
		const stamp = (seqId: number) => ({ parentId: seqId === 1 ? null : seqId - 1, seqId, timestamp: 1_700_100_000_000 + seqId });
		const records: DurableLogRecord[] = [
			{ type: "args", args: {}, ...stamp(1) },
			{ type: "actor_created", declaration: "@worker", occurrence: "@worker", generation: 1, input: { name: "worker" }, definition: declaration, ...stamp(2) },
			{ type: "actor_messages_enqueued", occurrence: "@worker", generation: 1, source: source(sendA, "A"), messages: [envelope("sendA", "A", "input-a")], ...stamp(3) },
			{ type: "actor_messages_enqueued", occurrence: "@worker", generation: 1, source: source(sendB, "B"), messages: [envelope("sendB", "B", "input-b")], ...stamp(4) },
			{ type: "actor_message", kind: "accepted", occurrence: "@worker", messageId: "A:1:0", receiveState: "@worker.receiveA", ...stamp(5) },
			{ type: "actor_message", kind: "replied", occurrence: "@worker", messageId: "A:1:0", message: "A", replyEvent: "A_OK", output: { result: "a" }, schema: replyAContract.schemas.A_OK!, ...stamp(6) },
			{ type: "actor_message", kind: "settled", occurrence: "@worker", messageId: "A:1:0", ...stamp(7) },
			{ type: "actor_message", kind: "accepted", occurrence: "@worker", messageId: "B:1:0", receiveState: "@worker.receiveB", ...stamp(8) },
			{ type: "actor_message", kind: "replied", occurrence: "@worker", messageId: "B:1:0", message: "B", replyEvent: "B_OK", output: { result: "b" }, schema: replyBContract.schemas.B_OK!, ...stamp(9) },
		];
		const run = scenario.runtimeRun(records);
		const state = (id: string) => run.states.find((candidate) => candidate.id === id)!;
		expect(state("@worker.receiveA").actorMessageHistory).toEqual([expect.objectContaining({ messageId: "A:1:0", event: "A", input: { value: "input-a" }, producerVisit: "sendA:1", status: "settled" })]);
		expect(state("@worker.receiveB").actorMessageHistory).toEqual([expect.objectContaining({ messageId: "B:1:0", event: "B", input: { value: "input-b" }, producerVisit: "sendB:1", status: "replied" })]);
		expect(state("@worker.replyA").actorMessageHistory).toEqual([expect.objectContaining({ messageId: "A:1:0", event: "A", replyEvent: "A_OK", replyOutput: { result: "a" }, validation: "valid", replyState: "@worker.replyA" })]);
		expect(state("@worker.replyB").actorMessageHistory).toEqual([expect.objectContaining({ messageId: "B:1:0", event: "B", replyEvent: "B_OK", replyOutput: { result: "b" }, validation: "valid", replyState: "@worker.replyB" })]);
		for (const id of ["@worker.receiveA", "@worker.receiveB", "@worker.replyA", "@worker.replyB"]) {
			const markup = renderToStaticMarkup(createElement(StateDetails, { state: state(id), allStates: run.states }));
			expect(markup).not.toContain("Actor definition / input");
			expect(markup).not.toContain("Protocol ·");
		}
		expect(renderToStaticMarkup(createElement(StateDetails, { state: state("@worker.receiveA"), allStates: run.states }))).not.toContain("input-b");
		expect(renderToStaticMarkup(createElement(StateDetails, { state: state("@worker.replyA"), allStates: run.states }))).not.toContain("B_OK");
		const receiveHistoryMarkup = renderToStaticMarkup(createElement(ActorInternalMessageHistory, {
			state: state("@worker.receiveA"),
			messages: state("@worker.receiveA").actorMessageHistory ?? [],
		}));
		expect(receiveHistoryMarkup).toContain("1 accepted message");
		expect(receiveHistoryMarkup).toContain('aria-expanded="false"');
		expect(receiveHistoryMarkup).not.toContain("A:1:0");
		expect(receiveHistoryMarkup).not.toContain("input-a");
		const replyHistoryMarkup = renderToStaticMarkup(createElement(ActorInternalMessageHistory, {
			state: state("@worker.replyA"),
			messages: state("@worker.replyA").actorMessageHistory ?? [],
		}));
		expect(replyHistoryMarkup).toContain("A → A_OK");
		expect(replyHistoryMarkup).not.toContain('result');
	});

	it("builds actor messaging without declaration-to-instance presentation edges", () => {
		const staticVisible = new Set(actorStaticAdapterRun.states.map((state) => state.id));
		const staticGraph = buildGraph(actorStaticAdapterRun, staticVisible);

		expect(staticGraph.edges).toEqual(expect.arrayContaining([
			expect.objectContaining({ source: "queue", target: "@editor", label: "sendBatch · APPLY" }),
			expect.objectContaining({ source: "apply-call", target: "@editor", label: "call · APPLY" }),
		]));

		const rootVisible = visibleStateIdsForScope(actorRuntimeAdapterRun.states);
		const runtimeGraph = buildGraph(actorRuntimeAdapterRun, rootVisible);
		expect(runtimeGraph.nodes.filter((node) => node.id === "@editor")).toHaveLength(1);
		expect(runtimeGraph.edges.some((edge) => edge.label === "instance")).toBe(false);
	});

	it("offers unified actor scope navigation and renders actor-specific internal details", () => {
		const occurrenceMarkup = renderToStaticMarkup(createElement(HyperchartInspectorSidePanel, {
			run: actorRuntimeAdapterRun,
			selectedStateId: "@editor",
			onOpenScope: () => undefined,
		}));
		expect(occurrenceMarkup).toContain("Open scope");
		expect(occurrenceMarkup).not.toContain("Current message · APPLY");
		expect(occurrenceMarkup).toContain("Mailbox · 1 current · 3 queued");
		expect(occurrenceMarkup).not.toContain("FIFO mailbox");
		expect(occurrenceMarkup).not.toContain("Pending caller");
		expect(occurrenceMarkup).toContain("Actor definition / input");
		expect(occurrenceMarkup).toContain("immutable input");
		expect(occurrenceMarkup).not.toContain("actor occurrence");
		expect(occurrenceMarkup).not.toContain("actor declaration");
		expect(occurrenceMarkup).not.toContain("configured value / expression");
		expect(occurrenceMarkup).toContain("Visit history");
		expect(occurrenceMarkup).toContain("resolved inputs");
		expect(occurrenceMarkup).not.toContain("Agents in scope");
		expect(occurrenceMarkup).not.toContain("Contracts in scope");
		const actorIndex = occurrenceMarkup.indexOf("Actor definition / input");
		const protocolIndex = occurrenceMarkup.indexOf("Protocol · 3 messages");
		const runtimeIndex = occurrenceMarkup.indexOf(">Runtime<");
		const mailboxIndex = occurrenceMarkup.indexOf("Mailbox · 1 current · 3 queued");
		expect(actorIndex).toBeGreaterThanOrEqual(0);
		expect(actorIndex).toBeLessThan(protocolIndex);
		expect(protocolIndex).toBeLessThan(runtimeIndex);
		expect(runtimeIndex).toBeLessThan(mailboxIndex);
		const completedVisitsMarkup = renderToStaticMarkup(createElement(HyperchartInspectorSidePanel, {
			run: actorReentryRun,
			selectedStateId: "phase.@auditor",
			onOpenScope: () => undefined,
		}));
		expect(completedVisitsMarkup).toContain("Visit 3");
		expect(completedVisitsMarkup).not.toContain("Message history");
		expect(completedVisitsMarkup).toContain("Mailbox · 0 queued");
		expect(completedVisitsMarkup).not.toContain("phase.record:message:1:0");
		const reentryOccurrence = actorReentryRun.actorOccurrences?.[0];
		expect(reentryOccurrence).toBeDefined();
		if (reentryOccurrence !== undefined) {
			const emptyMailboxMarkup = renderToStaticMarkup(createElement(ActorMailboxCard, {
				instances: reentryOccurrence.mailboxInstances,
			}));
			expect(emptyMailboxMarkup).toContain("Mailbox is empty.");
			expect(emptyMailboxMarkup).toContain("Show history");
			expect(emptyMailboxMarkup).not.toContain("phase.record:message:1:0");
		}
		expect(completedVisitsMarkup).toContain("journal");
		expect(completedVisitsMarkup).toContain("retentionDays");
		expect(completedVisitsMarkup).not.toContain("configured value / expression");
		expect(completedVisitsMarkup).not.toContain("<details open=\"\"");
		const actorOccurrence = actorRuntimeAdapterRun.states.find((state) => state.id === "@editor")?.actorOccurrence;
		expect(actorOccurrence).toBeDefined();
		if (actorOccurrence !== undefined) {
			const mailboxMarkup = renderToStaticMarkup(createElement(ActorMailboxCard, {
				instances: actorOccurrence.mailboxInstances,
			}));
			expect(mailboxMarkup).toContain("current");
			expect(mailboxMarkup).not.toContain("queue:1:0");
			expect(mailboxMarkup).toContain(">send<");
			expect(mailboxMarkup).toContain(">call<");
			expect(mailboxMarkup).not.toContain("Message input");
			expect(mailboxMarkup).not.toContain("patch-0");
			expect(mailboxMarkup).toContain("REVIEW");
			expect(mailboxMarkup).toContain("ARCHIVE");
			expect(mailboxMarkup.match(/role="button"/g)).toHaveLength(4);
			expect(mailboxMarkup.match(/aria-expanded="false"/g)).toHaveLength(4);
		}

		const drainingRoot = visibleStateIdsForScope(actorDrainingRun.states);
		expect(drainingRoot.has("phase")).toBe(true);
		expect(drainingRoot.has("phase.@worker")).toBe(false);
		const drainingFinal = actorDrainingRun.states.find((state) => state.id === "phase.finished");
		expect(drainingFinal).toBeDefined();
		if (drainingFinal !== undefined) {
			const drainingFinalMarkup = renderToStaticMarkup(createElement(StateDetails, {
				state: drainingFinal,
				allStates: actorDrainingRun.states,
				onNavigateToState: () => undefined,
			}));
			expect(drainingFinalMarkup).toContain("Waiting for actors · 1");
			expect(drainingFinalMarkup).toContain("@worker");
			expect(drainingFinalMarkup).toContain("1 current · 3 queued");
		}

		const declaration = actorRuntimeAdapterRun.states.find((state) => state.id === "@editor");
		expect(declaration).toBeDefined();
		if (declaration === undefined) return;
		const declarationMarkup = renderToStaticMarkup(createElement(StateDetails, {
			state: declaration,
			allStates: actorRuntimeAdapterRun.states,
		}));
		expect(declarationMarkup).not.toContain("Contracts in scope");
		expect(declarationMarkup).toContain("Protocol · 3 messages");
		expect(declarationMarkup).toContain("APPLIED");
		expect(declarationMarkup).toContain("REJECTED");
		expect(declarationMarkup).toContain("REVIEW");
		expect(declarationMarkup).toContain("APPROVED");
		expect(declarationMarkup).toContain("CHANGES_REQUESTED");
		expect(declarationMarkup).toContain("ARCHIVE");
		expect(declarationMarkup).toContain("APPLYInput");
		expect(declarationMarkup).toContain("Message input");
		expect(declarationMarkup).toContain("Reply events");
		expect(declarationMarkup).toContain("src/index.ts");

		const internal = actorRuntimeAdapterRun.states.find((state) => state.id === "@editor.apply");
		expect(internal).toBeDefined();
		if (internal === undefined) return;
		const internalMarkup = renderToStaticMarkup(createElement(StateDetails, {
			state: internal,
			allStates: actorRuntimeAdapterRun.states,
		}));
		expect(internalMarkup).not.toContain("Actor definition / input");
		expect(internalMarkup).toContain("@editor");
		expect(internalMarkup).toContain("actor-editor");
	});
});
