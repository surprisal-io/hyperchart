import { actionUidKey } from "../core/action_uid.js";
import type { DurableLogRecord } from "../core/durable_events.js";
import type { HyperchartInspectResult, HyperchartInspectState } from "../core/inspect.js";
import {
	concurrencyBlockedActionLeaves,
	renderPendingActionInvocation,
	type ActionEffect,
	type RenderedArtifact,
} from "../core/machine.js";
import {
	createBranchProjection,
	projectBranch,
	projectedActorEndpoint,
	projectedActorEndpoints,
	type PendingAction,
	type ProjectedActorOccurrence,
	type ProjectedActorPoolOccurrence,
	type ProjectionSkippedRecord,
} from "../core/projection.js";
import type { ActionUID, ChartAst, ChartEvent, StatePath } from "../core/types.js";
import { actorDefinitionForEndpoint, actorPoolWorkerOccurrencePath } from "../core/actors.js";
import {
	instancePathFor,
	nearestInstance,
	nodeAt,
	parentPath,
	siblingPath,
	stripLastKey,
	templatePath,
	underScope,
} from "../core/paths.js";
import type {
	HyperchartActorDeclarationInfo,
	HyperchartActorMessageContractInfo,
	HyperchartActorMessageInfo,
	HyperchartActorOccurrenceInfo,
	HyperchartActorSentMessageInfo,
	HyperchartAgentSessionInfo,
	HyperchartInputInfo,
	HyperchartIssueInfo,
	HyperchartMapVisitInfo,
	HyperchartSessionMessageInfo,
	HyperchartStateInfo,
	HyperchartRefInfo,
	HyperchartRunInfo,
	HyperchartRenderedArtifactInfo,
	HyperchartVisitInfo,
	HyperchartVisitInvocationInfo,
	HyperchartRunStatus,
	HyperchartStateStatus,
} from "./models.js";

function actorOccurrenceInspectorId(occurrencePath: StatePath): string {
	// Inspector identity follows the concrete logical placement. Durable projection
	// still keeps declaration and occurrence paths as separate facts.
	return occurrencePath;
}

export function actorTargetForInspectorState(
	stateId: string,
	declarationPath: string,
	occurrences: readonly HyperchartActorOccurrenceInfo[],
): string | undefined {
	const target = occurrences
		.filter((occurrence) => {
			if (occurrence.declarationPath !== declarationPath) return false;
			const owner = occurrence.ownerPath;
			return owner === undefined || stateId === owner || stateId.startsWith(`${owner}.`) || stateId.startsWith(`${owner}#`);
		})
		.sort((left, right) => (right.ownerPath?.length ?? 0) - (left.ownerPath?.length ?? 0))[0];
	return target?.logicalPath ?? target?.occurrencePath;
}

export type HyperchartRunFromInspectOptions = {
	runId?: string;
	status?: HyperchartRunInfo["status"];
	cwd?: string;
	createdAt?: number;
	updatedAt?: number;
	args?: Record<string, unknown>;
	description?: string;
};

export function hyperchartRunFromInfo(
	info: import("./models.js").HyperchartInfo,
	options: Pick<HyperchartRunFromInspectOptions, "cwd"> = {},
): HyperchartRunInfo | undefined {
	if (!info.states) return undefined;
	const updatedAt = info.updatedAt ?? Date.now();
	return {
		runId: `chart:${info.name}`,
		chartName: info.name,
		mode: "static",
		...(info.definitionSource === undefined ? {} : { definitionSource: info.definitionSource }),
		description: info.description,
		status: "paused",
		cwd: options.cwd ?? "",
		createdAt: updatedAt,
		updatedAt,
		...(info.args === undefined ? {} : { launchArgs: info.args }),
		args: {},
		states: info.states,
		stateCount: info.stateCount,
	};
}

type InspectActorMessageContract = NonNullable<NonNullable<HyperchartInspectState["actorMessageDefinition"]>["contracts"]>[number];

function actorMessageContractInfo(message: InspectActorMessageContract): HyperchartActorMessageContractInfo {
	return {
		event: message.event,
		input: { schema: message.inputSchema },
		reply: message.reply.kind === "void"
			? { kind: "void" }
			: message.reply.kind === "single"
				? { kind: "single", schema: { schema: message.reply.schema } }
				: { kind: "named", schemas: Object.fromEntries(Object.entries(message.reply.schemas).map(([event, schema]) => [event, { schema }])) },
	};
}

export function hyperchartRunFromInspectResult(
	result: HyperchartInspectResult,
	options: HyperchartRunFromInspectOptions = {},
): HyperchartRunInfo {
	const now = Date.now();
	const actorDeclarations: HyperchartActorDeclarationInfo[] = (result.actorDeclarations ?? []).map((actor) => ({
		kind: actor.kind,
		declarationPath: actor.declarationPath,
		...(actor.ownerPath === undefined ? {} : { ownerPath: actor.ownerPath }),
		...(actor.definitionSource === undefined ? {} : { definitionSource: actor.definitionSource }),
		inputSchema: { schema: actor.inputSchema },
		inputValue: actor.inputValue,
		initialReceive: actor.initialReceive,
		...(actor.concurrency === undefined ? {} : { concurrency: actor.concurrency }),
		protocol: actor.protocol.map(actorMessageContractInfo),
	}));
	const states = [
		...result.states.map(stateFromInspectState),
		...actorDeclarations.map((actor): HyperchartStateInfo => ({
			id: actor.declarationPath,
			...(actor.ownerPath === undefined ? {} : { scopeParentId: actor.ownerPath }),
			...(actor.definitionSource === undefined ? {} : { definitionSource: actor.definitionSource }),
			type: "actor-declaration",
			status: "pending",
			actorDeclaration: actor,
		})),
	];
	return {
		runId: options.runId ?? `inspect:${result.chartId}`,
		chartName: result.chartId,
		mode: "static",
		...(result.definitionSource === undefined ? {} : { definitionSource: result.definitionSource }),
		...(options.description === undefined ? {} : { description: options.description }),
		status: options.status ?? "paused",
		cwd: options.cwd ?? "",
		createdAt: options.createdAt ?? now,
		updatedAt: options.updatedAt ?? now,
		...(result.args === undefined ? {} : { launchArgs: result.args }),
		args: options.args ?? {},
		states,
		stateCount: states.length,
		...(actorDeclarations.length === 0 ? {} : { actorDeclarations }),
	};
}

export function hyperchartRunFromToolDetails(
	details: unknown,
	options: HyperchartRunFromInspectOptions = {},
): HyperchartRunInfo | undefined {
	if (isRunInfo(details)) return details;
	const inspector = isRecord(details) ? details.inspector : undefined;
	if (isRunInfo(inspector)) return inspector;
	if (!isInspectResult(details)) return undefined;
	return hyperchartRunFromInspectResult(details, options);
}

type RuntimeStatusInfo = {
	runId?: string;
	branchId?: string;
	runDir?: string;
	chartId?: string;
	state?: string;
	pid?: number;
	startedAt?: number;
	updatedAt?: number;
	heartbeatAt?: number;
	exitCode?: number;
	error?: string;
	replayWarnings?: readonly string[];
};

export type HyperchartRuntimeSessionProgressInfo = {
	actionUid: ActionUID;
	actionKey?: string;
	visit?: number;
	actionName?: string;
	status?: string;
	startedAt?: number;
	lastActivityAt?: number;
	completedAt?: number;
	sessionFile?: string;
	role?: string;
	model?: string;
	thinking?: string;
	toolset?: string;
	tools?: string[];
	turnCount?: number;
	toolCount?: number;
	tokenCount?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentText?: string;
	currentReasoning?: string;
	lastMessage?: string;
	error?: string;
	messages?: HyperchartSessionMessageInfo[];
};

export type HyperchartRuntimeSessionProgressFile = {
	updatedAt?: number;
	sessions: Record<string, HyperchartRuntimeSessionProgressInfo>;
};

export type HyperchartRunFromRuntimeOptions = {
	runId?: string;
	status?: RuntimeStatusInfo;
	sessionProgress?: HyperchartRuntimeSessionProgressFile;
	cwd?: string;
	createdAt?: number;
	updatedAt?: number;
	description?: string;
	now?: number;
};

