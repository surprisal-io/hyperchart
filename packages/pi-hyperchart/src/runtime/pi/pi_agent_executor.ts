import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type ModelRuntime,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { actionUidDirName, actionUidKey, sanitizeSegment } from "@surprisal/hyperchart/internal/core/action_uid";
import type { ActionUID, ChartEvent } from "@surprisal/hyperchart/internal/core/types";
import type { AgentEffect, RejectedEffect } from "@surprisal/hyperchart/internal/core/machine";
import { errorMessage } from "@surprisal/hyperchart/internal/utils/errors";
import type { AgentExecutor, EmitCompletion, SessionPlan } from "@surprisal/hyperchart/runtime";
import type { HyperchartSessionMessageInfo } from "@surprisal/hyperchart/host";
import type { SchemaRegistryLike as SchemaRegistry } from "@surprisal/hyperchart/internal/core/schema_registry";
import {
	GenerationTracker,
	actionSessionDir,
	branchSessionSegment,
	buildRejectPrompt,
	buildResumePrompt,
	buildSessionPlan,
	buildTaskPrompt,
	checkEffectArtifacts,
	effectInvokeSeqId,
	previewText,
	resolveReads,
	runAcceptanceLoop,
	sessionKey,
	shouldRecoverRestoredFinish,
	stringifyToolArgs,
	validateDeclaredReadPaths,
} from "@surprisal/hyperchart/runtime";
import {
	loadAgentDefinition,
	resolvePiSubagentDefinitionDirs,
	type AgentDefinition,
} from "./agent_definitions.js";
import { createFinishTool, type CompletionSink, validateFinishParams } from "./finish_tool.js";
import { createThrottledProgressWriter, updateSessionProgress } from "@surprisal/hyperchart/sessions";

export { buildSessionPlan, shouldRecoverRestoredFinish, validateDeclaredReadPaths };
export type { SessionPlan };

export type PiSessionOverridesContext = Readonly<{
	branchId: string;
	actionUid: ActionUID;
	agentName: string;
	declaredRole?: string;
	declaredToolset?: string;
}>;

export type PiSessionOverrides = Readonly<{
	/** Concrete model reference for this invocation. */
	model?: string;
	/** Concrete allowlist for this invocation; replaces the declared toolset. */
	tools?: string[];
	/** Invocation-scoped context appended to the agent definition's system prompt. */
	appendSystemPrompt?: string;
	/** Custom tools registered only for this invocation. */
	customTools?: ToolDefinition[];
}>;

export type PiSessionHandle = Readonly<{
	manager: SessionManager;
	sessionId: string;
	restored: boolean;
	drain(): Promise<void>;
	close(): Promise<void>;
}>;

export interface PiSessionService {
	openOrCreate(sessionId: string): Promise<PiSessionHandle>;
	readTranscript(sessionId: string): Promise<HyperchartSessionMessageInfo[] | undefined>;
	close(): Promise<void>;
}

type PiExecutorOptionsBase = {
	/** Branch-isolated workspace used as the agent cwd. */
	workDir: string;
	/** Repository/project directory that owns the run. */
	projectDir?: string;
	agentDir?: string;
	definitionDirs?: string[];
	sessionsDir: string;
	branchId: string;
	modelRuntime: ModelRuntime;
	defaultModel?: string;
	modelRoles?: Record<string, string>;
	toolsets?: Record<string, string[]>;
	/** Resolve mutable host configuration immediately before a Pi session starts. */
	resolveSessionOverrides?: (context: PiSessionOverridesContext) => Promise<PiSessionOverrides | undefined>;
	maxFinishRetries?: number;
	schemaRegistry?: SchemaRegistry;
};

export type PiExecutorOptions = PiExecutorOptionsBase & {
	sessionService?: PiSessionService;
};

export function createInvocationCustomTools(
	effect: AgentEffect,
	sink: CompletionSink,
	registry: SchemaRegistry | undefined,
	customTools: readonly ToolDefinition[] | undefined,
): ToolDefinition[] {
	return [...(customTools ?? []), createFinishTool(effect, sink, registry)];
}

export function sessionIdForAttempt(sessionId: string, attempt: number): string {
	return attempt === 0 ? sessionId : `${sessionId}:attempt:${attempt}`;
}

