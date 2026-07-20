import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
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
import type { AgentExecutor, EmitCompletion } from "@surprisal/hyperchart/runtime";
import type { SchemaRegistryLike as SchemaRegistry } from "@surprisal/hyperchart/internal/core/schema_registry";
import { checkArtifactFile, resolveArtifactValue } from "@surprisal/hyperchart/runtime";
import {
	loadAgentDefinition,
	resolvePiSubagentDefinitionDirs,
	type AgentDefinition,
	type ThinkingLevel,
} from "./agent_definitions.js";
import { createFinishTool, type CompletionSink, validateFinishParams } from "./finish_tool.js";
import {
	buildArtifactFeedbackPrompt,
	buildNudgePrompt,
	buildRejectPrompt,
	buildResumePrompt,
	buildTaskPrompt,
	type ResolvedRead,
} from "./prompts.js";
import { updateSessionProgress } from "./session_progress.js";

export type PiExecutorOptions = {
	workDir: string;
	agentDir?: string;
	definitionDirs?: string[];
	sessionsDir: string;
	modelRuntime: ModelRuntime;
	defaultModel?: string;
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

export type SessionPlan = {
	modelRef?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	promptMode: "replace" | "append";
};

export class PiAgentExecutor implements AgentExecutor {
	private readonly live = new Map<string, LiveAgent>();
	private readonly generations = new Map<string, number>();
	private readonly cancelled = new Set<string>();
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
		const generation = this.nextGeneration(key);
		void this.run(
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
			this.markProgressFailed(effect.actionUid, errorMessage(error));
			this.safeEmit(key, generation, emit, { type: "FAILED", error: errorMessage(error) });
		});
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
			this.markCancelled(key, live.generation);
			live.unsubscribeProgress?.();
			this.live.delete(key);
			if (effect.onReject === "restart") {
				void live.session.abort().finally(() => live.session.dispose());
				const generation = this.nextGeneration(key);
				void this.run(
					retryEffect,
					emit,
					{ forceNewSession: true, ...(effect.reason === undefined ? {} : { rejectReason: effect.reason }) },
					generation,
				).catch((error: unknown) => {
					this.markProgressFailed(retryEffect.actionUid, errorMessage(error));
					this.safeEmit(key, generation, emit, { type: "FAILED", error: errorMessage(error) });
				});
				return;
			}

			live.session.dispose();
			const generation = this.nextGeneration(key);
			void this.run(
				retryEffect,
				emit,
				{ forceNewSession: false, resumePrompt: buildRejectPrompt(effect) },
				generation,
			).catch((error: unknown) => {
				this.markProgressFailed(retryEffect.actionUid, errorMessage(error));
				this.safeEmit(key, generation, emit, { type: "FAILED", error: errorMessage(error) });
			});
			return;
		}

		const generation = this.nextGeneration(key);
		const runOptions: RunOptions =
			effect.onReject === "restart"
				? { forceNewSession: true, ...(effect.reason === undefined ? {} : { rejectReason: effect.reason }) }
				: { forceNewSession: false, resumePrompt: buildRejectPrompt(effect) };
		void this.run(retryEffect, emit, runOptions, generation).catch((error: unknown) => {
			this.markProgressFailed(retryEffect.actionUid, errorMessage(error));
			this.safeEmit(key, generation, emit, { type: "FAILED", error: errorMessage(error) });
		});
	}

	cancel(actionUid: ActionUID): void {
		const key = actionUidKey(actionUid);
		const generation = this.generations.get(key);
		if (generation !== undefined) this.markCancelled(key, generation);
		const live = this.live.get(key);
		if (live === undefined) return;
		this.live.delete(key);
		live.unsubscribeProgress?.();
		updateSessionProgress(this.options.sessionsDir, actionUid, { status: "cancelled", completedAt: Date.now() });
		void live.session.abort().finally(() => live.session.dispose());
	}

	async dispose(): Promise<void> {
		await Promise.all(
			[...this.live.entries()].map(async ([key, live]) => {
				this.markCancelled(key, live.generation);
				live.unsubscribeProgress?.();
				updateSessionProgress(this.options.sessionsDir, live.effect.actionUid, {
					status: "cancelled",
					completedAt: Date.now(),
				});
				await live.session.abort().catch(() => undefined);
				live.session.dispose();
			}),
		);
		this.live.clear();
	}

	private async run(
		effect: AgentEffect,
		emit: EmitCompletion,
		runOptions: RunOptions,
		generation: number,
	): Promise<void> {
		const key = actionUidKey(effect.actionUid);
		updateSessionProgress(this.options.sessionsDir, effect.actionUid, {
			actionName: effect.action.name,
			status: "starting",
			startedAt: Date.now(),
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
		if (this.isCancelled(key, generation)) {
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
		const plan = buildSessionPlan(
			definition,
			effect,
			this.options.defaultModel === undefined ? {} : { defaultModel: this.options.defaultModel },
		);
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
		updateSessionProgress(this.options.sessionsDir, effect.actionUid, {
			actionName: definition.name,
			status: "running",
			...(sessionFile === undefined ? {} : { sessionFile }),
			...(plan.modelRef === undefined ? {} : { model: plan.modelRef }),
			...(plan.thinkingLevel === undefined ? {} : { thinking: plan.thinkingLevel }),
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
		let remaining = this.maxFinishRetries;
		while (!this.isCancelled(key, generation)) {
			if (live.sink.captured === undefined) {
				if (remaining-- <= 0) {
					this.safeEmit(key, generation, emit, { type: "FAILED", error: "agent did not produce a valid completion" });
					return;
				}
				await live.session.prompt(buildNudgePrompt(live.effect, lastAssistantText(live.session.messages)));
				continue;
			}
			if (live.sink.captured.type !== "FAILED") {
				const artifactErrors = await this.checkArtifacts(live.effect);
				if (artifactErrors.length > 0) {
					live.sink.captured = undefined;
					if (remaining-- <= 0) {
						this.safeEmit(key, generation, emit, {
							type: "FAILED",
							error: `agent did not produce valid deliverables: ${artifactErrors.join("; ")}`,
						});
						return;
					}
					await live.session.prompt(buildArtifactFeedbackPrompt(artifactErrors));
					continue;
				}
			}
			this.safeEmit(key, generation, emit, live.sink.captured);
			return;
		}
	}

	private async checkArtifacts(effect: AgentEffect): Promise<string[]> {
		const errors: string[] = [];
		for (const artifact of effect.artifacts ?? []) {
			const check = await checkArtifactFile(artifact, this.options.workDir, this.options.schemaRegistry);
			if (!check.ok) errors.push(...check.errors);
		}
		return errors;
	}

	private attachProgress(session: AgentSession, effect: AgentEffect, definition: AgentDefinition): () => void {
		let turnCount = 0;
		let toolCount = 0;
		let tokenCount = 0;
		let currentText = "";
		let currentReasoning = "";
		let lastStreamWrite = 0;
		let streamTimer: NodeJS.Timeout | undefined;
		const clearStreamTimer = () => {
			if (streamTimer !== undefined) clearTimeout(streamTimer);
			streamTimer = undefined;
		};
		const publishStream = () => {
			clearStreamTimer();
			lastStreamWrite = Date.now();
			updateSessionProgress(this.options.sessionsDir, effect.actionUid, {
				actionName: definition.name,
				status: "running",
				currentText: currentText.length === 0 ? undefined : currentText.slice(-32_000),
				currentReasoning: currentReasoning.length === 0 ? undefined : currentReasoning.slice(-32_000),
			});
		};
		const scheduleStreamWrite = () => {
			const wait = 250 - (Date.now() - lastStreamWrite);
			if (wait <= 0) {
				publishStream();
				return;
			}
			if (streamTimer === undefined) {
				streamTimer = setTimeout(publishStream, wait);
				streamTimer.unref();
			}
		};
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "turn_start") {
				turnCount++;
				currentText = "";
				currentReasoning = "";
				clearStreamTimer();
				updateSessionProgress(this.options.sessionsDir, effect.actionUid, {
					actionName: definition.name,
					status: "running",
					turnCount,
					currentText: undefined,
					currentReasoning: undefined,
				});
				return;
			}
			if (event.type === "message_update") {
				if (event.assistantMessageEvent.type === "text_delta") currentText += event.assistantMessageEvent.delta;
				if (event.assistantMessageEvent.type === "thinking_delta") currentReasoning += event.assistantMessageEvent.delta;
				scheduleStreamWrite();
				return;
			}
			if (event.type === "tool_execution_start") {
				toolCount++;
				updateSessionProgress(this.options.sessionsDir, effect.actionUid, {
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
				updateSessionProgress(this.options.sessionsDir, effect.actionUid, {
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
				currentText = "";
				currentReasoning = "";
				clearStreamTimer();
				updateSessionProgress(this.options.sessionsDir, effect.actionUid, {
					actionName: definition.name,
					status: "running",
					currentText: undefined,
					currentReasoning: undefined,
					lastMessage: messagePreview(event.message),
					...(tokenCount > 0 ? { tokenCount } : {}),
				});
				return;
			}
			if (event.type === "agent_end") {
				currentText = "";
				currentReasoning = "";
				clearStreamTimer();
				updateSessionProgress(this.options.sessionsDir, effect.actionUid, {
					actionName: definition.name,
					status: event.willRetry ? "running" : "completed",
					completedAt: event.willRetry ? undefined : Date.now(),
					currentTool: undefined,
					currentToolArgs: undefined,
					currentToolStartedAt: undefined,
					currentText: undefined,
					currentReasoning: undefined,
				});
			}
		});
		return () => {
			clearStreamTimer();
			unsubscribe();
		};
	}

	private markProgressFailed(actionUid: ActionUID, error: string): void {
		updateSessionProgress(this.options.sessionsDir, actionUid, { status: "failed", error, completedAt: Date.now() });
	}

	private nextGeneration(key: string): number {
		const generation = (this.generations.get(key) ?? 0) + 1;
		this.generations.set(key, generation);
		this.cancelled.delete(generationKey(key, generation));
		return generation;
	}

	private markCancelled(key: string, generation: number): void {
		this.cancelled.add(generationKey(key, generation));
	}

	private isCancelled(key: string, generation: number): boolean {
		return this.cancelled.has(generationKey(key, generation)) || this.generations.get(key) !== generation;
	}

	private safeEmit(key: string, generation: number, emit: EmitCompletion, event: ChartEvent): void {
		if (!this.isCancelled(key, generation)) {
			emit(event);
		}
	}
}

export function shouldRecoverRestoredFinish(runOptions: Pick<RunOptions, "resumePrompt" | "rejectReason">): boolean {
	return runOptions.resumePrompt === undefined && runOptions.rejectReason === undefined;
}

function rejectedAgentInvocation(effect: RejectedEffect): AgentEffect | undefined {
	return effect.invocation.kind === "agent" ? { ...effect.invocation, id: effect.id } : undefined;
}

export function buildSessionPlan(
	definition: AgentDefinition,
	effect: AgentEffect,
	options: { defaultModel?: string } = {},
): SessionPlan {
	const modelRef = effect.action.model ?? definition.model ?? options.defaultModel;
	const thinkingLevel = (effect.action.thinking ?? definition.thinking) as ThinkingLevel | undefined;
	const tools = effect.action.tools ?? definition.tools;
	return {
		...(modelRef === undefined ? {} : { modelRef }),
		...(thinkingLevel === undefined ? {} : { thinkingLevel }),
		...(tools === undefined ? {} : { tools: [...new Set([...tools, "finish"])] }),
		promptMode: definition.systemPromptMode ?? "replace",
	};
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

export function validateDeclaredReadPaths(reads: readonly { path: string }[] | undefined): void {
	for (const artifact of reads ?? []) {
		if (/^[a-z][a-z\d+.-]*:\/\//i.test(artifact.path)) throw new Error(`Read '${artifact.path}' is a web URL, not a local artifact; use browser/search acquisition first`);
	}
}

async function resolveReads(
	effect: AgentEffect,
	workDir: string,
	registry?: SchemaRegistry,
): Promise<ResolvedRead[]> {
	const reads: ResolvedRead[] = [];
	validateDeclaredReadPaths(effect.reads);
	for (const artifact of effect.reads ?? []) {
		reads.push(
			artifact.select === undefined
				? { artifact }
				: { artifact, value: await resolveArtifactValue(artifact, workDir, registry) },
		);
	}
	return reads;
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

function actionSessionDir(sessionsDir: string, effect: AgentEffect): string {
	const dir = join(sessionsDir, actionUidDirName(effect.actionUid), sanitizeSegment(sessionKey(effect.id)));
	if (!existsSync(dir)) {
		// SessionManager.create requires the directory to exist.
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

function sessionKey(effectId: string): string {
	return effectId.split(":").slice(0, -1).join(":");
}

function generationKey(key: string, generation: number): string {
	return `${key}:${generation}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringifyToolArgs(args: unknown): string {
	try {
		const text = JSON.stringify(args);
		return text.length > 240 ? `${text.slice(0, 237)}...` : text;
	} catch {
		return String(args);
	}
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
	return text.length > 240 ? `${text.slice(0, 237)}...` : text;
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