export function hyperchartRunFromRuntime(
	inspect: HyperchartInspectResult,
	ast: ChartAst,
	records: readonly DurableLogRecord[],
	options: HyperchartRunFromRuntimeOptions = {},
): HyperchartRunInfo {
	const skipped: ProjectionSkippedRecord[] = [];
	const projection = projectBranch(createBranchProjection(ast), ast, records, [], skipped);
	const staticRun = hyperchartRunFromInspectResult(inspect, {
		runId: options.runId ?? options.status?.runId ?? `run:${ast.id}`,
		status: runtimeRunStatus(options.status?.state),
		cwd: options.cwd ?? "",
		createdAt: options.createdAt ?? options.status?.startedAt ?? firstTimestamp(records) ?? options.now ?? Date.now(),
		updatedAt: options.updatedAt ?? options.status?.updatedAt ?? lastTimestamp(records) ?? options.now ?? Date.now(),
		args: projection.args === undefined ? {} : { ...projection.args },
		...(options.description === undefined ? {} : { description: options.description }),
	});
	const runtime = runtimeFacts(ast, records, projection, skipped, options.sessionProgress);
	const staticStates = staticRun.states.map((state) => overlayRuntimeState(state, ast, projection, runtime));
	const projectedActors = projectedActorEndpoints(projection);
	const actorGenerationsByLogicalOccurrence = new Map<StatePath, typeof projectedActors>();
	for (const actor of projectedActors) {
		const generations = actorGenerationsByLogicalOccurrence.get(actor.logicalOccurrence) ?? [];
		generations.push(actor);
		actorGenerationsByLogicalOccurrence.set(actor.logicalOccurrence, generations);
	}
	for (const generations of actorGenerationsByLogicalOccurrence.values()) {
		generations.sort((left, right) => left.generation - right.generation);
	}
	const repliedByMessage = new Map<string, Extract<DurableLogRecord, { type: "actor_message"; kind: "replied" }>>();
	for (const record of records) {
		if (record.type === "actor_message" && record.kind === "replied") {
			repliedByMessage.set(`${record.occurrence}\u0000${record.messageId}`, record);
		}
	}
	const projectedActorDeclarations = new Set(projectedActors.map((actor) => actor.declaration));
	const projectedLogicalOccurrences = new Set(projectedActors.map((actor) => actor.logicalOccurrence));
	const actorPlacementForInternalState = (state: HyperchartStateInfo) => {
		const localState = state.actorInternal?.localState;
		return localState === undefined ? undefined : state.id.slice(0, -(localState.length + 1));
	};
	const runtimeStates = [...staticStates, ...materializedMapStates(staticRun.states, ast, projection, runtime)].filter(
		(state) => {
			if (!(!isUnmaterializedMapTemplateState(ast, state.id) || state.type === "actor-declaration" || state.actorInternal !== undefined)) return false;
			if (state.type === "actor-declaration") {
				if (projectedLogicalOccurrences.has(state.id)) return false;
				if (!state.id.includes("#") && projectedActorDeclarations.has(state.actorDeclaration?.declarationPath ?? state.id)) return false;
			}
			if (state.actorInternal !== undefined && state.actorInternal.occurrencePath === undefined) {
				const placement = actorPlacementForInternalState(state);
				if (placement !== undefined && projectedLogicalOccurrences.has(placement)) return false;
				if (!state.id.includes("#") && projectedActorDeclarations.has(state.actorInternal.declarationPath)) return false;
			}
			return true;
		});
	const latestProjectedActors = [...new Map(
		[...projectedActors]
			.sort((left, right) => left.generation - right.generation)
			.map((actor) => [actor.logicalOccurrence, actor]),
	).values()];
	const actorOccurrences: HyperchartActorOccurrenceInfo[] = latestProjectedActors.map((actor) => {
		const pending = Object.values(projection.pendingActorCalls).find((call) => call.occurrence === actor.occurrence);
		const pool = actor.definition.kind === "actorPool" ? actor as ProjectedActorPoolOccurrence : undefined;
		const ordinary = pool === undefined ? actor as ProjectedActorOccurrence : undefined;
		const currentMessages = pool === undefined
			? (ordinary?.currentMessage === undefined ? [] : [ordinary.currentMessage])
			: pool.workers.flatMap((worker) => worker.currentMessage === undefined ? [] : [worker.currentMessage]);
		// Pool messages are owned by concrete worker slots, never by the endpoint mailbox itself.
		const currentMessage = ordinary?.currentMessage;
		const messageInfo = (sourceActor: typeof actor, message: typeof actor.messages[number]) => {
			const replyFact = repliedByMessage.get(`${sourceActor.occurrence}\u0000${message.messageId}`);
			return {
				messageId: message.messageId,
				actorOccurrencePath: sourceActor.occurrence,
				actorLogicalPath: sourceActor.logicalOccurrence,
				actorGeneration: sourceActor.generation,
				event: message.event,
				input: message.input,
				producerVisit: `${message.producerState}:${message.producerVisit}`,
				...(message.callId === undefined ? {} : { callId: message.callId }),
				batchIndex: message.batchIndex,
				status: message.status,
				...(message.receiveState === undefined
					? {}
					: { receiveState: message.receiveState.replace(`${sourceActor.occurrence}.`, `${sourceActor.logicalOccurrence}.`) }),
				...(message.replyEvent === undefined ? {} : { replyEvent: message.replyEvent }),
				...(message.workerIndex === undefined ? {} : { workerIndex: message.workerIndex, workerOccurrencePath: actorPoolWorkerOccurrencePath(sourceActor.occurrence, message.workerIndex) }),
				...(message.replyOutput === undefined ? {} : { replyOutput: message.replyOutput }),
				...(replyFact?.schema === undefined ? {} : { replySchema: { schema: replyFact.schema.schema } }),
				...(replyFact?.schema === undefined ? {} : { validation: "valid" as const }),
			};
		};
		const actorGenerations = actorGenerationsByLogicalOccurrence.get(actor.logicalOccurrence) ?? [];
		const mailboxInstances = actorGenerations.map((candidate) => {
			const mailbox = {
				totalCount: candidate.mailbox.length,
				...(candidate.mailbox[0] === undefined ? {} : { head: messageInfo(candidate, candidate.mailbox[0]) }),
				entries: candidate.mailbox.map((message) => messageInfo(candidate, message)),
			};
			const messageHistory = candidate.messages
				.filter((message) => message.status === "settled" || message.status === "failed" || message.status === "cancelled")
				.map((message) => messageInfo(candidate, message));
			const candidateCurrent = candidate.definition.kind === "actorPool"
				? undefined
				: (candidate as ProjectedActorOccurrence).currentMessage;
			return {
				occurrencePath: candidate.occurrence,
				generation: candidate.generation,
				status: candidate.status,
				mailbox,
				messageHistory,
				...(candidateCurrent === undefined ? {} : { currentMessage: messageInfo(candidate, candidateCurrent) }),
			};
		});
		const messageHistory = mailboxInstances.flatMap((instance) => instance.messageHistory);
		const actorFailed = projection.failure !== undefined &&
			(projection.failure.origin === actor.occurrence || projection.failure.origin.startsWith(`${actor.occurrence}.`));
		const generationHistory: HyperchartVisitInfo[] = actorGenerations
			.map((candidate) => {
				const created = records.find((record): record is Extract<DurableLogRecord, { type: "actor_created" }> =>
					record.type === "actor_created" && record.occurrence === candidate.occurrence);
				const stopped = [...records].reverse().find((record): record is Extract<DurableLogRecord, { type: "actor_scope" }> =>
					record.type === "actor_scope" && record.kind === "stopped" && record.occurrence === candidate.occurrence);
				const visitStatus = candidate.status === "stopped"
					? "done" as const
					: candidate.status === "failed"
						? "failed" as const
						: candidate.status === "cancelled"
							? "cancelled" as const
							: "running" as const;
				return {
					visit: candidate.generation,
					invokeSeqId: created?.seqId ?? candidate.generation,
					startedAt: created?.timestamp ?? staticRun.createdAt,
					...(stopped === undefined ? {} : { endedAt: stopped.timestamp, endedReason: "scope_exit" as const }),
					status: visitStatus,
					...(visitStatus === "done" ? { completedEvent: "STOPPED" } : {}),
					inputs: { input: candidate.input },
					invocation: { kind: "actor" as const },
				};
			});
		const workers = pool?.workers.map((worker) => {
			const workerFacts = [...runtime.byState.entries()].filter(([statePath]) => statePath.startsWith(`${worker.occurrence}.`));
			const visitHistory = workerFacts.flatMap(([, facts]) => facts.visitHistory ?? []).sort((left, right) => left.startedAt - right.startedAt);
			const sessions = workerFacts.flatMap(([, facts]) => facts.session === undefined ? [] : [facts.session]).sort((left, right) => sessionActivity(left) - sessionActivity(right));
			const latestSession = sessions.at(-1);
			const results = Object.entries(projection.results).flatMap(([statePath, value]) => statePath.startsWith(`${worker.occurrence}.`) ? [{ state: statePath.slice(worker.occurrence.length + 1), value }] : []);
			const workerMessages = actor.messages
				.filter((message) => message.workerIndex === worker.index && message.messageId !== worker.currentMessage?.messageId)
				.map((message) => messageInfo(actor, message));
			return {
				index: worker.index,
				occurrencePath: worker.occurrence,
				currentState: worker.currentState,
				currentStateId: `${actorOccurrenceInspectorId(pool.logicalOccurrence)}.$worker.${worker.currentState}`,
				status: worker.status,
				...(worker.currentMessage === undefined ? {} : { currentMessage: messageInfo(actor, worker.currentMessage) }),
				...(workerMessages.length === 0 ? {} : { messageHistory: workerMessages }),
				...(visitHistory.length === 0 ? {} : { visits: visitHistory.length, visitHistory }),
				...(latestSession === undefined ? {} : { session: latestSession }),
				...(results.length === 0 ? {} : { results }),
			};
		});
		const batchCalls = Object.values(projection.pendingActorCalls).flatMap((call) => {
			if (call.kind !== "batch" || call.occurrence !== actor.occurrence) return [];
			const items = call.messageIds.flatMap((messageId) => {
				const message = actor.messages.find((candidate) => candidate.messageId === messageId);
				return message === undefined ? [] : [messageInfo(actor, message)];
			});
			const settled = items.filter((message) => message.status === "settled").length;
			return [{ callId: call.callId, callerState: call.callerState, status: call.status, messageIds: call.messageIds, items, settled, total: call.messageIds.length }];
		});
		return {
			kind: actor.definition.kind,
			declarationPath: actor.declaration,
			...(actor.owner === undefined ? {} : { ownerPath: actor.owner }),
			occurrencePath: actor.occurrence,
			logicalPath: actor.logicalOccurrence,
			generation: actor.generation,
			generationHistory,

			input: actor.input,
			status: actorFailed ? "failed" : actor.status,
			currentState: ordinary?.currentState ?? pool?.workers[0]?.currentState ?? "",
			...(pool === undefined ? {} : {
				concurrency: pool.definition.concurrency,
				activeCount: currentMessages.length,
				idleCount: pool.workers.filter((worker) => worker.currentMessage === undefined).length,
				workers: workers ?? [],
				...(batchCalls.length === 0 ? {} : { batchCalls }),
			}),
			mailbox: {
				totalCount: actor.mailbox.length,
				...(actor.mailbox[0] === undefined ? {} : { head: messageInfo(actor, actor.mailbox[0]) }),
				entries: actor.mailbox.map((message) => messageInfo(actor, message)),
			},
			mailboxInstances,
			...(messageHistory.length === 0 ? {} : { messageHistory }),
			...(currentMessage === undefined ? {} : { currentMessage: messageInfo(actor, currentMessage) }),
			...(pending === undefined || projection.failure !== undefined ? {} : { pendingCaller: { callId: pending.callId, state: pending.callerState, waitReason: pending.status === "enqueued" ? "accept" as const : "reply" as const } }),
			...(actor.status === "closing" || actor.status === "draining" ? { drain: { queued: actor.mailbox.length, current: currentMessages.length, settled: actor.messages.filter((message) => message.status === "settled").length } } : {}),
		};
	});
	const actorOccurrenceStates: HyperchartStateInfo[] = actorOccurrences.map((occurrence) => {
		const declaration = staticRun.actorDeclarations?.find((actor) => actor.declarationPath === occurrence.declarationPath);
		return {
			id: actorOccurrenceInspectorId(occurrence.logicalPath ?? occurrence.occurrencePath),
			...(occurrence.ownerPath === undefined ? {} : { scopeParentId: occurrence.ownerPath }),
			...(declaration?.definitionSource === undefined ? {} : { definitionSource: declaration.definitionSource }),
			type: "actor-occurrence",
			status: occurrence.status === "failed" || occurrence.status === "cancelled" ? "failed" : occurrence.status === "stopped" ? "done" : occurrence.status === "idle" ? "waiting" : "running",
			...(declaration === undefined ? {} : { actorDeclaration: declaration }),
			actorOccurrence: occurrence,
		};
	});
	const actorOwnerStates: HyperchartStateInfo[] = [...new Set(actorOccurrences.flatMap((occurrence) => occurrence.ownerPath === undefined ? [] : [occurrence.ownerPath]))]
		.filter((owner) => !runtimeStates.some((state) => state.id === owner))
		.map((owner) => ({
			id: owner,
			scopeParentId: stripLastKey(owner),
			type: "compound" as const,
			status: [...Object.values(projection.actors), ...Object.values(projection.actorPools)]
				.some((actor) => actor.owner === owner && actor.status !== "stopped") ? "running" as const : "done" as const,
		}));
	const actorInternalStates = actorOccurrences.flatMap((occurrence) => {
		const templateStates = staticRun.states.filter((state) => state.actorInternal?.declarationPath === occurrence.declarationPath && state.actorInternal.occurrencePath === undefined);
		const occurrenceId = actorOccurrenceInspectorId(occurrence.logicalPath ?? occurrence.occurrencePath);
		const actorGenerations = actorGenerationsByLogicalOccurrence.get(occurrence.logicalPath ?? occurrence.occurrencePath) ?? [];
		return templateStates.map((templateState) => {
			const localState = templateState.actorInternal!.localState;
			const internalLocalPath = occurrence.kind === "actorPool" ? `$worker.${localState}` : localState;
			const materializeTarget = (target: string) => {
				const prefix = `${occurrence.declarationPath}.`;
				return target.startsWith(prefix) ? `${occurrenceId}.${target.slice(prefix.length)}` : target;
			};
			const materializeGeneration = (candidate: (typeof actorGenerations)[number]) => overlayRuntimeState({
				...templateState,
				id: `${occurrenceId}.${internalLocalPath}`,
				scopeParentId: occurrenceId,
				runtimeStatePath: `${candidate.occurrence}.${internalLocalPath}`,
				actorInternal: {
					...templateState.actorInternal!,
					occurrencePath: candidate.occurrence,
					logicalOccurrencePath: candidate.logicalOccurrence,
					generation: candidate.generation,
				},
				initial: localState === (staticRun.actorDeclarations?.find((actor) => actor.declarationPath === occurrence.declarationPath)?.initialReceive ?? ""),
				status: "pending",
				...(templateState.transitions === undefined ? {} : { transitions: templateState.transitions.map((transition) => ({ ...transition, target: materializeTarget(transition.target) })) }),
			}, ast, projection, runtime);
			const generationStates = actorGenerations.map((candidate) => ({ candidate, state: materializeGeneration(candidate) }));
			const latest = generationStates.at(-1);
			if (latest === undefined) return templateState;
			return {
				...latest.state,
				actorInternal: {
					...latest.state.actorInternal!,
					generations: generationStates.map(({ candidate, state }) => ({
						occurrencePath: candidate.occurrence,
						logicalPath: candidate.logicalOccurrence,
						generation: candidate.generation,
						actorStatus: candidate.status,
						stateStatus: state.status,
						...(state.visitHistory === undefined ? {} : { visitHistory: state.visitHistory }),
						...(state.actorMessageHistory === undefined ? {} : { actorMessageHistory: state.actorMessageHistory }),
						...(state.actorMessageLink?.messages === undefined ? {} : { actorMessages: state.actorMessageLink.messages }),
					})),
				},
				...((latest.state.type === "receive" || latest.state.type === "reply") && latest.state.actorMessageHistory === undefined
					? { actorMessageHistory: [] }
					: {}),
			};
		});
	});
	const actorLinkedRuntimeStates = runtimeStates.map((state) => {
		const link = state.actorMessageLink;
		if (link === undefined) return state;
		const logicalTarget = actorTargetForInspectorState(state.id, link.to, actorOccurrences);
		return logicalTarget === undefined ? state : { ...state, actorMessageLink: { ...link, to: logicalTarget } };
	});
	// Map materialization already expands static actor workflow templates, while
	// the actor projection above materializes the same logical workflow with
	// generation-aware runtime data. Keep the latter and collapse re-entry
	// generations to one Inspector state per logical id.
	const actorInternalById = new Map(actorInternalStates.map((state) => [state.id, state]));
	const materializedActorInternalIds = new Set(actorInternalById.keys());
	const states = markStaleRuntimeStates([
		...actorLinkedRuntimeStates.filter((state) => !materializedActorInternalIds.has(state.id)),
		...actorOwnerStates,
		...actorOccurrenceStates,
		...actorInternalById.values(),
	], ast, projection, runtime);
	const statusIssues = runIssues(options.status);
	const issues = [
		...statusIssues,
		...(projection.failure === undefined || statusIssues.some((issue) => issue.kind === "run_failed")
			? []
			: [{ severity: "error" as const, kind: "run_failed" as const, source: "durable_log" as const, message: typeof projection.failure.error === "string" ? projection.failure.error : JSON.stringify(projection.failure.error), stateId: projection.failure.origin, seqId: projection.failure.seqId }]),
	];
	return {
		...staticRun,
		mode: "run",
		status: projection.failure === undefined ? runtimeRunStatus(options.status?.state, states) : "failed",
		...(options.status?.pid === undefined ? {} : { pid: options.status.pid }),
		detached: options.status?.state === "stopped",
		states,
		stateCount: states.length,
		...(staticRun.actorDeclarations === undefined ? {} : { actorDeclarations: staticRun.actorDeclarations }),
		...(actorOccurrences.length === 0 ? {} : { actorOccurrences }),
		...(issues.length === 0 ? {} : { issues }),
	};
}

