import { createHash, randomUUID } from "node:crypto";
import { createBranchProjection, projectBranch, type BranchProjection, type ProjectionSkippedRecord, type ProjectedActorEndpointOccurrence, type ProjectedActorOccurrence, type ProjectedActorPoolOccurrence } from "../core/projection.js";
import { actionUidKey } from "../core/action_uid.js";
import { actorContextForState, actorGenerationPath, actorLogicalOccurrencePath, actorOccurrencePath, actorPoolWorkerOccurrencePath, actorStatePath } from "../core/actors.js";
import { lastSegmentKey, matchesDeclaredUid, nodeAt, templatePath } from "../core/paths.js";
import { replayRecordDiagnostics, type ReplayStaleRecord, type ReplayUnpinnedRecord } from "../core/replay_check.js";
import { compactProjection, compileProjectionRetention } from "./projection_retention.js";
import type { ChartAst } from "../core/types.js";
import type { BranchId } from "../core/durable_events.js";
import {
	openExecutionReplay,
	type HistorySnapshot,
	type CheckpointQuery,
	type CheckpointRepository,
	type OpaqueCheckpointEnvelope,
} from "../runtime/generic/log_store.js";

/** Serialized projection shape/version. Increment whenever BranchProjection replay semantics change. */
export const PROJECTOR_VERSION = 1;
export const PROJECTION_CHECKPOINT_SCHEMA_VERSION = 1;
export const PROJECTION_CHECKPOINT_INTERVAL = 512;
export const EXECUTION_REPLAY_BATCH_RECORDS = 500;

export type ProjectionContract = Readonly<{
	projectorVersion: number;
	astDigest: string;
	selectorKey: string;
}>;

export type ProjectionCheckpoint = Readonly<{
	checkpointId: string;
	headSeqId: number | null;
	contract: ProjectionContract;
	projection: BranchProjection;
	createdAt: number;
}>;

export type LoadedBranchProjection = Readonly<{
	projection: BranchProjection;
	snapshot: HistorySnapshot;
	contract: ProjectionContract;
	checkpointHeadSeqId: number | null;
	replayedRecords: number;
	replayBatches: number;
	checkpointSaved: boolean;
	/** False when this ancestry contains diagnostics that checkpoints must never hide. */
	checkpointable: boolean;
	replay: Readonly<{
		skipped: readonly ProjectionSkippedRecord[];
		stale: readonly ReplayStaleRecord[];
		unpinned: readonly ReplayUnpinnedRecord[];
	}>;
}>;

/** SHA-256 over canonical JSON for the normalized AST. */
export function chartAstDigest(ast: ChartAst): string {
	return createHash("sha256").update(canonicalJson(ast)).digest("hex");
}

export function projectionContractForAst(ast: ChartAst): ProjectionContract {
	const astDigest = chartAstDigest(ast);
	return { projectorVersion: PROJECTOR_VERSION, astDigest, selectorKey: `hyperchart-projection:${PROJECTOR_VERSION}:${astDigest}` };
}

/**
 * Restore one captured branch head from a disposable compatible checkpoint plus
 * bounded oldest-first journal batches. Semantic projection and GC stay here,
 * never in storage.
 */