function workspaceContextNote(projectDir: string, branchWorkspace: string): string {
	if (projectDir === branchWorkspace) return [
		`Project/repository directory: ${projectDir}`,
		`Branch workspace (current working directory): ${branchWorkspace}`,
		`Working directory: ${branchWorkspace}`,
	].join("\n");
	return [
		`Project/repository directory: ${projectDir}`,
		`Branch workspace (current working directory): ${branchWorkspace}`,
		`Working directory: ${branchWorkspace}`,
		"The branch workspace is an isolated Hyperchart artifact workspace, not a checkout of the project repository. Do not assume project files are present in it. If the task requires project files, use the project/repository path explicitly; edits there are outside branch-workspace isolation.",
	].join("\n");
}

type LiveAgent = {
	session: AgentSession;
	effect: AgentEffect;
	sink: CompletionSink;
	generation: number;
	unsubscribeProgress?: () => void;
};

type RunOptions = {
	forceNewSession: boolean;
	sessionAttempt: number;
	resumePrompt?: string;
	rejectReason?: string;
	resumeSessionFile?: string;
};

class SessionCleanupError extends AggregateError {}

export class PiAgentExecutor implements AgentExecutor {
	private readonly live = new Map<string, LiveAgent>();
	private readonly runs = new Map<string, Map<number, Promise<void>>>();
	private readonly cancellations = new Map<string, Promise<void>>();
	private readonly cleanupTasks = new Set<Promise<void>>();
	private readonly generations = new GenerationTracker();
	private readonly cleanupFailures: unknown[] = [];
	private readonly sessionHandles = new WeakMap<AgentSession, PiSessionHandle>();
	private readonly agentDir: string;
	private readonly definitionDirs: string[];
	private readonly maxFinishRetries: number;
	private disposed = false;
	private disposal: Promise<void> | undefined;

	constructor(private readonly options: PiExecutorOptions) {
		this.agentDir = options.agentDir ?? getAgentDir();
		this.definitionDirs = options.definitionDirs ?? resolvePiSubagentDefinitionDirs(options.workDir, this.agentDir);
		this.maxFinishRetries = options.maxFinishRetries ?? 2;
	}

	start(effect: AgentEffect, emit: EmitCompletion): void {
		if (this.disposed) {
			emit({ type: "FAILED", error: "Pi agent executor is disposed" });
			return;
		}
		const key = actionUidKey(effect.actionUid);
		const generation = this.generations.next(key);
		this.launch(key, generation, this.run(
			effect,
			emit,
			{
				forceNewSession: false,
				sessionAttempt: 0,
				...(effect.resume === undefined
					? {}
					: { resumePrompt: effect.resume.message, resumeSessionFile: effect.resume.session }),
			},
			generation,
		).catch((error: unknown) => this.handleRunFailure(key, generation, effect, emit, error)));
	}

	reject(effect: RejectedEffect, emit: EmitCompletion): void {
		if (this.disposed) {
			emit({ type: "FAILED", error: "Pi agent executor is disposed" });
			return;
		}
		const key = actionUidKey(effect.actionUid);
		const retryEffect = rejectedAgentInvocation(effect);
		if (retryEffect === undefined) {
			emit({
				type: "FAILED",
				error: `Cannot recover rejected action ${key}: replay-derived agent invocation is missing`,
			});
			return;
		}

		const live = this.live.get(key);
		if (live !== undefined) {
			this.generations.markCancelled(key, live.generation);
			live.unsubscribeProgress?.();
			this.live.delete(key);
			if (effect.onReject === "restart") {
				this.trackCleanup(this.cleanupSession(live.session));
				const generation = this.generations.next(key);
				this.launch(key, generation, this.run(
					retryEffect,
					emit,
					{
						forceNewSession: true,
						sessionAttempt: effect.validationAttempts,
						...(effect.reason === undefined ? {} : { rejectReason: effect.reason }),
					},
					generation,
				).catch((error: unknown) => this.handleRunFailure(key, generation, retryEffect, emit, error)));
				return;
			}

			this.trackCleanup(this.disposeSession(live.session));
			const generation = this.generations.next(key);
			this.launch(key, generation, this.run(
				retryEffect,
				emit,
				{ forceNewSession: false, sessionAttempt: 0, resumePrompt: buildRejectPrompt(effect) },
				generation,
			).catch((error: unknown) => this.handleRunFailure(key, generation, retryEffect, emit, error)));
			return;
		}

		const generation = this.generations.next(key);
		const runOptions: RunOptions =
			effect.onReject === "restart"
				? {
						forceNewSession: true,
						sessionAttempt: effect.validationAttempts,
						...(effect.reason === undefined ? {} : { rejectReason: effect.reason }),
					}
				: { forceNewSession: false, sessionAttempt: 0, resumePrompt: buildRejectPrompt(effect) };
		this.launch(key, generation, this.run(retryEffect, emit, runOptions, generation)
			.catch((error: unknown) => this.handleRunFailure(key, generation, retryEffect, emit, error)));
	}