function stateFromInspectState(state: HyperchartInspectState): HyperchartStateInfo {
	const refs = refsInfo(state.refs);
	const inputs = state.inputs?.map(
		(input): HyperchartInputInfo => ({
			name: input.name,
			required: input.required,
			defaulted: !input.required,
			schema: { schema: input.schema },
			...(input.defaultValue === undefined ? {} : { preview: JSON.stringify(input.defaultValue) }),
		}),
	);
	return {
		id: state.id,
		...(state.scopeParentId === undefined ? {} : { scopeParentId: state.scopeParentId }),
		...(state.runtimeStatePath === undefined ? {} : { runtimeStatePath: state.runtimeStatePath }),
		...(state.actorInternal === undefined ? {} : { actorInternal: state.actorInternal }),
		status: "pending",
		type: inspectStateKindToStateType(state.kind),
		...(state.initial === true ? { initial: true } : {}),
		...(state.definitionSource === undefined ? {} : { definitionSource: state.definitionSource }),
		...(state.kind === "final" ? { final: true } : {}),
		...(state.agent === undefined ? {} : { agent: state.agent }),
		...(state.description === undefined ? {} : { agentDescription: state.description }),
		...(state.role === undefined ? {} : { role: state.role }),
		...(state.model === undefined ? {} : { model: state.model }),
		...(state.resolvedModel === undefined ? {} : { resolvedModel: state.resolvedModel }),
		...(state.thinking === undefined ? {} : { thinking: state.thinking }),
		...(state.toolset === undefined ? {} : { toolset: state.toolset }),
		...(state.tools === undefined ? {} : { tools: [...state.tools] }),
		...(state.resolvedTools === undefined ? {} : { resolvedTools: [...state.resolvedTools] }),
		...(state.agentDefinitionUnavailable === true ? { agentDefinitionUnavailable: true } : {}),
		...(state.task === undefined
			? {}
			: {
					taskPreview: previewText(state.task),
					...(state.kind === "agent" || state.kind === "user" ? { taskPrompt: state.task } : {}),
				}),
		...(state.command === undefined ? {} : { commandPreview: state.command }),
		...(state.env === undefined
			? {}
			: {
					env: state.env.map((env) => ({
						name: env.name,
						type: env.type,
						...(env.value === undefined ? {} : { value: env.value }),
						...(env.schema === undefined ? {} : { schema: { schema: env.schema } }),
					})),
				}),
		...(state.reads === undefined ? {} : { reads: state.reads }),
		...(state.readArtifacts === undefined ? {} : { readArtifacts: state.readArtifacts.map((artifact) => ({
			name: artifact.name,
			...(artifact.path === undefined ? {} : { path: artifact.path }),
			...(artifact.shape === undefined ? {} : { schema: { schema: artifact.shape } }),
			...(artifact.sourceState === undefined ? {} : { sourceState: artifact.sourceState }),
			...(artifact.readKind === undefined ? {} : { readKind: artifact.readKind }),
		})) }),
		...(state.transitions === undefined ? {} : { transitions: state.transitions }),
		...(inputs === undefined ? {} : { inputs }),
		...(refs === undefined ? {} : { refs }),
		...(state.onReenter === undefined
			? {}
			: {
					onReenter:
						state.onReenter.mode === "restart"
							? { mode: "restart" as const }
							: {
									mode: "resume" as const,
									...(state.onReenter.message === undefined
										? {}
										: { messagePreview: previewText(state.onReenter.message) }),
									...(refsInfo(state.onReenter.refs) === undefined ? {} : { refs: refsInfo(state.onReenter.refs) }),
								},
				}),
		...(state.artifacts === undefined
			? {}
			: {
					artifacts: state.artifacts.map((artifact) => ({
						name: artifact.name,
						...(artifact.path === undefined ? {} : { path: artifact.path }),
						...(artifact.shape === undefined ? {} : { schema: { schema: artifact.shape } }),
					})),
				}),
		...(state.reply === undefined ? {} : { replySchema: { schema: state.reply } }),
		...(state.guard === undefined ? {} : { guard: guardInfo(state.guard) }),
		...(state.onReject === undefined ? {} : { onReject: state.onReject }),
		...(state.over === undefined && state.overSchema === undefined
			? {}
			: {
					mapConfig: {
						...(state.over === undefined ? {} : { over: state.over }),
						...(state.overSchema === undefined ? {} : { overSchema: { schema: state.overSchema } }),
					},
				}),
		...(state.concurrency === undefined ? {} : { concurrency: state.concurrency }),
		...(state.regions === undefined && state.branches === undefined
			? {}
			: { parallelConfig: inspectParallelConfig(state) }),
		...(state.retries === undefined ? {} : { retry: { max: state.retries } }),
		...(state.actorMessageDefinition === undefined
			? {}
			: {
					actorMessageDefinition: {
						kind: state.actorMessageDefinition.kind,
						...(state.actorMessageDefinition.to === undefined ? {} : { to: state.actorMessageDefinition.to }),
						...(state.actorMessageDefinition.resolvedTo === undefined ? {} : { resolvedTo: state.actorMessageDefinition.resolvedTo }),
						...(state.actorMessageDefinition.targetKind === undefined ? {} : { targetKind: state.actorMessageDefinition.targetKind }),
						...(state.actorMessageDefinition.event === undefined ? {} : { event: state.actorMessageDefinition.event }),
						...(state.actorMessageDefinition.target === undefined ? {} : { target: state.actorMessageDefinition.target }),
						...(state.actorMessageDefinition.payload === undefined
							? {}
							: {
									payload: {
										label: state.actorMessageDefinition.payload.label,
										source: state.actorMessageDefinition.payload.source,
										...(state.actorMessageDefinition.payload.schema === undefined ? {} : { schema: { schema: state.actorMessageDefinition.payload.schema } }),
									},
								}),
						...(state.actorMessageDefinition.contracts === undefined ? {} : { contracts: state.actorMessageDefinition.contracts.map(actorMessageContractInfo) }),
					},
				}),
		...(state.actorMessageLink === undefined ? {} : { actorMessageLink: state.actorMessageLink }),
		...(state.finalConfig === undefined
			? {}
			: {
					finalConfig: {
						outcome: state.finalConfig.outcome,
						...(state.finalConfig.notify === undefined
							? {}
							: {
									notify: {
										...(state.finalConfig.notify.prompt === undefined ? {} : { prompt: state.finalConfig.notify.prompt }),
										...(state.finalConfig.notify.scope === undefined ? {} : { scope: state.finalConfig.notify.scope }),
										...(state.finalConfig.notify.artifacts === undefined
											? {}
											: {
													artifacts: state.finalConfig.notify.artifacts.map((artifact) => ({
														name: artifact.name,
														...(artifact.path === undefined ? {} : { path: artifact.path }),
														...(artifact.shape === undefined ? {} : { schema: { schema: artifact.shape } }),
														...(artifact.sourceState === undefined ? {} : { sourceState: artifact.sourceState }),
														...(artifact.readKind === undefined ? {} : { readKind: artifact.readKind }),
													})),
												}),
									},
								}),
					},
				}),
	} as HyperchartStateInfo;
}

type StateRuntimeFacts = {
	invokedAt?: number;
	completedAt?: number;
	completedEvent?: ChartEvent;
	validatedAt?: number;
	validationAttempts?: number;
	latestRejectedReason?: string;
	attempts?: number;
	visits?: number;
	visitHistory?: HyperchartVisitInfo[];
	session?: HyperchartAgentSessionInfo;
	actorMessages?: HyperchartActorSentMessageInfo[];
	actorMessageHistory?: HyperchartActorMessageInfo[];
};

type RuntimeFacts = {
	byState: Map<StatePath, StateRuntimeFacts>;
	pendingByState: Map<StatePath, PendingAction>;
	waitingLeaves: ReadonlySet<StatePath>;
	issuesByState: Map<StatePath, HyperchartIssueInfo[]>;
	mapVisitHistoryByState: Map<StatePath, HyperchartMapVisitInfo[]>;
	actorOwnerVisits: Map<StatePath, Array<{ generation: number; seqId: number }>>;
};

function markStaleRuntimeStates(
	states: HyperchartStateInfo[],
	ast: ChartAst,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
): HyperchartStateInfo[] {
	const byId = new Map(states.map((state) => [state.id, state]));
	const controlEdges = runtimeControlEdges(states, ast);
	const dominators = runtimeDominators(states, controlEdges, ast.initial);
	const staleIds = new Set<string>();
	for (const source of states) {
		const sourceSeqId = latestReentrySeqId(source, runtime);
		if (sourceSeqId === undefined) continue;
		const queue = [...(controlEdges.get(source.id) ?? [])];
		const visited = new Set<string>([source.id]);
		while (queue.length > 0) {
			const stateId = queue.shift();
			if (stateId === undefined || visited.has(stateId)) continue;
			visited.add(stateId);
			const candidate = byId.get(stateId);
			if (candidate === undefined) continue;
			// A feedback cycle may reach an earlier dominator again. Stop at that loop header instead
			// of walking into a new conceptual iteration and invalidating predecessors or sibling fan-out work.
			if (dominators.get(source.id)?.has(candidate.id)) continue;
			const candidateSeqId = latestStateVisitSeqId(candidate, runtime);
			if (candidate.status === "done" && candidateSeqId !== undefined && candidateSeqId < sourceSeqId) {
				staleIds.add(candidate.id);
			}
			for (const target of controlEdges.get(candidate.id) ?? []) queue.push(target);
		}
	}
	// A repeatedly entered actor-owning scope is historical once execution has
	// advanced to a later live state outside that scope. Containers have no
	// action invocation of their own, so actor creation facts provide their
	// durable visit coordinates for the normal stale presentation.
	for (const [ownerPath, visits] of runtime.actorOwnerVisits) {
		if (visits.length < 2) continue;
		const owner = byId.get(ownerPath);
		const latestOwnerSeqId = visits.at(-1)?.seqId;
		if (owner?.status !== "done" || latestOwnerSeqId === undefined) continue;
		const advancedOutside = states.some((candidate) => {
			if (candidate.status !== "running" && candidate.status !== "waiting") return false;
			if (candidate.id === ownerPath || underScope(candidate.id, ownerPath)) return false;
			const candidateSeqId = latestStateVisitSeqId(candidate, runtime);
			return candidateSeqId !== undefined && candidateSeqId > latestOwnerSeqId;
		});
		if (advancedOutside) staleIds.add(ownerPath);
	}
	for (const mapState of states) {
		const currentVisit = mapState.mapConfig?.visitHistory?.at(-1);
		if (currentVisit === undefined) continue;
		for (const key of Object.keys(currentVisit.instances)) {
			const instanceScope = `${mapState.id}#${key}`;
			for (const candidate of states) {
				const candidateSeqId = latestStateVisitSeqId(candidate, runtime);
				if (
					underScope(candidate.id, instanceScope) &&
					candidateSeqId !== undefined &&
					candidateSeqId > currentVisit.spawnSeqId
				) {
					staleIds.delete(candidate.id);
				}
			}
		}
	}
	for (const predecessor of states) {
		if (!staleIds.has(predecessor.id) || predecessor.completedEvent === undefined) continue;
		const target = predecessor.transitions?.find((transition) => transition.event === predecessor.completedEvent)?.target;
		if (target !== undefined && byId.get(target)?.type === "final") staleIds.add(target);
	}
	for (const stateId of [...staleIds]) {
		if (closedByCompletedAncestor(stateId, ast, projection, runtime)) staleIds.delete(stateId);
	}
	let addedContainer = true;
	while (addedContainer) {
		addedContainer = false;
		for (const state of states) {
			if (state.status !== "done" || staleIds.has(state.id)) continue;
			if (state.type !== "map" && state.type !== "parallel" && state.type !== "compound" && state.type !== "region")
				continue;
			if (completedScopeIsClosed(state.id, ast, projection, runtime)) continue;
			if ([...staleIds].some((stateId) => stateId.startsWith(`${state.id}.`) || stateId.startsWith(`${state.id}#`))) {
				staleIds.add(state.id);
				addedContainer = true;
			}
		}
	}
	// Once an exited container is historical, its completed children belong to
	// that same historical visit rather than remaining green in the open scope.
	for (const staleId of [...staleIds]) {
		const staleState = byId.get(staleId);
		if (staleState?.type !== "map" && staleState?.type !== "parallel" && staleState?.type !== "compound" && staleState?.type !== "region") continue;
		for (const candidate of states) {
			if (candidate.status === "done" && underScope(candidate.id, staleId)) staleIds.add(candidate.id);
		}
	}
	return states.map((state) => {
		const isStale = staleIds.has(state.id);
		const mapItemsWithStale = state.mapConfig?.items?.map((item) => {
			if (
				item.status !== "done" ||
				item.state === undefined ||
				![...staleIds].some((stateId) => stateId === item.state || stateId.startsWith(`${item.state}.`))
			)
				return item;
			return { ...item, status: "stale" as const };
		});
		let subProgress = state.subProgress;
		if (state.type === "map" && mapItemsWithStale !== undefined) {
			const progressItems = currentMapItems(state.id, mapItemsWithStale, projection);
			const done = progressItems.filter((item) => item.status === "done").length;
			const waiting = progressItems.filter((item) => item.status === "waiting").length;
			const running = progressItems.filter((item) => item.status === "running").length;
			const failed = progressItems.filter((item) => item.status === "failed").length;
			const stale = progressItems.filter((item) => item.status === "stale").length;
			subProgress = {
				done,
				running,
				failed,
				total: progressItems.length,
				...(waiting === 0 ? {} : { waiting }),
				...(stale === 0 ? {} : { stale }),
			};
		} else if (state.type === "parallel" && state.subProgress !== undefined) {
			const stale =
				state.parallelConfig?.branches?.filter((branch) => {
					if (branch.id === undefined) return false;
					const branchStates = states.filter(
						(candidate) => candidate.id === branch.id || candidate.id.startsWith(`${branch.id}.`),
					);
					const hasCurrentWork = branchStates.some(
						(candidate) =>
							candidate.status === "waiting" || candidate.status === "running" || candidate.status === "failed",
					);
					return !hasCurrentWork && branchStates.some((candidate) => staleIds.has(candidate.id));
				}).length ?? 0;
			if (stale > 0) {
				subProgress = {
					...state.subProgress,
					done: Math.max(0, state.subProgress.done - stale),
					stale,
				};
			}
		}
		return {
			...state,
			...(isStale ? { status: "stale" as const } : {}),
			...(mapItemsWithStale === undefined ? {} : { mapConfig: { ...state.mapConfig, items: mapItemsWithStale } }),
			...(subProgress === undefined ? {} : { subProgress }),
			...(isStale && state.transitions !== undefined
				? {
						transitions: state.transitions.map(({ taken: _taken, ...transition }) => transition),
					}
				: {}),
		};
	});
}