export async function loadBranchProjection(input: {
	ast: ChartAst;
	branchId: BranchId;
	store: CheckpointRepository;
	contract: ProjectionContract;
	/** Phase 4 orchestration requests exact fork/rewind/shutdown checkpoints explicitly. */
	saveCheckpoint?: "rebuild" | "always" | "never";
	/** @internal Fixed historical target used to prepare an atomic branch/move checkpoint. */
	snapshot?: HistorySnapshot;
}): Promise<LoadedBranchProjection> {
	const expectedContract = projectionContractForAst(input.ast);
	if (!sameContract(input.contract, expectedContract)) {
		throw new Error("Projection contract does not match the supplied normalized ChartAst");
	}
	const snapshot = input.snapshot ?? await input.store.captureSnapshot(input.branchId);
	if (snapshot.branchId !== input.branchId) throw new Error("Projection snapshot branch does not match the selected branch");
	const lookup: CheckpointQuery = { targetHeadSeqId: snapshot.headSeqId, selectorKey: input.contract.selectorKey };
	const exact = await input.store.loadExactCheckpoint(lookup);
	const nearest = exact === undefined ? await input.store.findNearestCheckpoint(lookup) : undefined;
	const selected = exact ?? nearest;
	const decoded = await acceptedCheckpoint(input.store, snapshot, input.contract, input.ast, selected);
	if (selected !== undefined && decoded === undefined && input.store.canStoreCheckpoints) {
		await input.store.discardCheckpoint(selected.checkpointId);
	}
	const projection = decoded === undefined ? createBranchProjection(input.ast) : structuredClone(decoded.projection);
	const checkpointHeadSeqId = decoded?.headSeqId ?? null;
	const retention = compileProjectionRetention(input.ast);
	const skipped: ProjectionSkippedRecord[] = [];
	const stale: ReplayStaleRecord[] = [];
	const unpinned: ReplayUnpinnedRecord[] = [];
	let replayedRecords = 0;
	let replayBatches = 0;

	for await (const batch of openExecutionReplay(input.store, {
		targetHeadSeqId: snapshot.headSeqId,
		afterSeqId: checkpointHeadSeqId,
	})) {
		if (batch.length > EXECUTION_REPLAY_BATCH_RECORDS) throw new Error("Projection replay source exceeded its fixed batch bound");
		replayBatches++;
		for (const record of batch) {
			const diagnostics = replayRecordDiagnostics(input.ast, projection, replayedRecords, record);
			stale.push(...diagnostics.stale);
			unpinned.push(...diagnostics.unpinned);
			projectBranch(projection, input.ast, [record], [], skipped);
			replayedRecords++;
		}
		compactProjection(projection, input.ast, retention);
	}
	compactProjection(projection, input.ast, retention);
	if (projection.seqId !== (snapshot.headSeqId ?? 0)) {
		throw new Error(`Projection replay stopped at seqId ${projection.seqId}, expected ${snapshot.headSeqId ?? 0}`);
	}

	let checkpointSaved = false;
	const replayIsCheckpointable = skipped.length === 0 && stale.length === 0 && unpinned.length === 0;
	const saveMode = input.saveCheckpoint ?? "rebuild";
	const saveRequested = saveMode === "always" || saveMode === "rebuild" && decoded === undefined;
	if (input.store.canStoreCheckpoints && replayIsCheckpointable && saveRequested && decoded?.headSeqId !== snapshot.headSeqId) {
		await input.store.storeCheckpoint(prepareProjectionCheckpoint(projection, input.contract, snapshot.headSeqId));
		checkpointSaved = true;
	}
	return {
		projection,
		snapshot,
		contract: input.contract,
		checkpointHeadSeqId,
		replayedRecords,
		replayBatches,
		checkpointSaved,
		checkpointable: replayIsCheckpointable,
		replay: { skipped, stale, unpinned },
	};
}

export function prepareProjectionCheckpoint(
	projection: BranchProjection,
	contract: ProjectionContract,
	headSeqId: number | null = projection.seqId === 0 ? null : projection.seqId,
): OpaqueCheckpointEnvelope {
	return encodeCheckpoint({ checkpointId: randomUUID(), headSeqId, contract, projection, createdAt: Date.now() });
}

export function encodeCheckpoint(checkpoint: ProjectionCheckpoint): OpaqueCheckpointEnvelope {
	return {
		checkpointId: checkpoint.checkpointId,
		headSeqId: checkpoint.headSeqId,
		selectorKey: checkpoint.contract.selectorKey,
		blob: {
			schemaVersion: PROJECTION_CHECKPOINT_SCHEMA_VERSION,
			projectorVersion: checkpoint.contract.projectorVersion,
			astDigest: checkpoint.contract.astDigest,
			projection: JSON.parse(JSON.stringify(checkpoint.projection)) as unknown,
		},
		createdAt: checkpoint.createdAt,
	};
}