	async steer(actionKey: string, invokeSeqId: number, message: string): Promise<boolean> {
		if (this.disposed) return false;
		const live = this.live.get(actionKey);
		if (live === undefined || effectInvokeSeqId(live.effect.id) !== invokeSeqId) return false;
		await live.session.steer(message);
		return true;
	}

	cancel(actionUid: ActionUID): Promise<void> {
		if (this.disposed) return this.disposal ?? Promise.resolve();
		const key = actionUidKey(actionUid);
		const existing = this.cancellations.get(key);
		if (existing !== undefined) return existing;
		const generation = this.generations.current(key);
		if (generation === undefined) return Promise.resolve();
		this.generations.markCancelled(key, generation);
		const live = this.live.get(key);
		if (live !== undefined) {
			this.live.delete(key);
			live.unsubscribeProgress?.();
			this.updateProgress(live.effect, { status: "cancelled", completedAt: Date.now() });
		}
		const run = this.runs.get(key)?.get(generation);
		const cancellation = (async () => {
			if (live !== undefined) await live.session.abort().finally(() => live.session.dispose());
			await run;
		})();
		this.cancellations.set(key, cancellation);
		const clearCancellation = () => {
			if (this.cancellations.get(key) === cancellation) this.cancellations.delete(key);
		};
		void cancellation.then(clearCancellation, clearCancellation);
		return cancellation;
	}

	dispose(): Promise<void> {
		if (this.disposal !== undefined) return this.disposal;
		this.disposed = true;
		this.disposal = this.disposeTrackedWork();
		return this.disposal;
	}