function latestStateVisitSeqId(state: HyperchartStateInfo, runtime: RuntimeFacts): number | undefined {
	return state.visitHistory?.at(-1)?.invokeSeqId
		?? state.mapConfig?.visitHistory?.at(-1)?.spawnSeqId
		?? runtime.actorOwnerVisits.get(state.id)?.at(-1)?.seqId;
}

function latestReentrySeqId(state: HyperchartStateInfo, runtime: RuntimeFacts): number | undefined {
	if ((state.visitHistory?.length ?? 0) >= 2) return state.visitHistory?.at(-1)?.invokeSeqId;
	if ((state.mapConfig?.visitHistory?.length ?? 0) >= 2) return state.mapConfig?.visitHistory?.at(-1)?.spawnSeqId;
	const actorVisits = runtime.actorOwnerVisits.get(state.id);
	if ((actorVisits?.length ?? 0) >= 2) return actorVisits?.at(-1)?.seqId;
	return undefined;
}

function runtimeControlEdges(
	states: readonly HyperchartStateInfo[],
	ast: ChartAst,
): Map<string, Set<string>> {
	const runtimeStates = states.filter((state) => !isUnmaterializedMapTemplateState(ast, state.id));
	const byId = new Set(runtimeStates.map((state) => state.id));
	const edges = new Map<string, Set<string>>();
	const add = (source: string, target: string) => {
		if (source === target || !byId.has(target)) return;
		const targets = edges.get(source) ?? new Set<string>();
		targets.add(target);
		edges.set(source, targets);
	};
	for (const state of runtimeStates) {
		for (const transition of state.transitions ?? []) add(state.id, transition.target);
		const node = nodeAt(ast, state.id);
		if (node?.kind === "compound" || node?.kind === "region") {
			add(state.id, `${state.id}.${node.initial}`);
		} else if (node?.kind === "map") {
			for (const candidate of states) {
				if (
					parentPath(candidate.id)?.startsWith(`${state.id}#`) &&
					templatePath(candidate.id) === `${templatePath(state.id)}.${node.initial}`
				) {
					add(state.id, candidate.id);
				}
			}
		} else if (node?.kind === "parallel") {
			for (const region of node.regions) add(state.id, `${state.id}.${region}`);
		}
		if (state.type === "final") {
			const containerPath = parentPath(state.id);
			const container = containerPath === undefined ? undefined : nodeAt(ast, containerPath);
			if (containerPath !== undefined && (container?.kind === "compound" || container?.kind === "map")) {
				add(state.id, siblingPath(containerPath, container.onDone));
			} else if (containerPath !== undefined && container?.kind === "region") {
				const parallelPath = parentPath(containerPath);
				const parallel = parallelPath === undefined ? undefined : nodeAt(ast, parallelPath);
				if (parallelPath !== undefined && parallel?.kind === "parallel") {
					add(state.id, siblingPath(parallelPath, parallel.onDone));
				}
			}
		}
	}
	return edges;
}

function isUnmaterializedMapTemplateState(ast: ChartAst, statePath: StatePath): boolean {
	if (statePath.includes("#")) return false;
	let scope = parentPath(statePath);
	while (scope !== undefined) {
		if (nodeAt(ast, scope)?.kind === "map") return true;
		scope = parentPath(scope);
	}
	return false;
}

function runtimeDominators(
	states: readonly HyperchartStateInfo[],
	edges: ReadonlyMap<string, ReadonlySet<string>>,
	initial: StatePath,
): Map<string, Set<string>> {
	const start = "<runtime-start>";
	const nodes = states.map((state) => state.id);
	const nodeSet = new Set(nodes);
	const reachable = new Set<string>();
	const queue = nodeSet.has(initial) ? [initial] : [];
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined || reachable.has(current)) continue;
		reachable.add(current);
		for (const target of edges.get(current) ?? []) queue.push(target);
	}
	const entryTargets = new Set<string>([
		...(nodeSet.has(initial) ? [initial] : []),
		...nodes.filter((node) => !reachable.has(node)),
	]);
	const predecessors = new Map<string, Set<string>>(nodes.map((node) => [node, new Set()]));
	for (const [source, targets] of edges) {
		for (const target of targets) predecessors.get(target)?.add(source);
	}
	for (const target of entryTargets) predecessors.get(target)?.add(start);
	const universe = new Set([start, ...nodes]);
	const dominators = new Map<string, Set<string>>([[start, new Set([start])]]);
	for (const node of nodes) dominators.set(node, new Set(universe));
	let changed = true;
	while (changed) {
		changed = false;
		for (const node of nodes) {
			const preds = [...(predecessors.get(node) ?? [])];
			let next = new Set<string>([node]);
			if (preds.length > 0) {
				const intersection = new Set(dominators.get(preds[0] ?? start) ?? []);
				for (const pred of preds.slice(1)) {
					for (const candidate of intersection) {
						if (!dominators.get(pred)?.has(candidate)) intersection.delete(candidate);
					}
				}
				next = new Set([node, ...intersection]);
			}
			const previous = dominators.get(node) ?? new Set();
			if (next.size !== previous.size || [...next].some((value) => !previous.has(value))) {
				dominators.set(node, next);
				changed = true;
			}
		}
	}
	return dominators;
}

function runtimeRunStatus(value: string | undefined, states: readonly HyperchartStateInfo[] = []): HyperchartRunStatus {
	if (value === "complete") return "completed";
	if (value === "failed") return "failed";
	if (value === "stopped" || value === "stopping") return "paused";
	if (value === "running" || value === "starting") {
		if (states.some((state) => state.status === "running")) return "running";
		if (states.some((state) => state.status === "waiting")) return "blocked";
		return "running";
	}
	if (states.some((state) => state.status === "failed")) return "failed";
	if (states.some((state) => state.status === "running")) return "running";
	if (states.length > 0 && states.every((state) => state.status === "done" || state.status === "skipped"))
		return "completed";
	return "paused";
}

function firstTimestamp(records: readonly DurableLogRecord[]): number | undefined {
	return records.find((record) => typeof record.timestamp === "number")?.timestamp;
}

function lastTimestamp(records: readonly DurableLogRecord[]): number | undefined {
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index];
		if (record !== undefined && typeof record.timestamp === "number") return record.timestamp;
	}
	return undefined;
}

function runtimeFacts(
	ast: ChartAst,
	records: readonly DurableLogRecord[],
	projection: ReturnType<typeof createBranchProjection>,
	skipped: readonly ProjectionSkippedRecord[],
	sessionProgress: HyperchartRuntimeSessionProgressFile | undefined,
): RuntimeFacts {
	const byState = new Map<StatePath, StateRuntimeFacts>();
	const pendingByState = new Map<StatePath, PendingAction>();
	const issuesByState = new Map<StatePath, HyperchartIssueInfo[]>();
	const actorOwnerVisits = new Map<StatePath, Array<{ generation: number; seqId: number }>>();
	const skippedRecords = new Set(skipped.map((entry) => entry.record));
	for (const [stateId, history] of actorInternalMessageHistories(ast, records, projection, skippedRecords)) {
		const facts = byState.get(stateId) ?? {};
		facts.actorMessageHistory = history;
		byState.set(stateId, facts);
	}
	for (const pending of projection.pendingActions) pendingByState.set(pending.actionUid.state, pending);
	for (const record of records) {
		if (record.type === "actor_created" && record.owner !== undefined && !skippedRecords.has(record)) {
			const visits = actorOwnerVisits.get(record.owner) ?? [];
			const existing = visits.find((visit) => visit.generation === record.generation);
			if (existing === undefined) visits.push({ generation: record.generation, seqId: record.seqId });
			else existing.seqId = Math.max(existing.seqId, record.seqId);
			actorOwnerVisits.set(record.owner, visits);
			continue;
		}
		if (record.type === "actor_message" && record.kind === "accepted" && !skippedRecords.has(record)) {
			const message = projectedActorEndpoint(projection, record.occurrence)?.messages.find((candidate) => candidate.messageId === record.messageId);
			const facts = byState.get(record.receiveState) ?? {};
			facts.invokedAt ??= record.timestamp;
			facts.completedAt = record.timestamp;
			facts.completedEvent = { type: message?.event ?? "ACCEPTED" };
			facts.attempts = (facts.attempts ?? 0) + 1;
			byState.set(record.receiveState, facts);
			continue;
		}
		if (record.type === "actor_messages_enqueued" && !skippedRecords.has(record)) {
			const stateId = record.source.producerState;
			const facts = byState.get(stateId) ?? {};
			const actor = projectedActorEndpoint(projection, record.occurrence);
			facts.actorMessages = [
				...(facts.actorMessages ?? []),
				...record.messages.map((message) => ({
					messageId: message.messageId,
					producerVisit: message.producerVisit,
					batchIndex: message.batchIndex,
					input: message.input,
					status: actor?.messages.find((candidate) => candidate.messageId === message.messageId)?.status ?? "queued",
					targetOccurrencePath: record.occurrence,
					targetLogicalPath: actor?.logicalOccurrence ?? record.occurrence,
					targetGeneration: record.generation,
				})),
			];
			if (record.source.kind === "send" || record.source.kind === "sendBatch") {
				facts.invokedAt ??= record.timestamp;
				facts.completedAt = record.timestamp;
				facts.completedEvent = { type: "ENQUEUED" };
				facts.attempts = (facts.attempts ?? 0) + 1;
			}
			byState.set(stateId, facts);
			continue;
		}
		if (record.type === "failure_intent") {
			const stateId = record.origin;
			const facts = byState.get(stateId) ?? {};
			facts.completedAt = record.timestamp;
			facts.completedEvent = { type: "FAILED", error: record.error };
			appendIssue(issuesByState, stateId, failedActionIssue(stateId, { type: "FAILED", error: record.error }, record.seqId, record.timestamp));
			byState.set(stateId, facts);
			continue;
		}
		if (record.type !== "state_action" || skippedRecords.has(record)) continue;
		const stateId = record.actionUid.state;
		const facts = byState.get(stateId) ?? {};
		if (record.kind === "invoke") {
			facts.invokedAt = record.timestamp;
			facts.attempts = (facts.attempts ?? 0) + 1;
			delete facts.completedAt;
			delete facts.completedEvent;
			delete facts.validatedAt;
			delete facts.validationAttempts;
			delete facts.latestRejectedReason;
		}
		if (record.kind === "complete") {
			const state = nodeAt(ast, stateId);
			const requiresValidation =
				state?.kind === "state" && state.validate !== undefined && record.event.type !== "FAILED";
			if (!requiresValidation) {
				facts.completedAt = record.timestamp;
				facts.completedEvent = record.event;
			}
			if (record.event.type === "FAILED") {
				appendIssue(issuesByState, stateId, failedActionIssue(stateId, record.event, record.seqId, record.timestamp));
			}
		}
		if (record.kind === "validated") {
			facts.validatedAt = record.timestamp;
			facts.validationAttempts = (facts.validationAttempts ?? 0) + 1;
			const rejectionReason = validationRejectionReason(record.outcome);
			if (rejectionReason === undefined) {
				facts.completedAt = record.timestamp;
				facts.completedEvent = record.event;
			} else {
				facts.latestRejectedReason = rejectionReason;
				appendIssue(issuesByState, stateId, {
					severity: "warning",
					kind: "validation_rejected",
					message: rejectionReason,
					source: "durable_log",
					stateId,
					seqId: record.seqId,
					timestamp: record.timestamp,
					payload: record.outcome,
				});
			}
		}
		byState.set(stateId, facts);
	}
	for (const [path, state] of Object.entries(ast.states)) {
		if (state.kind !== "state") continue;
		const key = actionUidKey({ ...state.action.uid, state: path });
		const visits = projection.stateVisits[key];
		if (visits === undefined) continue;
		const facts = byState.get(path) ?? {};
		facts.visits = visits;
		byState.set(path, facts);
	}
	for (const [stateId, visitHistory] of runtimeVisitHistories(ast, records, skippedRecords)) {
		const facts = byState.get(stateId) ?? {};
		facts.visitHistory = visitHistory;
		facts.visits = visitHistory.length;
		byState.set(stateId, facts);
	}
	const mapVisitHistoryByState = runtimeMapVisitHistories(records, skippedRecords);
	const waitingLeaves = concurrencyBlockedActionLeaves(ast, projection);
	appendSessionFacts(byState, sessionProgress);
	appendSessionIssues(issuesByState, sessionProgress);
	return { byState, pendingByState, waitingLeaves, issuesByState, mapVisitHistoryByState, actorOwnerVisits };
}

