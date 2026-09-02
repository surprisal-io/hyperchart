import type { DurableLogRecord } from "../core/durable_events.js";
import { actorLogicalOccurrencePath, actorPoolWorkerOccurrencePath } from "../core/actors.js";
import { createBranchProjection, projectBranch, projectedActorEndpoint, type ProjectedActorOccurrence, type ProjectedActorPoolOccurrence } from "../core/projection.js";
import type { ChartAst, StateActionAst, TemplateAst } from "../core/types.js";
import type { HyperchartActorGenerationInfo, HyperchartActorMessageBatchInfo, HyperchartActorMessageInfo, HyperchartAgentSessionInfo, HyperchartMapVisitInfo, HyperchartRecordInfo, HyperchartVisitInfo } from "../host/models.js";
import type { ActorGenerationHistoryItem, ActorMessageHistoryItem, MapVisitHistoryItem, StateVisitHistoryItem } from "../runtime/generic/log_store.js";

export function stateVisitHistoryItemToHost(item: StateVisitHistoryItem, session?: HyperchartAgentSessionInfo): HyperchartVisitInfo {
	const validations = item.records.filter((record): record is Extract<DurableLogRecord, { type: "state_action"; kind: "validated" }> => record.type === "state_action" && record.kind === "validated");
	const completed = [...item.records].reverse().find((record) =>
		record.type === "failure_intent"
		|| record.type === "state_action" && record.kind === "timer_fired"
		|| record.type === "state_action" && record.kind === "validated" && record.outcome === true
		|| record.type === "state_action" && record.kind === "complete" && (validations.length === 0 || record.event.type === "FAILED"),
	);
	const complete = item.records.find((record): record is Extract<DurableLogRecord, { type: "state_action"; kind: "complete" }> => record.type === "state_action" && record.kind === "complete");
	const event = completed?.type === "failure_intent"
		? "FAILED"
		: completed?.type === "state_action" && (completed.kind === "complete" || completed.kind === "validated")
			? completed.event.type
			: undefined;
	return {
		visit: item.visit,
		invokeSeqId: item.seqId,
		startedAt: item.invoke.timestamp,
		...(completed === undefined ? {} : { endedAt: completed.timestamp }),
		status: completed === undefined ? "running" : event === "FAILED" ? "failed" : completed.type === "state_action" && completed.kind === "timer_fired" ? "cancelled" : "done",
		...(event === undefined ? {} : { completedEvent: event }),
		...(validations.length === 0 ? {} : { validationAttempts: validations.length }),
		...(complete?.artifacts === undefined ? {} : { artifactPins: Object.entries(complete.artifacts).map(([path, pin]) => ({ path, hash: pin.hash, size: pin.size })) }),
		invocation: invocationInfo(item.invoke.definition),
		...(session === undefined ? {} : { session }),
	};
}

export function mapVisitHistoryItemToHost(item: MapVisitHistoryItem): HyperchartMapVisitInfo {
	return { visit: item.visit, spawnSeqId: item.seqId, startedAt: item.spawn.timestamp, instances: { ...item.spawn.instances } };
}

export function actorGenerationHistoryItemToHost(item: ActorGenerationHistoryItem): HyperchartActorGenerationInfo {
	return { logicalOccurrence: item.logicalOccurrence, occurrencePath: item.created.occurrence, generation: item.created.generation, createdSeqId: item.seqId, createdAt: item.created.timestamp };
}

export function actorMessageHistoryItemToHost(item: ActorMessageHistoryItem, ast?: ChartAst, ancestry?: readonly DurableLogRecord[]): HyperchartActorMessageBatchInfo {
	const lifecycle = new Map<string, DurableLogRecord[]>();
	for (const record of item.records) if (record.type === "actor_message") lifecycle.set(record.messageId, [...(lifecycle.get(record.messageId) ?? []), record]);
	const batch = {
		occurrencePath: item.occurrence,
		enqueueSeqId: item.seqId,
		enqueuedAt: item.enqueued.timestamp,
		messages: item.enqueued.messages.map((message): HyperchartActorMessageInfo => {
			const records = lifecycle.get(message.messageId) ?? [];
			const accepted = records.find((record): record is Extract<DurableLogRecord, { type: "actor_message"; kind: "accepted" }> => record.type === "actor_message" && record.kind === "accepted");
			const replied = records.find((record): record is Extract<DurableLogRecord, { type: "actor_message"; kind: "replied" }> => record.type === "actor_message" && record.kind === "replied");
			const settled = records.find((record) => record.type === "actor_message" && record.kind === "settled");
			return {
				messageId: message.messageId,
				actorOccurrencePath: item.occurrence,
				actorGeneration: item.enqueued.generation,
				event: message.event,
				input: message.input,
				producerVisit: `${message.producerState}:${message.producerVisit}`,
				...(message.callId === undefined ? {} : { callId: message.callId }),
				batchIndex: message.batchIndex,
				status: settled !== undefined ? "settled" : replied !== undefined ? "replied" : accepted !== undefined ? "accepted" : "queued",
				...(accepted === undefined ? {} : { receiveState: accepted.receiveState, acceptedAt: accepted.timestamp }),
				...(replied === undefined ? {} : { repliedAt: replied.timestamp, ...(replied.replyEvent === undefined ? {} : { replyEvent: replied.replyEvent }), ...(Object.hasOwn(replied, "output") ? { replyOutput: replied.output } : {}) }),
			};
		}),
	};
	return ast === undefined || ancestry === undefined ? batch : enrichActorMessageBatch(batch, item, ast, ancestry);
}

