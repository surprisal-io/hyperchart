import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { actionUidDirName, actionUidKey, sanitizeSegment } from "@surprisal/hyperchart/internal/core/action_uid";
import type { ActionUID, ChartEvent } from "@surprisal/hyperchart/internal/core/types";
import type { AgentEffect, RejectedEffect } from "@surprisal/hyperchart/internal/core/machine";
import { errorMessage } from "@surprisal/hyperchart/internal/utils/errors";
import type { AgentExecutor, EmitCompletion, SessionPlan } from "@surprisal/hyperchart/runtime";
import type { SchemaRegistryLike as SchemaRegistry } from "@surprisal/hyperchart/internal/core/schema_registry";
import {
	GenerationTracker,
	actionSessionDir,
	buildRejectPrompt,
	buildResumePrompt,
	buildSessionPlan,
	buildTaskPrompt,
	checkEffectArtifacts,
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

export type PiExecutorOptions = {
	workDir: string;
	agentDir?: string;
	definitionDirs?: string[];
	sessionsDir: string;
	modelRuntime: ModelRuntime;
	defaultModel?: string;
	modelRoles?: Record<string, string>;
	toolsets?: Record<string, string[]>;
	maxFinishRetries?: number;
	schemaRegistry?: SchemaRegistry;
};

type LiveAgent = {
	session: AgentSession;
	effect: AgentEffect;
	sink: CompletionSink;
	generation: number;
	unsubscribeProgress?: () => void;
};

type RunOptions = {
	forceNewSession: boolean;
	resumePrompt?: string;
	rejectReason?: string;
	resumeSessionFile?: string;
};

export class PiAgentExecutor implements AgentExecutor {
	private readonly live = new Map<string, LiveAgent>();
	private readonly runs = new Map<string, Map<number, Promise<void>>>();
	private readonly cancellations = new Map<string, Promise<void>>();
	private readonly generations = new GenerationTracker();
	private readonly agentDir: string;
	private readonly definitionDirs: string[];
	private readonly maxFinishRetries: number;

	constructor(private readonly options: PiExecutorOptions) {
		this.agentDir = options.agentDir ?? getAgentDir();
		this.definitionDirs = options.definitionDirs ?? resolvePiSubagentDefinitionDirs(options.workDir, this.agentDir);
		this.maxFinishRetries = options.maxFinishRetries ?? 2;
	}

	start(effect: AgentEffect, emit: EmitCompletion): void {
		const key = actionUidKey(effect.actionUid);
		const generation = this.generations.next(key);
		this.launch(key, generation, this.run(
			effect,
			emit,
			{
				forceNewSession: false,
				...(effect.resume === undefined
					? {}
					: { resumePrompt: effect.resume.message, resumeSessionFile: effect.resume.session }),
			},
			generation,
		).catch((error: unknown) => {
			if (!this.generations.isCancelled(key, generation)) this.markProgressFailed(effect, errorMessage(error));
			this.safeEmit(key, generation, emit, { type: "FAILED", error: errorMessage(error) });
		}));
	}

	reject(effect: RejectedEffect, emit: EmitCompletion): void {
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
				void live.session.abort().finally(() => live.session.dispose());
				const generation = this.generations.next(key);
				this.launch(key, generation, this.run(
					retryEffect,
					emit,
					{ forceNewSession: true, ...(effect.reason === undefined ? {} : { rejectReason: effect.reason }) },
					generation,
				).catch((error: unknown) => {
					if (!this.generations.isCancelled(key, generation)) this.markProgressFailed(retryEffect, errorMessage(error));
					this.safeEmit(key, generation, emit, { type: "FAILED", error: errorMessage(error) });
				}));
				return;
			}

			live.session.dispose();
			const generation = this.generations.next(key);
			this.launch(key, generation, this.run(
				retryEffect,
				emit,
				{ forceNewSession: false, resumePrompt: buildRejectPrompt(effect) },
				generation,
			).catch((error: unknown) => {
				if (!this.generations.isCancelled(key, generation)) this.markProgressFailed(retryEffect, errorMessage(error));
				this.safeEmit(key, generation, emit, { type: "FAILED", error: errorMessage(error) });
			}));
			return;
		}

		const generation = this.generations.next(key);
		const runOptions: RunOptions =
			effect.onReject === "restart"
				? { forceNewSession: true, ...(effect.reason === undefined ? {} : { rejectReason: effect.reason }) }
				: { forceNewSession: false, resumePrompt: buildRejectPrompt(effect) };
		this.launch(key, generation, this.run(retryEffect, emit, runOptions, generation).catch((error: unknown) => {
			if (!this.generations.isCancelled(key, generation)) this.markProgressFailed(retryEffect, errorMessage(error));
			this.safeEmit(key, generation, emit, { type: "FAILED", error: errorMessage(error) });
		}));
	}

	async steer(actionKey: string, message: string): Promise<boolean> {
		const live = this.live.get(actionKey);
		if (live === undefined) return false;
		await live.session.steer(message);
		return true;
	}

	cancel(actionUid: ActionUID): Promise<void> {
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

	async dispose(): Promise<void> {
		await Promise.all(
			[...this.live.entries()].map(async ([key, live]) => {
				this.generations.markCancelled(key, live.generation);
				live.unsubscribeProgress?.();
				this.updateProgress(live.effect, {
					status: "cancelled",
					completedAt: Date.now(),
				});
				await live.session.abort().catch(() => undefined);
				live.session.dispose();
			}),
		);
		this.live.clear();
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
		// Validate every declared read before selecting or opening any restored session. A resumed
		// session must not bypass the local-artifact/URL boundary that a fresh run enforces.
		const reads = await resolveReads(effect, this.options.workDir, this.options.schemaRegistry);
		const dir = actionSessionDir(this.options.sessionsDir, effect);
		const latest = latestSessionForRunOptions(this.options.sessionsDir, dir, effect, runOptions);
		const sink: CompletionSink = { captured: undefined };
		const session = await this.createSession(effect, definition, dir, latest, sink);
		if (this.generations.isCancelled(key, generation)) {
			await session.abort().catch(() => undefined);
			session.dispose();
			return;
		}
		const live: LiveAgent = { session, effect, sink, generation };
		live.unsubscribeProgress = this.attachProgress(session, effect, definition);
		this.live.set(key, live);

		if (latest !== undefined && shouldRecoverRestoredFinish(runOptions)) {
			const captured = await findCapturedFinish(session.messages, effect, this.options.schemaRegistry);
			if (captured !== undefined) {
				sink.captured = captured;
				await this.acceptanceLoop(key, generation, emit, live);
				return;
			}
		}
		if (latest !== undefined) {
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
		sink: CompletionSink,
	): Promise<AgentSession> {
		const plan = buildSessionPlan(definition, effect, {
			...(this.options.defaultModel === undefined ? {} : { defaultModel: this.options.defaultModel }),
			...(this.options.modelRoles === undefined ? {} : { modelRoles: this.options.modelRoles }),
			...(this.options.toolsets === undefined ? {} : { toolsets: this.options.toolsets }),
		});
		const model = plan.modelRef === undefined ? undefined : resolveModel(this.options.modelRuntime, plan.modelRef);
		const resourceLoader = new DefaultResourceLoader({
			cwd: this.options.workDir,
			agentDir: this.agentDir,
			...(plan.promptMode === "append"
				? { appendSystemPromptOverride: (base: string[]) => [...base, definition.systemPrompt] }
				: {
						systemPromptOverride: () => definition.systemPrompt,
						appendSystemPromptOverride: () => [],
					}),
		});
		await resourceLoader.reload();
		const sessionManager =
			latest === undefined
				? SessionManager.create(this.options.workDir, dir)
				: SessionManager.open(latest, dir, this.options.workDir);
		const { session } = await createAgentSession({
			cwd: this.options.workDir,
			agentDir: this.agentDir,
			modelRuntime: this.options.modelRuntime,
			...(model === undefined ? {} : { model }),
			...(plan.thinkingLevel === undefined ? {} : { thinkingLevel: plan.thinkingLevel }),
			...(plan.tools === undefined ? {} : { tools: plan.tools }),
			customTools: [createFinishTool(effect, sink, this.options.schemaRegistry)],
			resourceLoader,
			sessionManager,
		});
		const sessionFile = session.sessionManager.getSessionFile();
		this.updateProgress(effect, {
			actionName: definition.name,
			status: "running",
			...(sessionFile === undefined ? {} : { sessionFile }),
			...(definition.role === undefined ? {} : { role: definition.role }),
			...(plan.modelRef === undefined ? {} : { model: plan.modelRef }),
			...(plan.thinkingLevel === undefined ? {} : { thinking: plan.thinkingLevel }),
			...(definition.toolset === undefined ? {} : { toolset: definition.toolset }),
			...(plan.tools === undefined ? {} : { tools: plan.tools }),
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
		await live.session.prompt(prompt);
		await this.acceptanceLoop(key, generation, emit, live);
	}

	private async acceptanceLoop(key: string, generation: number, emit: EmitCompletion, live: LiveAgent): Promise<void> {
		await runAcceptanceLoop({
			effect: live.effect,
			sink: live.sink,
			maxRetries: this.maxFinishRetries,
			isCancelled: () => this.generations.isCancelled(key, generation),
			prompt: (text) => live.session.prompt(text),
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
		const stream = createThrottledProgressWriter(this.options.sessionsDir, effect.actionUid, definition.name, effect.id);
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
		updateSessionProgress(this.options.sessionsDir, effect.actionUid, patch, effect.id);
	}

	private markProgressFailed(effect: AgentEffect, error: string): void {
		this.updateProgress(effect, { status: "failed", error, completedAt: Date.now() });
	}

	private safeEmit(key: string, generation: number, emit: EmitCompletion, event: ChartEvent): void {
		if (!this.generations.isCancelled(key, generation)) {
			emit(event);
		}
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
	dir: string,
	effect: AgentEffect,
	runOptions: RunOptions,
): string | undefined {
	if (runOptions.forceNewSession) return undefined;
	if (runOptions.resumeSessionFile !== undefined && existsSync(runOptions.resumeSessionFile)) {
		return runOptions.resumeSessionFile;
	}
	if (runOptions.resumePrompt !== undefined) {
		return latestJsonlForPreviousActionSession(sessionsDir, effect);
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

function latestJsonlForPreviousActionSession(sessionsDir: string, effect: AgentEffect): string | undefined {
	const root = join(sessionsDir, actionUidDirName(effect.actionUid));
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