function actorInternalMessageHistories(
	ast: ChartAst,
	records: readonly DurableLogRecord[],
	finalProjection: ReturnType<typeof createBranchProjection>,
	skippedRecords: ReadonlySet<DurableLogRecord>,
): Map<StatePath, HyperchartActorMessageInfo[]> {
	const histories = new Map<StatePath, HyperchartActorMessageInfo[]>();
	const replay = createBranchProjection(ast);
	const acceptedAt = new Map<string, number>();
	const keyFor = (occurrence: string, messageId: string) => `${occurrence}\u0000${messageId}`;
	const append = (statePath: StatePath, message: HyperchartActorMessageInfo) => {
		histories.set(statePath, [...(histories.get(statePath) ?? []), message]);
	};
	for (const record of records) {
		if (skippedRecords.has(record)) continue;
		if (record.type === "actor_message" && record.kind === "accepted") {
			const actor = projectedActorEndpoint(replay, record.occurrence);
			const envelope = actor?.mailbox[0];
			if (actor !== undefined && envelope?.messageId === record.messageId) {
				const localState = record.receiveState.slice(record.occurrence.length + 1);
				const logicalReceiveState = `${actor.logicalOccurrence}.${localState}`;
				acceptedAt.set(keyFor(record.occurrence, record.messageId), record.timestamp);
				append(record.receiveState, {
					messageId: envelope.messageId,
					actorOccurrencePath: actor.occurrence,
					actorLogicalPath: actor.logicalOccurrence,
					actorGeneration: actor.generation,
					event: envelope.event,
					input: envelope.input,
					producerVisit: `${envelope.producerState}:${envelope.producerVisit}`,
					...(envelope.callId === undefined ? {} : { callId: envelope.callId }),
					...(record.workerIndex === undefined ? {} : { workerIndex: record.workerIndex, workerOccurrencePath: actorPoolWorkerOccurrencePath(actor.occurrence, record.workerIndex) }),
					status: "accepted",
					receiveState: logicalReceiveState,
					acceptedAt: record.timestamp,
				});
			}
		}
		if (record.type === "actor_message" && record.kind === "replied") {
			const actor = projectedActorEndpoint(replay, record.occurrence);
			const worker = actor?.definition.kind === "actorPool" && record.workerIndex !== undefined ? (actor as ProjectedActorPoolOccurrence).workers[record.workerIndex] : undefined;
			const ordinary = actor?.definition.kind === "actor" ? actor as ProjectedActorOccurrence : undefined;
			const envelope = worker?.currentMessage ?? ordinary?.currentMessage;
			const currentState = worker?.currentState ?? ordinary?.currentState;
			const declaration = actor === undefined ? undefined : ast.actors[actor.declaration];
			const reply = currentState === undefined || declaration === undefined ? undefined : actorDefinitionForEndpoint(declaration).states[currentState];
			// The reply state is deliberately read from the sequential projection immediately
			// before applying the replied fact. Event names are not unique actor-state identity.
			if (actor !== undefined && currentState !== undefined && envelope?.messageId === record.messageId && reply?.kind === "reply") {
				const executableOccurrence = worker?.occurrence ?? actor.occurrence;
				const historyState = `${executableOccurrence}.${currentState}`;
				const replyState = `${actor.logicalOccurrence}${worker === undefined ? "" : `.$worker-${worker.index}`}.${currentState}`;
				const messageAcceptedAt = acceptedAt.get(keyFor(record.occurrence, record.messageId));
				append(historyState, {
					messageId: envelope.messageId,
					actorOccurrencePath: actor.occurrence,
					actorLogicalPath: actor.logicalOccurrence,
					actorGeneration: actor.generation,
					event: envelope.event,
					input: envelope.input,
					producerVisit: `${envelope.producerState}:${envelope.producerVisit}`,
					...(envelope.callId === undefined ? {} : { callId: envelope.callId }),
					...(record.workerIndex === undefined ? {} : { workerIndex: record.workerIndex, workerOccurrencePath: actorPoolWorkerOccurrencePath(actor.occurrence, record.workerIndex) }),
					status: "replied",
					...(envelope.receiveState === undefined
						? {}
						: { receiveState: envelope.receiveState.replace(`${record.occurrence}.`, `${actor.logicalOccurrence}.`) }),
					replyState,
					...(messageAcceptedAt === undefined ? {} : { acceptedAt: messageAcceptedAt }),
					repliedAt: record.timestamp,
					...(record.replyEvent === undefined ? {} : { replyEvent: record.replyEvent }),
					...(Object.hasOwn(record, "output") ? { replyOutput: record.output } : {}),
					...(record.schema === undefined ? {} : { replySchema: { schema: record.schema.schema }, validation: "valid" as const }),
				});
			}
		}
		projectBranch(replay, ast, [record]);
	}
	for (const history of histories.values()) {
		for (const entry of history) {
			const final = projectedActorEndpoints(finalProjection)
				.flatMap((actor) => actor.messages)
				.find((message) => message.messageId === entry.messageId);
			if (final !== undefined) entry.status = final.status;
		}
	}
	return histories;
}

function runtimeMapVisitHistories(
	records: readonly DurableLogRecord[],
	skippedRecords: ReadonlySet<DurableLogRecord>,
): Map<StatePath, HyperchartMapVisitInfo[]> {
	const histories = new Map<StatePath, HyperchartMapVisitInfo[]>();
	for (const record of records) {
		if (record.type !== "spawned" || skippedRecords.has(record)) continue;
		const history = histories.get(record.path) ?? [];
		history.push({
			visit: history.length + 1,
			spawnSeqId: record.seqId,
			startedAt: record.timestamp,
			instances: { ...record.instances },
		});
		histories.set(record.path, history);
	}
	return histories;
}

function runtimeVisitHistories(
	ast: ChartAst,
	records: readonly DurableLogRecord[],
	skippedRecords: ReadonlySet<DurableLogRecord>,
): Map<StatePath, HyperchartVisitInfo[]> {
	const histories = new Map<StatePath, HyperchartVisitInfo[]>();
	const replay = createBranchProjection(ast);
	for (const record of records) {
		const pendingBefore = [...replay.pendingActions];
		projectBranch(replay, ast, [record]);
		closeExitedVisits(histories, pendingBefore, replay.pendingActions, record);
		if (record.type === "failure_intent") {
			for (const [state, visits] of histories) {
				const visit = visits.at(-1);
				if (visit === undefined || visit.status !== "running") continue;
				if (state === record.origin) {
					completeVisit(visit, { type: "FAILED", error: record.error }, record.timestamp);
				} else {
					visit.status = "cancelled";
					visit.endedAt = record.timestamp;
					visit.endedReason = "scope_exit";
				}
			}
			continue;
		}
		if (record.type !== "state_action" || skippedRecords.has(record)) continue;
		const stateId = record.actionUid.state;
		if (record.kind === "invoke") {
			const pending = replay.pendingActions.find(
				(candidate): candidate is Extract<PendingAction, { phase: "running" }> =>
					candidate.phase === "running" &&
					candidate.invokeSeqId === record.seqId &&
					actionUidKey(candidate.actionUid) === actionUidKey(record.actionUid),
			);
			if (pending === undefined) continue;
			const inputs = replay.inputs[stateId];
			const instance = nearestInstance(stateId);
			const mapValue = instance === undefined ? undefined : replay.spawns[instance.container]?.[instance.key];
			const visit: HyperchartVisitInfo = {
				visit: pending.visitId,
				invokeSeqId: record.seqId,
				startedAt: record.timestamp,
				status: "running",
				...(inputs === undefined || Object.keys(inputs).length === 0 ? {} : { inputs: { ...inputs } }),
				...(instance === undefined
					? {}
					: {
							mapItem: {
								key: instance.key,
								...(mapValue === undefined ? {} : { value: mapValue }),
							},
						}),
				invocation: visitInvocationInfo(renderPendingActionInvocation(ast, replay, pending)),
			};
			histories.set(stateId, [...(histories.get(stateId) ?? []), visit]);
			continue;
		}
		const visit = histories.get(stateId)?.at(-1);
		if (visit === undefined) continue;
		if (record.kind === "complete") {
			if (record.artifacts !== undefined) {
				visit.artifactPins = Object.entries(record.artifacts).map(([path, pin]) => ({ path, hash: pin.hash, size: pin.size }));
			}
			const state = nodeAt(ast, stateId);
			const requiresValidation =
				state?.kind === "state" && state.validate !== undefined && record.event.type !== "FAILED";
			if (!requiresValidation) completeVisit(visit, record.event, record.timestamp);
			continue;
		}
		if (record.kind === "validated") {
			visit.validationAttempts = (visit.validationAttempts ?? 0) + 1;
			const rejectionReason = validationRejectionReason(record.outcome);
			if (rejectionReason === undefined) {
				completeVisit(visit, record.event, record.timestamp);
				continue;
			}
		}
	}
	return histories;
}

function closeExitedVisits(
	histories: Map<StatePath, HyperchartVisitInfo[]>,
	before: readonly PendingAction[],
	after: readonly PendingAction[],
	record: DurableLogRecord,
): void {
	const remaining = new Set(after.map(pendingVisitKey));
	for (const pending of before) {
		if (remaining.has(pendingVisitKey(pending))) continue;
		const visit = histories.get(pending.actionUid.state)?.find((entry) => entry.visit === pending.visitId);
		if (visit === undefined || visit.status !== "running") continue;
		const timedOut =
			record.type === "state_action" &&
			record.kind === "timer_fired" &&
			actionUidKey(record.actionUid) === actionUidKey(pending.actionUid);
		visit.status = "cancelled";
		visit.endedAt = record.timestamp;
		visit.endedReason = timedOut ? "timed_out" : "scope_exit";
	}
}