export function decodeCheckpoint(stored: OpaqueCheckpointEnvelope, ast?: ChartAst): ProjectionCheckpoint | undefined {
	if (!isNonEmptyString(stored.checkpointId) || !isHead(stored.headSeqId) || !isNonNegativeInteger(stored.createdAt)) return undefined;
	if (!isRecord(stored.blob) || stored.blob.schemaVersion !== PROJECTION_CHECKPOINT_SCHEMA_VERSION
		|| !isPositiveInteger(stored.blob.projectorVersion) || typeof stored.blob.astDigest !== "string" || !/^[a-f0-9]{64}$/.test(stored.blob.astDigest)) return undefined;
	const projection = decodeBranchProjection(stored.blob.projection);
	if (projection === undefined) return undefined;
	if (ast !== undefined && !projectionMatchesAst(projection, ast)) return undefined;
	if (ast === undefined && (Object.keys(projection.actors).length > 0 || Object.keys(projection.actorPools).length > 0)) return undefined;
	const selectorKey = `hyperchart-projection:${stored.blob.projectorVersion}:${stored.blob.astDigest}`;
	const contract = { projectorVersion: stored.blob.projectorVersion, astDigest: stored.blob.astDigest, selectorKey };
	if (stored.selectorKey !== selectorKey) return undefined;
	return { checkpointId: stored.checkpointId, headSeqId: stored.headSeqId, contract, projection, createdAt: stored.createdAt };
}

async function acceptedCheckpoint(
	store: CheckpointRepository,
	snapshot: HistorySnapshot,
	contract: ProjectionContract,
	ast: ChartAst,
	stored: OpaqueCheckpointEnvelope | undefined,
): Promise<ProjectionCheckpoint | undefined> {
	if (stored === undefined || stored.selectorKey !== contract.selectorKey) return undefined;
	const checkpoint = decodeCheckpoint(stored, ast);
	if (checkpoint === undefined || checkpoint.projection.seqId !== (checkpoint.headSeqId ?? 0)) return undefined;
	if (checkpoint.headSeqId === null) return checkpoint;
	if (await store.getRecord(checkpoint.headSeqId) === undefined) return undefined;
	if (!await store.containsInHistory({ headSeqId: snapshot.headSeqId, seqId: checkpoint.headSeqId })) return undefined;
	return checkpoint;
}

function decodeBranchProjection(value: unknown): BranchProjection | undefined {
	if (!isExactRecord(value, ["activeLeaves", "seqId", "pendingActions", "openUserInteractions", "spawns", "inputs", "results", "stateVisits", "sessions", "artifactPins", "actors", "actorPools", "liveActorMessages", "pendingActorCalls", "actorProducerVisits"], ["args", "failure"])) return undefined;
	if (!isStringArray(value.activeLeaves) || !isNonNegativeInteger(value.seqId) || !isPendingActions(value.pendingActions)
		|| !isOpenInteractions(value.openUserInteractions) || !(value.args === undefined || isJsonRecord(value.args))
		|| !isRecordOfJsonRecords(value.spawns) || !isRecordOfJsonRecords(value.inputs) || !isRecordOfJson(value.results)
		|| !isRecordOfPositiveIntegers(value.stateVisits) || !isRecordOfNonEmptyStrings(value.sessions) || !isArtifactPins(value.artifactPins)
		|| !(value.failure === undefined || isFailure(value.failure)) || !isActors(value.actors) || !isActorPools(value.actorPools)
		|| !isLiveActorMessages(value.liveActorMessages) || !isPendingActorCalls(value.pendingActorCalls) || !isRecordOfPositiveIntegers(value.actorProducerVisits)) return undefined;
	return structuredClone(value) as BranchProjection;
}