	private async disposeTrackedWork(): Promise<void> {
		for (const [key, runs] of this.runs) {
			for (const generation of runs.keys()) this.generations.markCancelled(key, generation);
		}
		const cleanup = [...this.live.entries()].map(([key, live]) => {
			this.generations.markCancelled(key, live.generation);
			try {
				live.unsubscribeProgress?.();
			} catch (error) {
				this.cleanupFailures.push(error);
			}
			try {
				this.updateProgress(live.effect, { status: "cancelled", completedAt: Date.now() });
			} catch (error) {
				this.cleanupFailures.push(error);
			}
			return this.cleanupSession(live.session);
		});
		const pending = [
			...cleanup,
			...[...this.runs.values()].flatMap((runs) => [...runs.values()]),
			...this.cancellations.values(),
			...this.cleanupTasks,
		];
		const results = await Promise.allSettled(pending);
		const failures = [
			...results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason),
			...this.cleanupFailures,
		];
		try {
			await this.options.sessionService?.close();
		} catch (error) {
			failures.push(error);
		}
		this.live.clear();
		this.runs.clear();
		this.cancellations.clear();
		this.cleanupTasks.clear();
		this.cleanupFailures.length = 0;
		if (failures.length > 0) throw new AggregateError(failures, "Failed to dispose Pi agent executor cleanly");
	}

	private launch(key: string, generation: number, run: Promise<void>): void {
		let runs = this.runs.get(key);
		if (runs === undefined) {
			runs = new Map();
			this.runs.set(key, runs);
		}
		const tracked = run.finally(() => {
			const current = this.runs.get(key);
			if (current?.get(generation) !== tracked) return;
			current.delete(generation);
			if (current.size === 0) this.runs.delete(key);
		});
		runs.set(generation, tracked);
		void tracked;
	}

	private async run(
		effect: AgentEffect,
		emit: EmitCompletion,
		runOptions: RunOptions,
		generation: number,
	): Promise<void> {
		const key = actionUidKey(effect.actionUid);
		if (this.isStopped(key, generation)) return;
		this.updateProgress(effect, {
			actionName: effect.action.name,
			status: "starting",
			startedAt: Date.now(),
			role: undefined,
			model: undefined,
			thinking: undefined,
			toolset: undefined,
			tools: undefined,
			currentTool: undefined,
			currentToolArgs: undefined,
			currentToolStartedAt: undefined,
			error: undefined,
		});
		const definition = loadAgentDefinition(effect.action.name, this.definitionDirs);
		if (this.isStopped(key, generation)) return;
		// Validate every declared read before selecting or opening any restored session. A resumed
		// session must not bypass the local-artifact/URL boundary that a fresh run enforces.
		const reads = await resolveReads(effect, this.options.workDir, this.options.schemaRegistry);
		if (this.isStopped(key, generation)) return;
		const dir = actionSessionDir(this.options.sessionsDir, this.options.branchId, effect);
		const latest =
			this.options.sessionService === undefined
				? latestSessionForRunOptions(this.options.sessionsDir, this.options.branchId, dir, effect, runOptions)
				: undefined;
		const sink: CompletionSink = { captured: undefined };
		const session = await this.createSession(
			effect,
			definition,
			dir,
			latest,
			runOptions,
			sink,
			() => this.isStopped(key, generation),
		);
		if (session === undefined) return;
		if (this.isStopped(key, generation)) {
			await this.cleanupSession(session);
			return;
		}
		const live: LiveAgent = { session, effect, sink, generation };
		live.unsubscribeProgress = this.attachProgress(session, effect, definition);
		if (this.isStopped(key, generation)) {
			live.unsubscribeProgress();
			await this.cleanupSession(session);
			return;
		}
		this.live.set(key, live);

		const restored = this.sessionHandles.get(session)?.restored ?? latest !== undefined;
		if (restored && shouldRecoverRestoredFinish(runOptions)) {
			const captured = await findCapturedFinish(session.messages, effect, this.options.schemaRegistry);
			if (this.isStopped(key, generation)) return;
			if (captured !== undefined) {
				sink.captured = captured;
				await this.acceptanceLoop(key, generation, emit, live);
				return;
			}
		}
		if (restored) {
			await this.promptAndAccept(key, generation, emit, live, runOptions.resumePrompt ?? buildResumePrompt(effect));
			return;
		}

		const taskPrompt = [
			runOptions.resumePrompt,
			runOptions.rejectReason === undefined
				? undefined
				: `Previous validation attempt was rejected. Reason: ${runOptions.rejectReason}. Start fresh and fix it.`,
			buildTaskPrompt(effect, reads),
		]
			.filter((part): part is string => part !== undefined)
			.join("\n\n");
		await this.promptAndAccept(key, generation, emit, live, taskPrompt);
	}

	private async createSession(
		effect: AgentEffect,
		definition: AgentDefinition,
		dir: string,
		latest: string | undefined,
		runOptions: RunOptions,
		sink: CompletionSink,
		isStopped: () => boolean,
	): Promise<AgentSession | undefined> {
		const plan = buildSessionPlan(definition, effect, {
			...(this.options.defaultModel === undefined ? {} : { defaultModel: this.options.defaultModel }),
			...(this.options.modelRoles === undefined ? {} : { modelRoles: this.options.modelRoles }),
			...(this.options.toolsets === undefined ? {} : { toolsets: this.options.toolsets }),
		});
		const overrides = await this.options.resolveSessionOverrides?.({
			branchId: this.options.branchId,
			actionUid: effect.actionUid,
			agentName: definition.name,
			...(definition.role === undefined ? {} : { declaredRole: definition.role }),
			...(definition.toolset === undefined ? {} : { declaredToolset: definition.toolset }),
		});
		if (isStopped()) return undefined;
		const modelRef = overrides?.model ?? plan.modelRef;
		const tools = overrides?.tools ?? plan.tools;
		const invocationSystemPrompt = [
			definition.systemPrompt,
			overrides?.appendSystemPrompt,
			workspaceContextNote(this.options.projectDir ?? this.options.workDir, this.options.workDir),
		]
			.filter((part): part is string => part !== undefined && part.trim().length > 0)
			.join("\n\n");
		const model = modelRef === undefined ? undefined : resolveModel(this.options.modelRuntime, modelRef);
		const resourceLoader = new DefaultResourceLoader({
			cwd: this.options.workDir,
			agentDir: this.agentDir,
			...(plan.promptMode === "append"
				? { appendSystemPromptOverride: (base: string[]) => [...base, invocationSystemPrompt] }
				: {
						systemPromptOverride: () => invocationSystemPrompt,
						appendSystemPromptOverride: () => [],
					}),
		});
		await resourceLoader.reload();
		if (isStopped()) return undefined;
		const invokeSeqId = effectInvokeSeqId(effect.id);
		let sessionHandle: PiSessionHandle | undefined;
		if (this.options.sessionService !== undefined) {
			if (invokeSeqId === undefined) throw new Error(`Agent effect ${effect.id} has no durable invoke sequence`);
			sessionHandle = await this.options.sessionService.openOrCreate(
				sessionIdForAttempt(effect.sessionId, runOptions.sessionAttempt),
			);
		}
		if (isStopped()) {
			await sessionHandle?.close();
			return undefined;
		}
		const sessionManager =
			sessionHandle?.manager ??
			(latest === undefined
				? SessionManager.create(this.options.workDir, dir, {
						id: sessionIdForAttempt(effect.sessionId, runOptions.sessionAttempt),
					  })
				: SessionManager.open(latest, dir, this.options.workDir));
		const { session } = await createAgentSession({
			cwd: this.options.workDir,
			agentDir: this.agentDir,
			modelRuntime: this.options.modelRuntime,
			...(model === undefined ? {} : { model }),
			...(plan.thinkingLevel === undefined ? {} : { thinkingLevel: plan.thinkingLevel }),
			...(tools === undefined ? {} : { tools }),
			customTools: createInvocationCustomTools(
				effect,
				sink,
				this.options.schemaRegistry,
				overrides?.customTools,
			),
			resourceLoader,
			sessionManager,
		});
		if (sessionHandle !== undefined) this.sessionHandles.set(session, sessionHandle);
		if (isStopped()) {
			await this.cleanupSession(session);
			return undefined;
		}
		const sessionFile = session.sessionManager.getSessionFile();
		this.updateProgress(effect, {
			actionName: definition.name,
			status: "running",
			sessionId: sessionManager.getSessionId(),
			sessionAttempt: runOptions.sessionAttempt,
			...(sessionFile === undefined ? {} : { sessionFile }),
			...(definition.role === undefined ? {} : { role: definition.role }),
			...(modelRef === undefined ? {} : { model: modelRef }),
			...(plan.thinkingLevel === undefined ? {} : { thinking: plan.thinkingLevel }),
			...(definition.toolset === undefined ? {} : { toolset: definition.toolset }),
			...(tools === undefined ? {} : { tools }),
		});
		return session;
	}

	private async promptAndAccept(
		key: string,
		generation: number,
		emit: EmitCompletion,
		live: LiveAgent,
		prompt: string,
	): Promise<void> {
		if (this.isStopped(key, generation)) return;
		await live.session.prompt(prompt);
		await this.sessionHandles.get(live.session)?.drain();
		if (this.isStopped(key, generation)) return;
		await this.acceptanceLoop(key, generation, emit, live);
	}

	private async acceptanceLoop(key: string, generation: number, emit: EmitCompletion, live: LiveAgent): Promise<void> {
		await runAcceptanceLoop({
			effect: live.effect,
			sink: live.sink,
			maxRetries: this.maxFinishRetries,
			isCancelled: () => this.generations.isCancelled(key, generation),
			prompt: async (text) => {
				if (this.isStopped(key, generation)) return;
				await live.session.prompt(text);
				await this.sessionHandles.get(live.session)?.drain();
			},
			lastAssistantText: () => lastAssistantText(live.session.messages),
			lastAssistantError: () => lastAssistantError(live.session.messages),
			checkArtifacts: () => checkEffectArtifacts(live.effect, this.options.workDir, this.options.schemaRegistry),
			emit: (event) => {
				if (!this.generations.isCancelled(key, generation) && event.type === "FAILED") {
					this.markProgressFailed(
						live.effect,
						"error" in event && typeof event.error === "string" ? event.error : "agent failed",
					);
				}
				this.safeEmit(key, generation, emit, event);
			},
		});
	}

	private attachProgress(session: AgentSession, effect: AgentEffect, definition: AgentDefinition): () => void {
		let turnCount = 0;
		let toolCount = 0;
		let tokenCount = 0;
		const stream = createThrottledProgressWriter(this.options.sessionsDir, effect.actionUid, definition.name, effect.id, this.options.branchId);
		const clearStreamFields = { currentText: undefined, currentReasoning: undefined };
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "turn_start") {
				turnCount++;
				stream.reset();
				this.updateProgress(effect, {
					actionName: definition.name,
					status: "running",
					turnCount,
					...clearStreamFields,
				});
				return;
			}
			if (event.type === "message_update") {
				if (event.assistantMessageEvent.type === "text_delta") stream.appendText(event.assistantMessageEvent.delta);
				if (event.assistantMessageEvent.type === "thinking_delta") {
					stream.appendReasoning(event.assistantMessageEvent.delta);
				}
				return;
			}
			if (event.type === "tool_execution_start") {
				toolCount++;
				this.updateProgress(effect, {
					actionName: definition.name,
					status: "running",
					toolCount,
					currentTool: event.toolName,
					currentToolArgs: stringifyToolArgs(event.args),
					currentToolStartedAt: Date.now(),
				});
				return;
			}
			if (event.type === "tool_execution_end") {
				this.updateProgress(effect, {
					actionName: definition.name,
					status: "running",
					toolCount,
					currentTool: undefined,
					currentToolArgs: undefined,
					currentToolStartedAt: undefined,
					...(event.isError ? { error: `${event.toolName} failed` } : { error: undefined }),
				});
				return;
			}
			if (event.type === "message_end") {
				tokenCount += usageTokens(event.message);
				stream.reset();
				this.updateProgress(effect, {
					actionName: definition.name,
					status: "running",
					...clearStreamFields,
					lastMessage: messagePreview(event.message),
					...(tokenCount > 0 ? { tokenCount } : {}),
				});
				return;
			}
			if (event.type === "agent_end") {
				stream.reset();
				this.updateProgress(effect, {
					actionName: definition.name,
					status: event.willRetry ? "running" : "completed",
					completedAt: event.willRetry ? undefined : Date.now(),
					currentTool: undefined,
					currentToolArgs: undefined,
					currentToolStartedAt: undefined,
					...clearStreamFields,
				});
			}
		});
		return () => {
			stream.dispose();
			unsubscribe();
		};
	}

	private updateProgress(effect: AgentEffect, patch: Parameters<typeof updateSessionProgress>[2]): void {
		updateSessionProgress(this.options.sessionsDir, effect.actionUid, patch, effect.id, this.options.branchId);
	}

	private markProgressFailed(effect: AgentEffect, error: string): void {
		this.updateProgress(effect, { status: "failed", error, completedAt: Date.now() });
	}

	private isStopped(key: string, generation: number): boolean {
		return this.disposed || this.generations.isCancelled(key, generation);
	}

	private handleRunFailure(
		key: string,
		generation: number,
		effect: AgentEffect,
		emit: EmitCompletion,
		error: unknown,
	): void {
		if (this.disposed && error instanceof SessionCleanupError) this.cleanupFailures.push(error);
		if (!this.isStopped(key, generation)) this.markProgressFailed(effect, errorMessage(error));
		this.safeEmit(key, generation, emit, { type: "FAILED", error: errorMessage(error) });
	}

	private trackCleanup(cleanup: Promise<void>): void {
		const tracked = cleanup.finally(() => this.cleanupTasks.delete(tracked));
		this.cleanupTasks.add(tracked);
		void tracked.catch((error: unknown) => this.cleanupFailures.push(error));
	}

	private async disposeSession(session: AgentSession): Promise<void> {
		const failures: unknown[] = [];
		try {
			session.dispose();
		} catch (error) {
			failures.push(error);
		}
		try {
			await this.sessionHandles.get(session)?.close();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length > 0) throw new SessionCleanupError(failures, "Failed to dispose Pi agent session");
	}

	private async cleanupSession(session: AgentSession): Promise<void> {
		const failures: unknown[] = [];
		try {
			await session.abort();
		} catch (error) {
			failures.push(error);
		}
		try {
			session.dispose();
		} catch (error) {
			failures.push(error);
		}
		try {
			await this.sessionHandles.get(session)?.close();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length > 0) throw new SessionCleanupError(failures, "Failed to clean up Pi agent session");
	}

	private safeEmit(key: string, generation: number, emit: EmitCompletion, event: ChartEvent): void {
		if (!this.isStopped(key, generation)) emit(event);
	}
}