function pendingVisitKey(pending: PendingAction): string {
	return `${actionUidKey(pending.actionUid)}:${pending.visitId}`;
}

function completeVisit(visit: HyperchartVisitInfo, event: ChartEvent, timestamp: number): void {
	visit.status = event.type === "FAILED" ? "failed" : "done";
	visit.completedEvent = event.type;
	visit.endedAt = timestamp;
	delete visit.endedReason;
}

function visitInvocationInfo(effect: ActionEffect): HyperchartVisitInvocationInfo {
	switch (effect.kind) {
		case "agent":
			return {
				kind: "agent",
				...(effect.task === undefined ? {} : { task: effect.task }),
				...(effect.resume?.message === undefined ? {} : { resumeMessage: effect.resume.message }),
				...(effect.reads === undefined ? {} : { reads: effect.reads.map(renderedArtifactInfo) }),
				...(effect.artifacts === undefined ? {} : { artifacts: effect.artifacts.map(renderedArtifactInfo) }),
			};
		case "script":
			return {
				kind: "script",
				command: effect.command,
				args: [...effect.args],
				...(effect.env === undefined
					? {}
					: {
							env: Object.fromEntries(
								Object.entries(effect.env).map(([name, value]) => [
									name,
									typeof value === "string" ? value : renderedArtifactInfo(value),
								]),
							),
						}),
				...(effect.artifacts === undefined ? {} : { artifacts: effect.artifacts.map(renderedArtifactInfo) }),
			};
		case "user":
			return { kind: "user", prompt: effect.prompt };
	}
}

function renderedArtifactInfo(artifact: RenderedArtifact): HyperchartRenderedArtifactInfo {
	return {
		...(artifact.name === undefined ? {} : { name: artifact.name }),
		...(artifact.sourceState === undefined ? {} : { sourceState: artifact.sourceState }),
		...(artifact.readKind === undefined ? {} : { readKind: artifact.readKind }),
		path: artifact.path,
		...(artifact.select === undefined ? {} : { select: artifact.select }),
		...(artifact.shape === undefined ? {} : { schema: { schema: artifact.shape.schema } }),
	};
}

function runIssues(status: RuntimeStatusInfo | undefined): HyperchartIssueInfo[] {
	const issues: HyperchartIssueInfo[] = [];
	if (status?.error !== undefined || (status?.exitCode !== undefined && status.exitCode !== 0)) {
		issues.push({
			severity: "error",
			kind: "run_failed",
			message: status.error ?? `Run exited with code ${status.exitCode}`,
			source: "status",
			...(status.updatedAt === undefined ? {} : { timestamp: status.updatedAt }),
			...(status.exitCode === undefined ? {} : { payload: { exitCode: status.exitCode } }),
		});
	}
	const updatedAt = status?.updatedAt;
	for (const warning of status?.replayWarnings ?? []) {
		issues.push({
			severity: "warning",
			kind: "replay_warning",
			message: warning,
			source: "status",
			...(updatedAt === undefined ? {} : { timestamp: updatedAt }),
		});
	}
	return issues;
}

function appendIssue(map: Map<StatePath, HyperchartIssueInfo[]>, stateId: StatePath, issue: HyperchartIssueInfo): void {
	map.set(stateId, [...(map.get(stateId) ?? []), issue]);
}

function failedActionIssue(
	stateId: StatePath,
	event: ChartEvent,
	seqId: number,
	timestamp: number,
): HyperchartIssueInfo {
	const error = "error" in event ? event.error : undefined;
	return {
		severity: "error",
		kind: "action_failed",
		message: issueMessageFromPayload(error, "Action failed"),
		source: "durable_log",
		stateId,
		seqId,
		timestamp,
		...(error === undefined ? {} : { payload: error }),
	};
}

function validationRejectionReason(outcome: unknown): string | undefined {
	if (outcome === true) return undefined;
	if (typeof outcome === "object" && outcome !== null && typeof (outcome as { reason?: unknown }).reason === "string")
		return (outcome as { reason: string }).reason;
	if (outcome === false) return "Validation rejected the completion.";
	return undefined;
}

function appendSessionFacts(
	map: Map<StatePath, StateRuntimeFacts>,
	progress: HyperchartRuntimeSessionProgressFile | undefined,
): void {
	if (progress === undefined) return;
	const sessionsByState = new Map<StatePath, HyperchartAgentSessionInfo[]>();
	for (const session of Object.values(progress.sessions)) {
		const stateId = session.actionUid.state;
		const facts = map.get(stateId) ?? {};
		const info = runtimeSessionInfo(session);
		const candidates = sessionsByState.get(stateId) ?? [];
		candidates.push(info);
		sessionsByState.set(stateId, candidates);
		if (facts.session === undefined || sessionActivity(info) >= sessionActivity(facts.session)) {
			facts.session = limitSessionMessages(info);
		}
		const visit = session.visit === undefined
			? facts.visitHistory?.at(-1)
			: facts.visitHistory?.find((candidate) => candidate.visit === session.visit);
		if (visit !== undefined && (visit.session === undefined || sessionActivity(info) >= sessionActivity(visit.session))) {
			visit.session = info;
		}
		map.set(stateId, facts);
	}
	for (const [stateId, candidates] of sessionsByState) {
		const facts = map.get(stateId);
		const visits = facts?.visitHistory;
		if (visits === undefined) continue;
		visits.forEach((visit, index) => {
			const nextVisitStartedAt = visits[index + 1]?.startedAt;
			const exact = visit.session;
			const exactMessages = exact === undefined ? [] : visitMessages(exact, visit, nextVisitStartedAt);
			const fallback = exactMessages.length > 0
				? undefined
				: candidates.find(
					(candidate) => candidate !== exact && visitMessages(candidate, visit, nextVisitStartedAt).length > 0,
				);
			const source = fallback === undefined
				? exact
				: exact === undefined
					? fallback
					: { ...fallback, ...exact, messages: fallback.messages ?? [] };
			if (source !== undefined) {
				visit.session = sessionForVisit(source, visit, exact !== undefined, nextVisitStartedAt);
			}
		});
		const latestVisitSession = [...visits].reverse().find((visit) => visit.session !== undefined)?.session;
		if (facts !== undefined && latestVisitSession !== undefined) {
			facts.session = limitSessionMessages(latestVisitSession);
		}
	}
}

function runtimeSessionInfo(session: HyperchartRuntimeSessionProgressInfo): HyperchartAgentSessionInfo {
	return {
		actionKey: session.actionKey ?? actionUidKey(session.actionUid),
		status: session.status ?? "unknown",
		...(session.startedAt === undefined ? {} : { startedAt: session.startedAt }),
		...(session.lastActivityAt === undefined ? {} : { lastActivityAt: session.lastActivityAt }),
		...(session.role === undefined ? {} : { role: session.role }),
		...(session.model === undefined ? {} : { model: session.model }),
		...(session.thinking === undefined ? {} : { thinking: session.thinking }),
		...(session.toolset === undefined ? {} : { toolset: session.toolset }),
		...(session.tools === undefined ? {} : { tools: [...session.tools] }),
		...(session.turnCount === undefined ? {} : { turnCount: session.turnCount }),
		...(session.toolCount === undefined ? {} : { toolCount: session.toolCount }),
		...(session.tokenCount === undefined ? {} : { tokenCount: session.tokenCount }),
		...(session.currentTool === undefined ? {} : { currentTool: session.currentTool }),
		...(session.currentToolArgs === undefined ? {} : { currentToolArgs: session.currentToolArgs }),
		...(session.currentText === undefined ? {} : { currentText: session.currentText }),
		...(session.currentReasoning === undefined ? {} : { currentReasoning: session.currentReasoning }),
		...(session.lastMessage === undefined ? {} : { lastMessage: session.lastMessage }),
		...(session.error === undefined ? {} : { error: session.error }),
		...(session.messages === undefined ? {} : { messages: session.messages }),
	};
}

function sessionActivity(session: HyperchartAgentSessionInfo): number {
	return session.lastActivityAt ?? session.startedAt ?? 0;
}

function sessionForVisit(
	session: HyperchartAgentSessionInfo,
	visit: HyperchartVisitInfo,
	exact: boolean,
	nextVisitStartedAt: number | undefined,
): HyperchartAgentSessionInfo {
	const messages = visitMessages(session, visit, nextVisitStartedAt);
	const sessionMessages = (messages.length > 0 ? messages : exact ? session.messages : undefined)?.slice(-120);
	const historical = visit.status !== "running";
	return {
		...(historical ? withoutCurrentSessionActivity(session) : session),
		status: historical
			? visit.status === "failed"
				? "failed"
				: visit.status === "cancelled"
					? "cancelled"
					: "completed"
			: session.status,
		startedAt: visit.startedAt,
		...(visit.endedAt === undefined ? {} : { lastActivityAt: visit.endedAt }),
		...(sessionMessages === undefined ? {} : { messages: sessionMessages }),
	};
}

function limitSessionMessages(session: HyperchartAgentSessionInfo): HyperchartAgentSessionInfo {
	return session.messages === undefined ? session : { ...session, messages: session.messages.slice(-120) };
}

function withoutCurrentSessionActivity(session: HyperchartAgentSessionInfo): HyperchartAgentSessionInfo {
	const historical = { ...session };
	delete historical.currentTool;
	delete historical.currentToolArgs;
	delete historical.currentText;
	delete historical.currentReasoning;
	return historical;
}

function visitMessages(
	session: HyperchartAgentSessionInfo,
	visit: HyperchartVisitInfo,
	nextVisitStartedAt: number | undefined,
): HyperchartSessionMessageInfo[] {
	const messages = session.messages ?? [];
	const timestamped = messages.filter(
		(message): message is HyperchartSessionMessageInfo & { timestamp: number } => typeof message.timestamp === "number",
	);
	if (timestamped.length === 0) return [];
	const end = nextVisitStartedAt ?? visit.endedAt ?? Number.POSITIVE_INFINITY;
	return timestamped.filter(
		(message) =>
			message.timestamp >= visit.startedAt &&
			(nextVisitStartedAt === undefined ? message.timestamp <= end : message.timestamp < end),
	);
}

function appendSessionIssues(
	map: Map<StatePath, HyperchartIssueInfo[]>,
	progress: HyperchartRuntimeSessionProgressFile | undefined,
): void {
	if (progress === undefined) return;
	for (const session of Object.values(progress.sessions)) {
		if (session.error === undefined && session.status !== "failed") continue;
		const stateId = session.actionUid.state;
		const timestamp = session.completedAt ?? session.lastActivityAt ?? session.startedAt;
		appendIssue(map, stateId, {
			severity: "error",
			kind: "session_failed",
			message: session.error ?? "Agent session failed.",
			source: "session_progress",
			stateId,
			...(timestamp === undefined ? {} : { timestamp }),
			payload: compactSessionPayload(session),
		});
	}
}

function compactSessionPayload(session: HyperchartRuntimeSessionProgressInfo): Record<string, unknown> {
	return {
		status: session.status,
		...(session.visit === undefined ? {} : { visit: session.visit }),
		...(session.actionName === undefined ? {} : { actionName: session.actionName }),
		...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
		...(session.role === undefined ? {} : { role: session.role }),
		...(session.model === undefined ? {} : { model: session.model }),
		...(session.toolset === undefined ? {} : { toolset: session.toolset }),
		...(session.tools === undefined ? {} : { tools: session.tools }),
		...(session.turnCount === undefined ? {} : { turnCount: session.turnCount }),
		...(session.toolCount === undefined ? {} : { toolCount: session.toolCount }),
		...(session.tokenCount === undefined ? {} : { tokenCount: session.tokenCount }),
		...(session.error === undefined ? {} : { error: session.error }),
	};
}

function issueMessageFromPayload(payload: unknown, fallback: string): string {
	if (payload === undefined || payload === null) return fallback;
	if (typeof payload === "string") return payload;
	if (typeof payload === "object") {
		const record = payload as Record<string, unknown>;
		if (typeof record.message === "string") return record.message;
		if (typeof record.stderr === "string" && record.stderr.trim().length > 0) {
			const prefix = typeof record.code === "number" ? `Script exited with code ${record.code}` : "Script failed";
			return `${prefix}: ${oneLine(record.stderr)}`;
		}
		const details = [
			typeof record.code === "number" ? `code ${record.code}` : undefined,
			typeof record.signal === "string" ? record.signal : undefined,
		]
			.filter(Boolean)
			.join(" · ");
		if (details.length > 0) return `Action failed (${details})`;
	}
	try {
		return previewText(JSON.stringify(payload)) ?? fallback;
	} catch {
		return String(payload);
	}
}

function oneLine(value: string): string {
	return (
		previewText(
			value
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean)
				.at(-1) ?? value.trim(),
		) ?? ""
	);
}