function enrichActorMessageBatch(batch: HyperchartActorMessageBatchInfo, item: ActorMessageHistoryItem, ast: ChartAst, ancestry: readonly DurableLogRecord[]): HyperchartActorMessageBatchInfo {
	const logicalOccurrence = actorLogicalOccurrencePath(item.occurrence, item.enqueued.generation);
	if (!ancestry.some((record) => record.type === "actor_created" && record.occurrence === item.occurrence)) return { ...batch, messages: batch.messages.map((message) => ({ ...message, actorLogicalPath: logicalOccurrence })) };
	return actorMessageHistoryItemsToHost([item], ast, ancestry, [batch])[0]!;
}

/** Maps a bounded batch in one AST-aware replay pass. */
export function actorMessageHistoryItemsToHost(items: readonly ActorMessageHistoryItem[], ast: ChartAst, ancestry: readonly DurableLogRecord[], base = items.map((item) => actorMessageHistoryItemToHost(item))): readonly HyperchartActorMessageBatchInfo[] {
	const createdOccurrences = new Set(ancestry.filter((record): record is Extract<DurableLogRecord, { type: "actor_created" }> => record.type === "actor_created").map((record) => record.occurrence));
	if (items.every((item) => !createdOccurrences.has(item.occurrence))) return items.map((item, index) => ({ ...base[index]!, messages: base[index]!.messages.map((message) => ({ ...message, actorLogicalPath: actorLogicalOccurrencePath(item.occurrence, item.enqueued.generation) })) }));
	const replay = createBranchProjection(ast);
	const messages = new Map<string, { info: HyperchartActorMessageInfo; logicalOccurrence: string }>();
	for (let index = 0; index < items.length; index++) {
		const item = items[index]!;
		const logicalOccurrence = actorLogicalOccurrencePath(item.occurrence, item.enqueued.generation);
		for (const message of base[index]!.messages) messages.set(`${item.occurrence}\0${message.messageId}`, { info: { ...message, actorLogicalPath: logicalOccurrence }, logicalOccurrence });
	}
	for (const record of ancestry) {
		if (record.type === "actor_message") {
			const entry = messages.get(`${record.occurrence}\0${record.messageId}`);
			const message = entry?.info;
			const logicalOccurrence = entry?.logicalOccurrence;
			const actor = projectedActorEndpoint(replay, record.occurrence);
			if (message !== undefined && logicalOccurrence !== undefined && record.kind === "accepted") {
				message.status = "accepted"; message.acceptedAt = record.timestamp; message.receiveState = record.receiveState.replace(`${record.occurrence}.`, `${logicalOccurrence}.`);
				if (record.workerIndex !== undefined) { message.workerIndex = record.workerIndex; message.workerOccurrencePath = actorPoolWorkerOccurrencePath(record.occurrence, record.workerIndex); }
			} else if (message !== undefined && logicalOccurrence !== undefined && record.kind === "replied") {
				message.status = "replied"; message.repliedAt = record.timestamp;
				if (record.replyEvent !== undefined) message.replyEvent = record.replyEvent;
				if (Object.hasOwn(record, "output")) message.replyOutput = record.output;
				if (record.schema !== undefined) { message.replySchema = { schema: record.schema.schema }; message.validation = "valid"; }
				if (record.workerIndex !== undefined) { message.workerIndex = record.workerIndex; message.workerOccurrencePath = actorPoolWorkerOccurrencePath(record.occurrence, record.workerIndex); }
				const worker = actor?.definition.kind === "actorPool" && record.workerIndex !== undefined ? (actor as ProjectedActorPoolOccurrence).workers[record.workerIndex] : undefined;
				const ordinary = actor?.definition.kind === "actor" ? actor as ProjectedActorOccurrence : undefined;
				const currentState = worker?.currentState ?? ordinary?.currentState;
				if (currentState !== undefined) message.replyState = `${logicalOccurrence}${worker === undefined ? "" : `.$worker-${worker.index}`}.${currentState}`;
			} else if (message !== undefined && record.kind === "settled") message.status = "settled";
		}
		projectBranch(replay, ast, [record]);
	}
	return items.map((item, index) => ({ ...base[index]!, messages: base[index]!.messages.map((message) => messages.get(`${item.occurrence}\0${message.messageId}`)?.info ?? message) }));
}

export function durableRecordToHost(record: DurableLogRecord): HyperchartRecordInfo {
	return { seqId: record.seqId, parentId: record.parentId, branchId: record.branchId, type: record.type, timestamp: record.timestamp, record };
}

function invocationInfo(action: StateActionAst): HyperchartVisitInfo["invocation"] {
	switch (action.kind) {
		case "agent": return { kind: "agent", ...(action.task === undefined ? {} : { task: templatePreview(action.task) }) };
		case "script": return { kind: "script", command: action.command, args: [...action.args] };
		case "user": return { kind: "user", prompt: templatePreview(action.prompt) };
	}
}

function templatePreview(template: TemplateAst): string {
	const parts = [template.strings[0] ?? ""];
	for (let index = 0; index < template.refs.length; index++) parts.push("{{…}}", template.strings[index + 1] ?? "");
	return parts.join("");
}