function rejectedAgentInvocation(effect: RejectedEffect): AgentEffect | undefined {
	return effect.invocation.kind === "agent" ? { ...effect.invocation, id: effect.id } : undefined;
}

export async function findCapturedFinish(
	messages: readonly unknown[],
	effect: AgentEffect,
	registry?: SchemaRegistry,
): Promise<ChartEvent | undefined> {
	let lastUser = -1;
	messages.forEach((message, index) => {
		if (isRecord(message) && message.role === "user") lastUser = index;
	});
	const calls = new Map<string, unknown>();
	let captured: ChartEvent | undefined;
	for (const message of messages.slice(lastUser + 1)) {
		if (!isRecord(message)) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const item of message.content) {
				if (isRecord(item) && item.type === "toolCall" && item.name === "finish" && typeof item.id === "string") {
					calls.set(item.id, item.arguments);
				}
			}
		}
		if (
			message.role === "toolResult" &&
			message.toolName === "finish" &&
			message.isError === false &&
			typeof message.toolCallId === "string" &&
			calls.has(message.toolCallId)
		) {
			const params = calls.get(message.toolCallId) as { event?: unknown; output?: unknown };
			const result = await validateFinishParams(effect, params, registry);
			if (result.ok) captured = result.event;
		}
	}
	return captured;
}