function materializedMapStates(
	staticStates: readonly HyperchartStateInfo[],
	ast: ChartAst,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
): HyperchartStateInfo[] {
	const expanded: HyperchartStateInfo[] = [];
	const mapTemplates = staticStates.filter((state) => state.type === "map");
	for (const [concreteMapPath, instances] of Object.entries(projection.spawns)) {
		const templateMapPath = templatePath(concreteMapPath);
		const mapState = mapTemplates.find((state) => state.id === templateMapPath);
		if (mapState === undefined) continue;
		const descendants = staticStates.filter(
			(candidate) =>
				candidate.id.startsWith(`${templateMapPath}.`) &&
				!mapTemplates.some(
					(nestedMap) =>
						nestedMap.id !== templateMapPath &&
						nestedMap.id.startsWith(`${templateMapPath}.`) &&
						candidate.id.startsWith(`${nestedMap.id}.`),
				),
		);
		for (const key of Object.keys(instances)) {
			for (const descendant of descendants) {
				const clone = materializeMapState(descendant, templateMapPath, concreteMapPath, key);
				expanded.push(overlayRuntimeState(clone, ast, projection, runtime));
			}
		}
	}
	return expanded;
}

function materializeMapState(
	state: HyperchartStateInfo,
	templateMapPath: StatePath,
	concreteMapPath: StatePath,
	key: string,
): HyperchartStateInfo {
	const templateParent = state.scopeParentId ?? parentPath(state.id);
	return {
		...state,
		id: materializeMapPath(state.id, templateMapPath, concreteMapPath, key),
		...(templateParent === undefined ? {} : { scopeParentId: materializeMapPath(templateParent, templateMapPath, concreteMapPath, key) }),
		...(state.transitions === undefined
			? {}
			: {
					transitions: state.transitions.map((transition) => ({
						...transition,
						target: materializeMapPath(transition.target, templateMapPath, concreteMapPath, key),
					})),
				}),
		...(state.parallelConfig?.branches === undefined
			? {}
			: {
					parallelConfig: {
						...state.parallelConfig,
						branches: state.parallelConfig.branches.map((branch) => ({
							...branch,
							...(branch.id === undefined
								? {}
								: { id: materializeMapPath(branch.id, templateMapPath, concreteMapPath, key) }),
						})),
					},
				}),
	};
}

function materializeMapPath(
	path: StatePath,
	templateMapPath: StatePath,
	concreteMapPath: StatePath,
	key: string,
): StatePath {
	const instanceRoot = `${concreteMapPath}#${key}`;
	if (path === templateMapPath) return instanceRoot;
	if (path.startsWith(`${templateMapPath}.`)) return `${instanceRoot}${path.slice(templateMapPath.length)}`;
	return instancePathFor(path, concreteMapPath);
}

function runtimeValidationAttempts(
	facts: StateRuntimeFacts | undefined,
	pending: PendingAction | undefined,
): number | undefined {
	if (facts?.validationAttempts !== undefined) return facts.validationAttempts;
	return pending?.phase === "validating" || pending?.phase === "rejected" ? pending.validationAttempts : undefined;
}

function pendingRejectedReason(pending: PendingAction | undefined): string | undefined {
	return pending?.phase === "rejected" ? pending.reason : undefined;
}

function runtimeMapItemInfo(
	stateId: StatePath,
	projection: ReturnType<typeof createBranchProjection>,
): Pick<HyperchartStateInfo, "mapKey" | "mapItemLabel"> | undefined {
	const instance = nearestInstance(stateId);
	if (instance === undefined) return undefined;
	const value = projection.spawns[instance.container]?.[instance.key];
	return {
		mapKey: instance.key,
		mapItemLabel: mapItemLabel(instance.key, value),
	};
}

function overlayRuntimeState(
	state: HyperchartStateInfo,
	ast: ChartAst,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
): HyperchartStateInfo {
	const runtimeStatePath = state.runtimeStatePath ?? state.id;
	const facts = runtime.byState.get(runtimeStatePath);
	const pending = runtime.pendingByState.get(runtimeStatePath);
	const validationAttempts = runtimeValidationAttempts(facts, pending);
	const mapItem = runtimeMapItemInfo(runtimeStatePath, projection);
	const issues = runtime.issuesByState.get(runtimeStatePath);
	const latestRejectedReason = facts?.latestRejectedReason ?? pendingRejectedReason(pending);
	const failedCompletion = facts?.completedEvent?.type === "FAILED";
	const acceptedCompletion = pending === undefined || failedCompletion ? facts?.completedEvent : undefined;
	const acceptedCompletionAt = pending === undefined || failedCompletion ? facts?.completedAt : undefined;
	const next: HyperchartStateInfo = {
		...state,
		status: runtimeStateStatus(state, runtimeStatePath, ast, projection, runtime),
		...(facts?.invokedAt === undefined ? {} : { startedAt: facts.invokedAt }),
		...(acceptedCompletionAt === undefined ? {} : { endedAt: acceptedCompletionAt }),
		...(acceptedCompletion === undefined ? {} : { completedEvent: acceptedCompletion.type }),
		...(facts?.attempts === undefined ? {} : { attempts: facts.attempts }),
		...(validationAttempts === undefined ? {} : { validationAttempts }),
		...(latestRejectedReason === undefined ? {} : { validation: { latestRejectedReason } }),
		...(facts?.visits === undefined ? {} : { visits: facts.visits }),
		...(facts?.visitHistory === undefined ? {} : { visitHistory: facts.visitHistory }),
		...(facts?.session === undefined ? {} : { session: facts.session }),
		...(facts?.actorMessageHistory === undefined ? {} : { actorMessageHistory: facts.actorMessageHistory }),
		...(state.actorMessageLink === undefined || facts?.actorMessages === undefined
			? {}
			: { actorMessageLink: { ...state.actorMessageLink, messages: facts.actorMessages } }),
		...(issues === undefined || issues.length === 0 ? {} : { issues }),
		...(mapItem === undefined ? {} : mapItem),
	};
	if (next.transitions?.length && next.completedEvent !== undefined) {
		next.transitions = next.transitions.map((transition) => ({
			...transition,
			...(transition.event === next.completedEvent ? { taken: true } : {}),
		}));
	}
	if (state.type === "map") return overlayMapRuntime(next, ast, projection, runtime);
	if (state.type === "parallel") return overlayParallelRuntime(next, ast, projection, runtime);
	return next;
}

function activeLeavesStatus(
	activeLeaves: readonly StatePath[],
	ast: ChartAst,
	runtime: RuntimeFacts,
	finalLeavesAreDone = false,
): "running" | "waiting" | "done" | undefined {
	if (activeLeaves.length === 0) return undefined;
	if (activeLeaves.every((leaf) => nodeAt(ast, leaf)?.kind === "final")) {
		return finalLeavesAreDone ? "done" : "running";
	}
	const actionLeaves = activeLeaves.filter((leaf) => nodeAt(ast, leaf)?.kind === "state");
	if (actionLeaves.length > 0 && actionLeaves.every((leaf) => runtime.waitingLeaves.has(leaf))) return "waiting";
	return "running";
}

function runtimeStateStatus(
	state: HyperchartStateInfo,
	runtimeStatePath: StatePath,
	ast: ChartAst,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
): HyperchartStateStatus {
	const facts = runtime.byState.get(runtimeStatePath);
	const pending = runtime.pendingByState.get(runtimeStatePath);
	if (state.actorInternal?.occurrencePath !== undefined) {
		if (projection.failure?.origin === runtimeStatePath) return "failed";
		const actor = projectedActorEndpoint(projection, state.actorInternal.occurrencePath);
		const actorIsLive = actor !== undefined && actor.status !== "stopped" && actor.status !== "failed" && actor.status !== "cancelled";
		const isCurrent = actor?.definition.kind === "actorPool"
			? (actor as ProjectedActorPoolOccurrence).workers.some((worker) => worker.currentState === state.actorInternal?.localState)
			: (actor as ProjectedActorOccurrence | undefined)?.currentState === state.actorInternal.localState;
		if (actorIsLive && isCurrent) return state.type === "receive" ? "waiting" : "running";
		if (facts?.completedAt !== undefined || (facts?.attempts ?? 0) > 0 || (facts?.actorMessageHistory?.length ?? 0) > 0) return "done";
		return "pending";
	}
	if (facts?.completedEvent?.type === "FAILED") return "failed";
	// Global actor failure terminalizes pending callers without a reply fact.
	if (
		projection.failure !== undefined &&
		Object.values(projection.pendingActorCalls).some((call) => call.callerState === runtimeStatePath)
	) return "failed";
	if (pending !== undefined) {
		const node = nodeAt(ast, runtimeStatePath);
		return node?.kind === "state" && node.action.kind === "user" ? "waiting" : "running";
	}
	if (state.type === "final") {
		const reached = projection.activeLeaves.includes(state.id) ||
			finalReached(state.id, ast, runtime) ||
			finalReachedViaOnDone(state.id, ast, projection, runtime);
		const waitingForActorDrain = reached && [
			...Object.values(projection.actors),
			...Object.values(projection.actorPools),
		].some((actor) => actor.status === "closing" || actor.status === "draining");
		return waitingForActorDrain ? "waiting" : reached ? "done" : "pending";
	}
	if (
		(state.type === "compound" || state.type === "region") &&
		scopeReachedFinal(state.id, ast, projection, runtime)
	) {
		const waitingForActorDrain = [
			...Object.values(projection.actors),
			...Object.values(projection.actorPools),
		].some((actor) =>
			(actor.status === "closing" || actor.status === "draining") &&
			(actor.owner === state.id || (actor.owner !== undefined && underScope(actor.owner, state.id))));
		return waitingForActorDrain ? "waiting" : "done";
	}
	const activeStatus = activeLeavesStatus(
		projection.activeLeaves.filter((leaf) => leaf === state.id || underScope(leaf, state.id)),
		ast,
		runtime,
	);
	if (activeStatus !== undefined) return activeStatus;
	if (facts?.completedAt !== undefined) return "done";
	if (closedByCompletedAncestor(state.id, ast, projection, runtime)) return "done";
	if (state.type === "map") {
		const spawned = projection.spawns[state.id];
		if (spawned !== undefined) {
			const items = currentMapItems(state.id, mapItems(state, ast, projection, runtime), projection);
			if (items.every((item) => item.status === "done")) return "done";
			if (items.some((item) => item.status === "failed")) return "failed";
			if (items.some((item) => item.status === "running")) return "running";
			if (items.some((item) => item.status === "waiting")) return "waiting";
		}
	}
	if (state.type === "parallel") {
		const progress = fanoutProgressForScope(
			state.id,
			ast,
			projection,
			runtime,
			state.parallelConfig?.branches?.map((branch) => branch.id).filter((id): id is string => id !== undefined) ?? [],
		);
		if (progress.failed > 0) return "failed";
		if (progress.running > 0) return "running";
		if ((progress.waiting ?? 0) > 0) return "waiting";
		if (progress.total > 0 && progress.done === progress.total) return "done";
	}
	const node = ast.states[state.id];
	if (
		node !== undefined &&
		(node.kind === "compound" || node.kind === "region") &&
		projection.activeLeaves.some((leaf) => underScope(leaf, state.id))
	)
		return "running";
	return state.status;
}

function overlayMapRuntime(
	state: HyperchartStateInfo,
	ast: ChartAst,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
): HyperchartStateInfo {
	const rawItems = mapItems(state, ast, projection, runtime);
	const items = state.status === "done" || closedByCompletedAncestor(state.id, ast, projection, runtime)
		? rawItems.map((item) => item.status === "stale" ? { ...item, status: "done" as const } : item)
		: rawItems;
	const visitHistory = runtime.mapVisitHistoryByState.get(state.id);
	if (items.length === 0 && projection.spawns[state.id] === undefined && visitHistory === undefined) return state;
	const progressItems = currentMapItems(state.id, items, projection);
	const done = progressItems.filter((item) => item.status === "done").length;
	const waiting = progressItems.filter((item) => item.status === "waiting").length;
	const running = progressItems.filter((item) => item.status === "running").length;
	const failed = progressItems.filter((item) => item.status === "failed").length;
	const stale = progressItems.filter((item) => item.status === "stale").length;
	return {
		...state,
		...(visitHistory === undefined ? {} : { visits: visitHistory.length }),
		mapConfig: {
			...state.mapConfig,
			items,
			...(visitHistory === undefined ? {} : { visitHistory }),
		},
		subProgress: {
			done,
			running,
			failed,
			total: progressItems.length,
			...(waiting === 0 ? {} : { waiting }),
			...(stale === 0 ? {} : { stale }),
		},
	};
}