function isPendingActions(value: unknown): boolean { return Array.isArray(value) && value.every(isPendingAction); }
function isPendingAction(value: unknown): boolean {
	if (!isRecord(value) || !isActionUid(value.actionUid) || !isPositiveInteger(value.visitId) || !isPositiveInteger(value.seqId)
		|| !isPositiveInteger(value.invokeSeqId) || !isNonEmptyString(value.sessionId) || !(value.gateSeqId === undefined || isPositiveInteger(value.gateSeqId))) return false;
	if (value.phase === "running") return isExactRecord(value, ["actionUid", "visitId", "seqId", "invokeSeqId", "sessionId", "timestamp", "phase"], ["gateSeqId"])
		&& isNonNegativeFinite(value.timestamp);
	if (value.phase === "validating") return isExactRecord(value, ["actionUid", "visitId", "seqId", "invokeSeqId", "sessionId", "phase", "event", "validationAttempts"], ["gateSeqId"])
		&& isChartEvent(value.event) && isNonNegativeInteger(value.validationAttempts);
	if (value.phase === "rejected") return isExactRecord(value, ["actionUid", "visitId", "seqId", "invokeSeqId", "sessionId", "phase", "event", "validationAttempts"], ["gateSeqId", "reason"])
		&& isChartEvent(value.event) && isNonNegativeInteger(value.validationAttempts) && (value.reason === undefined || typeof value.reason === "string");
	return false;
}
function isOpenInteractions(value: unknown): boolean {
	return isRecord(value) && Object.entries(value).every(([key, entry]) => {
		if (!/^(0|[1-9][0-9]*)$/.test(key) || !isExactRecord(entry, ["opened", "status"], []) || entry.status !== "open") return false;
		const opened = entry.opened;
		return isOpenedInteraction(opened) && Number(key) === opened.seqId;
	});
}
function isOpenedInteraction(value: unknown): value is Record<string, unknown> {
	return isExactRecord(value, ["type", "kind", "actionUid", "phaseSeqId", "prompt", "options", "events", "seqId", "parentId", "branchId", "timestamp"], ["reply", "rejection"])
		&& value.type === "user_interaction" && value.kind === "opened" && isActionUid(value.actionUid) && isPositiveInteger(value.phaseSeqId)
		&& typeof value.prompt === "string" && isStringArray(value.options) && isStringArray(value.events) && isCoordinates(value)
		&& (value.reply === undefined || isSchemaAst(value.reply)) && (value.rejection === undefined || isRejection(value.rejection));
}
function isRejection(value: unknown): boolean {
	return isExactRecord(value, ["attempt", "onReject"], ["reason"]) && isPositiveInteger(value.attempt)
		&& (value.onReject === "resume" || value.onReject === "restart") && (value.reason === undefined || typeof value.reason === "string");
}
function isArtifactPins(value: unknown): boolean {
	return isRecord(value) && Object.values(value).every((pin) => isExactRecord(pin, ["hash", "size"], []) && /^[a-f0-9]{64}$/.test(String(pin.hash)) && isNonNegativeInteger(pin.size));
}
function isFailure(value: unknown): boolean {
	return isExactRecord(value, ["origin", "error", "seqId"], []) && isNonEmptyString(value.origin) && isPositiveInteger(value.seqId) && isJsonValue(value.error);
}
function isActors(value: unknown): boolean { return isRecord(value) && Object.values(value).every(isActor); }
function isActor(value: unknown): boolean {
	return isExactRecord(value, ["declaration", "logicalOccurrence", "occurrence", "generation", "input", "definition", "currentState", "mailbox", "status"], ["owner", "currentMessageId"])
		&& isPath(value.declaration) && isPath(value.logicalOccurrence) && isPath(value.occurrence) && isPositiveInteger(value.generation)
		&& (value.owner === undefined || isPath(value.owner)) && isJsonValue(value.input) && isActorDefinition(value.definition, "actor") && isPath(value.currentState)
		&& isStringArray(value.mailbox) && (value.currentMessageId === undefined || isNonEmptyString(value.currentMessageId))
		&& isOneOf(value.status, ["idle", "busy", "closing", "draining", "stopped", "failed", "cancelled"]);
}
function isActorPools(value: unknown): boolean { return isRecord(value) && Object.values(value).every(isActorPool); }
function isActorPool(value: unknown): boolean {
	return isExactRecord(value, ["declaration", "logicalOccurrence", "occurrence", "generation", "input", "definition", "mailbox", "workers", "status"], ["owner"])
		&& isPath(value.declaration) && isPath(value.logicalOccurrence) && isPath(value.occurrence) && isPositiveInteger(value.generation)
		&& (value.owner === undefined || isPath(value.owner)) && isJsonValue(value.input) && isActorDefinition(value.definition, "actorPool")
		&& isStringArray(value.mailbox) && Array.isArray(value.workers) && value.workers.every(isWorker)
		&& isOneOf(value.status, ["idle", "busy", "closing", "draining", "stopped", "failed", "cancelled"]);
}
function isWorker(value: unknown): boolean {
	return isExactRecord(value, ["index", "occurrence", "currentState", "status"], ["currentMessageId"])
		&& isNonNegativeInteger(value.index) && isPath(value.occurrence) && isPath(value.currentState)
		&& (value.currentMessageId === undefined || isNonEmptyString(value.currentMessageId))
		&& isOneOf(value.status, ["idle", "busy", "draining", "stopped", "failed", "cancelled"]);
}
function isLiveActorMessages(value: unknown): boolean {
	return isRecord(value) && Object.entries(value).every(([messageId, message]) => messageId === (message as Record<string, unknown>)?.messageId && isProjectedMessage(message));
}
function isProjectedMessage(value: unknown): boolean {
	return isExactRecord(value, ["messageId", "event", "input", "producerState", "producerVisit", "batchIndex", "status"], ["callId", "receiveState", "replyEvent", "replyOutput", "workerIndex"])
		&& isNonEmptyString(value.messageId) && isNonEmptyString(value.event) && isJsonValue(value.input) && isPath(value.producerState)
		&& isPositiveInteger(value.producerVisit) && (value.callId === undefined || isNonEmptyString(value.callId)) && isNonNegativeInteger(value.batchIndex)
		&& isOneOf(value.status, ["queued", "accepted", "replied", "settled", "failed", "cancelled"])
		&& (value.receiveState === undefined || isPath(value.receiveState)) && (value.replyEvent === undefined || isNonEmptyString(value.replyEvent))
		&& (value.replyOutput === undefined || isJsonValue(value.replyOutput)) && (value.workerIndex === undefined || isNonNegativeInteger(value.workerIndex));
}
function isPendingActorCalls(value: unknown): boolean { return isRecord(value) && Object.values(value).every(isPendingActorCall); }
function isPendingActorCall(value: unknown): boolean {
	if (!isRecord(value) || !isNonEmptyString(value.callId) || !isPath(value.callerState) || !isPath(value.occurrence)
		|| !isOneOf(value.status, ["enqueued", "accepted", "partial"])) return false;
	if (value.kind === "singleton") return isExactRecord(value, ["kind", "callId", "callerState", "occurrence", "messageId", "status"], []) && isNonEmptyString(value.messageId);
	if (value.kind === "batch") return isExactRecord(value, ["kind", "callId", "callerState", "occurrence", "messageIds", "status"], [])
		&& isStringArray(value.messageIds) && value.messageIds.length > 0 && value.messageIds.every(isNonEmptyString)
		&& new Set(value.messageIds).size === value.messageIds.length;
	return false;
}
function isActorDefinition(value: unknown, kind: "actor" | "actorPool"): boolean {
	if (!isRecord(value) || value.kind !== kind || !isNonEmptyString(value.name) || !isPath(value.path) || !(value.owner === undefined || isPath(value.owner))
		|| !isSchemaAst(value.input) || !isJsonValue(value.inputValue) || !isProtocol(value.protocol)) return false;
	if (kind === "actor") return isExactRecord(value, ["kind", "name", "path", "input", "inputValue", "protocol", "initial", "states"], ["owner"])
		&& isNonEmptyString(value.initial) && isStateRecord(value.states);
	return isExactRecord(value, ["kind", "name", "path", "input", "inputValue", "protocol", "concurrency", "worker"], ["owner"])
		&& isPositiveInteger(value.concurrency) && isWorkerDefinition(value.worker);
}
function isWorkerDefinition(value: unknown): boolean {
	return isExactRecord(value, ["input", "protocol", "initial", "states"], []) && isSchemaAst(value.input) && isProtocol(value.protocol)
		&& isNonEmptyString(value.initial) && isStateRecord(value.states);
}
function isProtocol(value: unknown): boolean { return isRecord(value) && Object.values(value).every((entry) => isRecord(entry) && isJsonValue(entry)); }
function isStateRecord(value: unknown): boolean {
	return isRecord(value) && Object.values(value).every((state) => isRecord(state) && isOneOf(state.kind, ["state", "receive", "send", "sendBatch", "call", "callBatch", "reply"]) && isJsonValue(state));
}
function isSchemaAst(value: unknown): boolean { return isExactRecord(value, ["kind", "schema"], ["runtimeContract"]) && value.kind === "jsonSchema" && isJsonValue(value.schema) && (value.runtimeContract === undefined || isJsonValue(value.runtimeContract)); }
function isChartEvent(value: unknown): boolean { return isExactRecord(value, ["type"], ["output", "error"]) && isNonEmptyString(value.type) && (value.output === undefined || isJsonValue(value.output)) && (value.error === undefined || isJsonValue(value.error)); }
function isActionUid(value: unknown): boolean { return isExactRecord(value, ["chart", "state", "action"], []) && isNonEmptyString(value.chart) && isPath(value.state) && isNonEmptyString(value.action); }
function isCoordinates(value: Record<string, unknown>): boolean { return isPositiveInteger(value.seqId) && (value.parentId === null || isPositiveInteger(value.parentId)) && isNonEmptyString(value.branchId) && isNonNegativeFinite(value.timestamp); }
function projectionMatchesAst(projection: BranchProjection, ast: ChartAst): boolean {
	if (!projection.activeLeaves.every((path) => isMainLeaf(ast, projection, path))) return false;
	if (!Object.keys(projection.spawns).every((path) => nodeAt(ast, path)?.kind === "map" && concreteMapPathValid(ast, projection, path))) return false;
	if (![...Object.keys(projection.inputs), ...Object.keys(projection.results)].every((path) => semanticStateExists(ast, projection, path))) return false;
	if (!projection.pendingActions.every((pending) => {
		const state = actionStateFor(ast, projection, pending.actionUid.state);
		return state !== undefined && matchesDeclaredUid(pending.actionUid, state.action.uid)
			&& pending.invokeSeqId <= pending.seqId && pending.seqId <= projection.seqId
			&& (pending.gateSeqId === undefined || pending.gateSeqId <= projection.seqId)
			&& projection.stateVisits[actionUidKey(pending.actionUid)] === pending.visitId;
	})) return false;
	if (!Object.values(projection.openUserInteractions).every((interaction) => {
		const state = actionStateFor(ast, projection, interaction.opened.actionUid.state);
		return state?.action.kind === "user" && matchesDeclaredUid(interaction.opened.actionUid, state.action.uid)
			&& interaction.opened.seqId <= projection.seqId && interaction.opened.phaseSeqId <= interaction.opened.seqId;
	})) return false;
	if (!Object.entries(projection.actors).every(([key, endpoint]) => key === endpoint.occurrence && endpointMatchesAst(ast, projection, endpoint))) return false;
	if (!Object.entries(projection.actorPools).every(([key, endpoint]) => key === endpoint.occurrence && poolMatchesAst(ast, projection, endpoint))) return false;
	if (!Object.values(projection.pendingActorCalls).every((call) => {
		const node = producerStateFor(ast, projection, call.callerState);
		const messageIds = call.kind === "singleton" ? [call.messageId] : call.messageIds;
		return (node?.kind === "call" || node?.kind === "callBatch") && projectedEndpoint(projection, call.occurrence) !== undefined
			&& messageIds.every((messageId) => {
				const message = projection.liveActorMessages[messageId];
				return message?.callId === call.callId && messageCoordinatesMatchAst(ast, projection, message);
			});
	})) return false;
	const referencedMessageIds = new Set<string>();
	const operationalMessageIds: string[] = [];
	for (const endpoint of [...Object.values(projection.actors), ...Object.values(projection.actorPools)]) {
		for (const messageId of endpoint.mailbox) {
			referencedMessageIds.add(messageId);
			operationalMessageIds.push(messageId);
		}
		if ("workers" in endpoint) {
			for (const worker of endpoint.workers) if (worker.currentMessageId !== undefined) {
				referencedMessageIds.add(worker.currentMessageId);
				operationalMessageIds.push(worker.currentMessageId);
			}
		} else if (endpoint.currentMessageId !== undefined) {
			referencedMessageIds.add(endpoint.currentMessageId);
			operationalMessageIds.push(endpoint.currentMessageId);
		}
	}
	if (new Set(operationalMessageIds).size !== operationalMessageIds.length) return false;
	for (const call of Object.values(projection.pendingActorCalls)) {
		if (call.kind === "singleton") referencedMessageIds.add(call.messageId);
		else for (const messageId of call.messageIds) referencedMessageIds.add(messageId);
	}
	if (referencedMessageIds.size !== Object.keys(projection.liveActorMessages).length
		|| ![...referencedMessageIds].every((messageId) => projection.liveActorMessages[messageId] !== undefined)) return false;
	return Object.keys(projection.actorProducerVisits).every((path) => {
		const node = producerStateFor(ast, projection, path);
		return node?.kind === "send" || node?.kind === "sendBatch" || node?.kind === "call" || node?.kind === "callBatch";
	});
}
function isMainLeaf(ast: ChartAst, projection: BranchProjection, path: string): boolean {
	const node = nodeAt(ast, path);
	if (node === undefined || !concreteMapPathValid(ast, projection, path)) return false;
	if (node.kind === "map") return lastSegmentKey(path) === undefined;
	return node.kind !== "compound" && node.kind !== "region" && node.kind !== "parallel";
}
function semanticStateExists(ast: ChartAst, projection: BranchProjection, path: string): boolean {
	return (nodeAt(ast, path) !== undefined || actorContextForState(ast, path) !== undefined) && concreteMapPathValid(ast, projection, path);
}
function actionStateFor(ast: ChartAst, projection: BranchProjection, path: string) {
	if (!concreteMapPathValid(ast, projection, path)) return undefined;
	const node = actorContextForState(ast, path)?.node ?? nodeAt(ast, path);
	return node?.kind === "state" ? node : undefined;
}
function producerStateFor(ast: ChartAst, projection: BranchProjection, path: string) {
	if (!concreteMapPathValid(ast, projection, path)) return undefined;
	return actorContextForState(ast, path)?.node ?? nodeAt(ast, path);
}
function endpointMatchesAst(ast: ChartAst, projection: BranchProjection, endpoint: ProjectedActorOccurrence): boolean {
	const declaration = ast.actors[endpoint.declaration];
	if (declaration === undefined || declaration.kind !== "actor") return false;
	if (canonicalJson(endpoint.definition) !== canonicalJson(declaration)) return false;
	if (!endpointIdentityMatches(ast, declaration, endpoint, projection)) return false;
	const context = actorContextForState(ast, actorStatePath(endpoint.occurrence, endpoint.currentState));
	const current = endpoint.currentMessageId === undefined ? undefined : projection.liveActorMessages[endpoint.currentMessageId];
	return context !== undefined && context.declaration.path === declaration.path && context.occurrence === endpoint.occurrence
		&& new Set(endpoint.mailbox).size === endpoint.mailbox.length
		&& endpoint.mailbox.every((messageId) => {
			const message = projection.liveActorMessages[messageId];
			return message?.status === "queued" && messageCoordinatesMatchAst(ast, projection, message);
		})
		&& (endpoint.currentMessageId === undefined || (!endpoint.mailbox.includes(endpoint.currentMessageId)
			&& current !== undefined && current.status !== "queued" && current.status !== "settled" && messageCoordinatesMatchAst(ast, projection, current)));
}
function poolMatchesAst(ast: ChartAst, projection: BranchProjection, endpoint: ProjectedActorPoolOccurrence): boolean {
	const declaration = ast.actors[endpoint.declaration];
	if (declaration === undefined || declaration.kind !== "actorPool") return false;
	if (canonicalJson(endpoint.definition) !== canonicalJson(declaration) || !endpointIdentityMatches(ast, declaration, endpoint, projection)) return false;
	if (endpoint.workers.length !== declaration.concurrency) return false;
	const indexes = new Set<number>();
	const workerMessages = new Set<string>();
	for (const worker of endpoint.workers) {
		if (worker.index >= declaration.concurrency || indexes.has(worker.index) || worker.occurrence !== actorPoolWorkerOccurrencePath(endpoint.occurrence, worker.index)) return false;
		indexes.add(worker.index);
		const context = actorContextForState(ast, actorStatePath(worker.occurrence, worker.currentState));
		if (context === undefined || context.declaration.path !== declaration.path || context.endpointOccurrence !== endpoint.occurrence || context.workerIndex !== worker.index) return false;
		if (worker.currentMessageId !== undefined) {
			const current = projection.liveActorMessages[worker.currentMessageId];
			if (workerMessages.has(worker.currentMessageId) || endpoint.mailbox.includes(worker.currentMessageId)
				|| current === undefined || current.status === "queued" || current.status === "settled"
				|| !messageCoordinatesMatchAst(ast, projection, current)) return false;
			workerMessages.add(worker.currentMessageId);
		}
	}
	return new Set(endpoint.mailbox).size === endpoint.mailbox.length
		&& endpoint.mailbox.every((messageId) => {
			const message = projection.liveActorMessages[messageId];
			return message?.status === "queued" && messageCoordinatesMatchAst(ast, projection, message);
		});
}
function endpointIdentityMatches(ast: ChartAst, declaration: ChartAst["actors"][string], endpoint: ProjectedActorEndpointOccurrence, projection: BranchProjection): boolean {
	if (declaration.owner === undefined) {
		if (endpoint.owner !== undefined) return false;
	} else {
		if (endpoint.owner === undefined || templatePath(endpoint.owner) !== declaration.owner) return false;
		const ownerNode = nodeAt(ast, declaration.owner);
		if (ownerNode === undefined) return false;
		if (ownerNode.kind === "map") {
			if (!concreteMapPathValidForOwner(projection, endpoint.owner, declaration.owner)) return false;
		} else if (!concreteMapPathValid(ast, projection, endpoint.owner)) return false;
	}
	const logical = actorOccurrencePath(declaration, endpoint.owner);
	return endpoint.logicalOccurrence === logical && actorLogicalOccurrencePath(endpoint.occurrence, endpoint.generation) === logical
		&& endpoint.occurrence === actorGenerationPath(logical, endpoint.generation);
}
function concreteMapPathValidForOwner(projection: BranchProjection, owner: string, declarationOwner: string): boolean {
	if (templatePath(owner) !== declarationOwner || lastSegmentKey(owner) === undefined) return false;
	const hash = owner.lastIndexOf("#");
	const container = owner.slice(0, hash); const key = owner.slice(hash + 1);
	return key.length > 0 && Object.prototype.hasOwnProperty.call(projection.spawns[container] ?? {}, key);
}
function projectedEndpoint(projection: BranchProjection, occurrence: string): ProjectedActorEndpointOccurrence | undefined {
	return projection.actors[occurrence] ?? projection.actorPools[occurrence];
}
function messageCoordinatesMatchAst(ast: ChartAst, projection: BranchProjection, message: { producerState: string } | undefined): boolean {
	if (message === undefined) return false;
	const node = producerStateFor(ast, projection, message.producerState);
	return node?.kind === "send" || node?.kind === "sendBatch" || node?.kind === "call" || node?.kind === "callBatch";
}
function concreteMapPathValid(ast: ChartAst, projection: BranchProjection, path: string): boolean {
	const segments = path.split(".");
	const prefix: string[] = [];
	for (const segment of segments) {
		const hash = segment.indexOf("#");
		if (hash < 0) { prefix.push(segment); continue; }
		const base = segment.slice(0, hash); const key = segment.slice(hash + 1);
		if (base.length === 0 || key.length === 0) return false;
		const container = [...prefix, base].join(".");
		if (nodeAt(ast, container)?.kind !== "map" || !Object.prototype.hasOwnProperty.call(projection.spawns[container] ?? {}, key)) return false;
		prefix.push(segment);
	}
	return templatePath(path).length > 0;
}
function isRecordOfJsonRecords(value: unknown): boolean { return isRecord(value) && Object.values(value).every(isJsonRecord); }
function isRecordOfJson(value: unknown): boolean { return isRecord(value) && Object.values(value).every(isJsonValue); }
function isRecordOfNonEmptyStrings(value: unknown): boolean { return isRecord(value) && Object.values(value).every(isNonEmptyString); }
function isRecordOfPositiveIntegers(value: unknown): boolean { return isRecord(value) && Object.values(value).every(isPositiveInteger); }
function isJsonRecord(value: unknown): value is Record<string, unknown> { return isRecord(value) && Object.values(value).every(isJsonValue); }
function isJsonValue(value: unknown): boolean { return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || Array.isArray(value) && value.every(isJsonValue) || isRecord(value) && Object.values(value).every(isJsonValue); }
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((entry) => typeof entry === "string"); }
function isPath(value: unknown): value is string { return isNonEmptyString(value); }
function isHead(value: unknown): value is number | null { return value === null || isPositiveInteger(value); }
function isPositiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function isNonNegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function isNonNegativeFinite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function isNonEmptyString(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isExactRecord(value: unknown, required: readonly string[], optional: readonly string[]): value is Record<string, unknown> {
	if (!isRecord(value) || required.some((key) => !(key in value))) return false;
	const allowed = new Set([...required, ...optional]);
	return Object.keys(value).every((key) => allowed.has(key));
}
function isOneOf(value: unknown, values: readonly string[]): value is string { return typeof value === "string" && values.includes(value); }
function sameContract(left: ProjectionContract, right: ProjectionContract): boolean {
	return left.projectorVersion === right.projectorVersion && left.astDigest === right.astDigest && left.selectorKey === right.selectorKey;
}

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
	if (Array.isArray(value)) return `[${value.map((entry) => entry === undefined ? "null" : canonicalJson(entry)).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	}
	throw new Error(`Normalized ChartAst contains a non-JSON value of type ${typeof value}`);
}