function resolveModel(modelRuntime: ModelRuntime, modelRef: string) {
	const [provider, ...rest] = modelRef.split("/");
	const modelId = rest.join("/");
	if (!provider || !modelId) {
		throw new Error(`Model '${modelRef}' must be in provider/model-id format`);
	}
	const model = modelRuntime.getModel(provider, modelId);
	if (model === undefined) {
		throw new Error(`Model '${modelRef}' was not found in the model registry`);
	}
	return model;
}

function latestSessionForRunOptions(
	sessionsDir: string,
	branchId: string,
	dir: string,
	effect: AgentEffect,
	runOptions: RunOptions,
): string | undefined {
	if (runOptions.forceNewSession) return undefined;
	if (runOptions.resumeSessionFile !== undefined && existsSync(runOptions.resumeSessionFile)) {
		return runOptions.resumeSessionFile;
	}
	if (runOptions.resumePrompt !== undefined) {
		return latestJsonlForPreviousActionSession(sessionsDir, branchId, effect);
	}
	return latestJsonl(dir);
}

function latestJsonl(dir: string): string | undefined {
	if (!existsSync(dir)) return undefined;
	return readdirSync(dir)
		.filter((file) => file.endsWith(".jsonl"))
		.map((file) => join(dir, file))
		.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

function latestJsonlForPreviousActionSession(sessionsDir: string, branchId: string, effect: AgentEffect): string | undefined {
	const root = join(sessionsDir, branchSessionSegment(branchId), actionUidDirName(effect.actionUid));
	if (!existsSync(root)) return undefined;
	const currentKey = sanitizeSegment(sessionKey(effect.id));
	const candidates: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === currentKey) continue;
		const dir = join(root, entry.name);
		for (const file of readdirSync(dir)) {
			if (file.endsWith(".jsonl")) candidates.push(join(dir, file));
		}
	}
	return candidates.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function usageTokens(message: unknown): number {
	if (!isRecord(message) || !isRecord(message.usage)) return 0;
	const usage = message.usage;
	if (typeof usage.totalTokens === "number") return usage.totalTokens;
	const input =
		typeof usage.input === "number" ? usage.input : typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
	const output =
		typeof usage.output === "number" ? usage.output : typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
	const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
	const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
	return input + output + cacheRead + cacheWrite;
}

export function lastAssistantError(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "assistant") continue;
		if (message.stopReason !== "error") return undefined;
		return typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0
			? message.errorMessage
			: "agent provider/runtime error";
	}
	return undefined;
}

function lastAssistantText(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "assistant") continue;
		const text = messageText(message);
		if (text !== undefined) return text;
	}
	return undefined;
}

function messagePreview(message: unknown): string | undefined {
	const text = messageText(message);
	if (text === undefined) return undefined;
	return previewText(text);
}

function messageText(message: unknown): string | undefined {
	if (!isRecord(message)) return undefined;
	const content = message.content;
	let text: string | undefined;
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		text = content
			.map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : undefined))
			.filter((item): item is string => item !== undefined)
			.join(" ");
	}
	if (text === undefined) return undefined;
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length === 0 ? undefined : compact;
}