function currentMapItems(
	stateId: StatePath,
	items: NonNullable<NonNullable<HyperchartStateInfo["mapConfig"]>["items"]>,
	projection: ReturnType<typeof createBranchProjection>,
): NonNullable<NonNullable<HyperchartStateInfo["mapConfig"]>["items"]> {
	const currentInstances = projection.spawns[stateId];
	if (currentInstances === undefined) return items;
	return items.filter((item) => Object.hasOwn(currentInstances, item.key));
}

function mapItems(
	state: HyperchartStateInfo,
	ast: ChartAst,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
): NonNullable<NonNullable<HyperchartStateInfo["mapConfig"]>["items"]> {
	const visitHistory = runtime.mapVisitHistoryByState.get(state.id) ?? [];
	const currentInstances = projection.spawns[state.id];
	const instances = Object.create(null) as Record<string, unknown>;
	for (const visit of visitHistory) Object.assign(instances, visit.instances);
	if (currentInstances !== undefined) Object.assign(instances, currentInstances);
	return Object.entries(instances).map(([key, value]) => {
		const instancePath = `${state.id}#${key}`;
		const summary = mapItemSummary(value);
		const visits = visitHistory
			.filter((visit) => Object.hasOwn(visit.instances, key))
			.map((visit) => visit.visit);
		const issueCount = scopeIssueCount(instancePath, runtime);
		const isHistorical = currentInstances !== undefined && !Object.hasOwn(currentInstances, key);
		return {
			key,
			label: mapItemLabel(key, value),
			...(summary === undefined ? {} : { summary }),
			status: isHistorical ? "stale" : mapItemStatus(instancePath, projection, runtime, ast),
			state: instancePath,
			value,
			...(visits.length === 0 ? {} : { visits }),
			...(issueCount === 0 ? {} : { issueCount }),
		};
	});
}

function mapItemLabel(key: string, value: unknown): string {
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		if (typeof record.title === "string") return record.title;
		if (typeof record.label === "string") return record.label;
	}
	return key;
}

function mapItemSummary(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	return typeof record.summary === "string" ? record.summary : undefined;
}

function closedByCompletedAncestor(
	statePath: StatePath,
	ast: ChartAst,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
): boolean {
	let scope = parentPath(statePath);
	while (scope !== undefined) {
		if (completedScopeIsClosed(scope, ast, projection, runtime)) return true;
		scope = parentPath(scope);
	}
	return false;
}

function completedScopeIsClosed(
	scopePath: StatePath,
	ast: ChartAst,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
): boolean {
	return (
		scopeReachedFinal(scopePath, ast, projection, runtime) &&
		!projection.activeLeaves.some((leaf) => leaf === scopePath || underScope(leaf, scopePath))
	);
}

function scopeReachedFinal(
	scopePath: StatePath,
	ast: ChartAst,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
): boolean {
	const templateScope = templatePath(scopePath);
	return Object.values(ast.states).some((candidate) => {
		if (candidate.kind !== "final" || candidate.parent !== templateScope) return false;
		const finalPath = `${scopePath}.${candidate.id}`;
		return (
			projection.activeLeaves.includes(finalPath) ||
			finalReached(finalPath, ast, runtime) ||
			finalReachedViaOnDone(finalPath, ast, projection, runtime)
		);
	});
}

function finalReached(finalPath: StatePath, ast: ChartAst, runtime: RuntimeFacts): boolean {
	for (const [statePath, facts] of runtime.byState) {
		const eventType = facts.completedEvent?.type;
		if (eventType === undefined || runtime.pendingByState.has(statePath)) continue;
		const state = nodeAt(ast, statePath);
		if ((state?.kind === "send" || state?.kind === "sendBatch") && eventType === "ENQUEUED") {
			if (siblingPath(statePath, state.target) === finalPath) return true;
			continue;
		}
		if (state?.kind !== "state") continue;
		const transition = state.transitions[eventType];
		if (transition !== undefined && siblingPath(statePath, transition.target) === finalPath) return true;
	}
	return false;
}

// A final entered through a sibling container's onDone leaves no action-completion
// record targeting it; derive it from the container's own completion instead.
function finalReachedViaOnDone(
	finalPath: StatePath,
	ast: ChartAst,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
): boolean {
	const scope = parentPath(finalPath);
	if (scope === undefined) return false;
	const finalId = finalPath.slice(scope.length + 1);
	const templateScope = templatePath(scope);
	return Object.values(ast.states).some((candidate) => {
		if (candidate.parent !== templateScope) return false;
		if (candidate.kind !== "compound" && candidate.kind !== "map" && candidate.kind !== "parallel") return false;
		if (candidate.onDone !== finalId) return false;
		const containerPath = `${scope}.${candidate.id}`;
		if (candidate.kind === "compound") {
			const waitingForActorDrain = [
				...Object.values(projection.actors),
				...Object.values(projection.actorPools),
			].some((actor) =>
				(actor.status === "closing" || actor.status === "draining") &&
				(actor.owner === containerPath || (actor.owner !== undefined && underScope(actor.owner, containerPath))));
			return !waitingForActorDrain && scopeReachedFinal(containerPath, ast, projection, runtime);
		}
		if (candidate.kind === "parallel") {
			return candidate.regions.every((region) =>
				scopeReachedFinal(`${containerPath}.${region}`, ast, projection, runtime),
			);
		}
		const spawned = projection.spawns[containerPath];
		if (spawned === undefined) return false;
		const keys = Object.keys(spawned);
		return (
			keys.length > 0 &&
			keys.every((key) => mapItemStatus(`${containerPath}#${key}`, projection, runtime, ast) === "done")
		);
	});
}

function mapItemStatus(
	instancePath: StatePath,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
	ast: ChartAst | undefined,
): HyperchartStateStatus {
	const childFacts = [...runtime.byState.entries()].filter(([path]) => underScope(path, instancePath));
	if (childFacts.some(([, facts]) => facts.completedEvent?.type === "FAILED")) return "failed";
	const activeLeaves = projection.activeLeaves.filter((leaf) => underScope(leaf, instancePath));
	const waitingForActorDrain = [
		...Object.values(projection.actors),
		...Object.values(projection.actorPools),
	].some((actor) =>
		(actor.status === "closing" || actor.status === "draining") &&
		actor.owner !== undefined &&
		(actor.owner === instancePath || underScope(actor.owner, instancePath)));
	if (waitingForActorDrain) return "waiting";
	if (ast !== undefined) {
		const activeStatus = activeLeavesStatus(activeLeaves, ast, runtime, true);
		if (activeStatus !== undefined) return activeStatus;
	} else if (activeLeaves.length > 0) {
		return "running";
	}
	if (childFacts.some(([, facts]) => facts.completedAt !== undefined)) return "done";
	return "pending";
}

function overlayParallelRuntime(
	state: HyperchartStateInfo,
	ast: ChartAst,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
): HyperchartStateInfo {
	const branches = state.parallelConfig?.branches ?? [];
	const branchIds = branches.map((branch) => branch.id).filter((id): id is string => id !== undefined);
	const progress = fanoutProgressForScope(state.id, ast, projection, runtime, branchIds);
	const count = progress.total || state.parallelConfig?.count;
	const branchesWithIssues = branches.map((branch) => {
		const issueCount = branch.id === undefined ? 0 : scopeIssueCount(branch.id, runtime);
		return { ...branch, ...(issueCount === 0 ? {} : { issueCount }) };
	});
	return {
		...state,
		parallelConfig: {
			...state.parallelConfig,
			...(count === undefined ? {} : { count }),
			branches: branchesWithIssues,
		},
		...(progress.total > 0 ? { subProgress: progress } : {}),
	};
}

function fanoutProgressForScope(
	scope: StatePath,
	ast: ChartAst | undefined,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
	childScopes: readonly StatePath[],
): NonNullable<HyperchartStateInfo["subProgress"]> {
	const scopes =
		childScopes.length > 0
			? childScopes
			: [
					...new Set(
						projection.activeLeaves
							.filter((leaf) => underScope(leaf, scope))
							.map((leaf) => directChildScope(scope, leaf))
							.filter((value): value is string => value !== undefined),
					),
				];
	let done = 0;
	let waiting = 0;
	let running = 0;
	let failed = 0;
	for (const childScope of scopes) {
		const status = scopeStatus(childScope, projection, runtime, ast);
		if (status === "done") done++;
		else if (status === "failed") failed++;
		else if (status === "waiting") waiting++;
		else if (status === "running") running++;
	}
	return { done, running, failed, total: scopes.length, ...(waiting === 0 ? {} : { waiting }) };
}

function directChildScope(scope: StatePath, leaf: StatePath): string | undefined {
	if (!underScope(leaf, scope) || leaf === scope) return undefined;
	const rest = leaf.startsWith(`${scope}.`)
		? leaf.slice(scope.length + 1)
		: leaf.startsWith(`${scope}#`)
			? leaf.slice(scope.length + 1)
			: undefined;
	const first = rest?.split(".")[0];
	return first === undefined ? undefined : `${scope}.${first}`;
}

function scopeStatus(
	scope: StatePath,
	projection: ReturnType<typeof createBranchProjection>,
	runtime: RuntimeFacts,
	ast: ChartAst | undefined,
): HyperchartStateStatus {
	const facts = [...runtime.byState.entries()].filter(([path]) => underScope(path, scope));
	if (facts.some(([, fact]) => fact.completedEvent?.type === "FAILED")) return "failed";
	const activeLeaves = projection.activeLeaves.filter((leaf) => underScope(leaf, scope));
	if (ast !== undefined) {
		const activeStatus = activeLeavesStatus(activeLeaves, ast, runtime, true);
		if (activeStatus !== undefined) return activeStatus;
	} else if (activeLeaves.length > 0) {
		return "running";
	}
	if (facts.some(([, fact]) => fact.completedAt !== undefined)) return "done";
	return "pending";
}

function scopeIssueCount(scope: StatePath, runtime: RuntimeFacts): number {
	let count = 0;
	for (const [path, issues] of runtime.issuesByState) {
		if (underScope(path, scope)) count += issues.length;
	}
	return count;
}

function inspectParallelConfig(state: HyperchartInspectState): NonNullable<HyperchartStateInfo["parallelConfig"]> {
	const branches =
		state.branches?.map((branch) => ({
			id: branch.id,
			...(branch.agent === undefined ? {} : { agent: branch.agent }),
			...(branch.task === undefined ? {} : { taskPreview: previewText(branch.task) }),
		})) ??
		state.regions?.map((id) => ({ id })) ??
		[];
	return { count: state.regions?.length ?? branches.length, branches };
}

function inspectStateKindToStateType(kind: HyperchartInspectState["kind"]): HyperchartStateInfo["type"] {
	return kind;
}

function guardInfo(guard: NonNullable<HyperchartInspectState["guard"]>): NonNullable<HyperchartStateInfo["guard"]> {
	if (guard.kind === "script") {
		return {
			kind: "script",
			command: guard.command,
			...(guard.args === undefined ? {} : { args: [...guard.args] }),
			...(guard.env === undefined
				? {}
				: {
						env: guard.env.map((env) => ({
							name: env.name,
							type: env.type,
							...(env.value === undefined ? {} : { value: env.value }),
							...(env.schema === undefined ? {} : { schema: { schema: env.schema } }),
						})),
					}),
			...(guard.artifacts === undefined ? {} : { artifacts: guard.artifacts.map((artifact) => ({
					name: artifact.name,
					...(artifact.path === undefined ? {} : { path: artifact.path }),
					...(artifact.shape === undefined ? {} : { schema: { schema: artifact.shape } }),
				})) }),
			...(guard.reply === undefined ? {} : { reply: { schema: guard.reply } }),
		};
	}
	return { kind: "tsImport", module: guard.module, export: guard.export };
}

function refsInfo(refs: HyperchartInspectState["refs"]): HyperchartRefInfo | undefined {
	if (!refs || refs.length === 0) return undefined;
	const grouped: HyperchartRefInfo = {};
	for (const ref of refs) {
		appendRef(grouped, ref.kind === "artifactOf" || ref.kind === "joinArtifactOf" ? "artifact" : ref.kind, ref.preview);
	}
	return Object.keys(grouped).length === 0 ? undefined : grouped;
}

function appendRef(grouped: HyperchartRefInfo, kind: keyof HyperchartRefInfo, preview: string): void {
	grouped[kind] = [...new Set([...(grouped[kind] ?? []), preview])];
}

function previewText(text: string | undefined): string | undefined {
	if (!text) return undefined;
	return text.length > 220 ? `${text.slice(0, 219)}…` : text;
}

function isInspectResult(value: unknown): value is HyperchartInspectResult {
	if (!isRecord(value)) return false;
	return typeof value.chartId === "string" && Array.isArray(value.states);
}

function isRunInfo(value: unknown): value is HyperchartRunInfo {
	if (!isRecord(value)) return false;
	return typeof value.runId === "string" && typeof value.chartName === "string" && Array.isArray(value.states);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
