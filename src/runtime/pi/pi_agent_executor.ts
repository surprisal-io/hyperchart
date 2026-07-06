import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { actionUidDirName, actionUidKey, sanitizeSegment } from "../../core/action_uid.js";
import type { ActionUID, ChartEvent } from "../../core/types.js";
import type { AgentEffect, RejectedEffect } from "../../core/machine.js";
import { errorMessage } from "../../utils/errors.js";
import type { AgentExecutor, EmitCompletion } from "../generic/agent_executor.js";
import { checkArtifactFile, resolveArtifactValue } from "../generic/artifacts.js";
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
	modelRegistry: ModelRegistry;
	defaultModel?: string;
	maxFinishRetries?: number;
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
	resumeInvocationId?: string;
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
		void this.run(effect, emit, { forceNewSession: false }, generation).catch((error: unknown) => {
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
				{ forceNewSession: false, resumePrompt: buildRejectPrompt(effect), resumeInvocationId: live.effect.id },
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
				: { forceNewSession: false, resumePrompt: buildRejectPrompt(effect), resumeInvocationId: effect.invocation.id };
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
		const dir = actionSessionDir(this.options.sessionsDir, effect);
		const latest = runOptions.forceNewSession
			? undefined
			: latestJsonlForInvocation(dir, runOptions.resumeInvocationId ?? effect.id);
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

		if (latest !== undefined) {
			const captured = findCapturedFinish(session.messages, effect);
			if (captured !== undefined) {
				sink.captured = captured;
				await this.acceptanceLoop(key, generation, emit, live);
				return;
			}
			await this.promptAndAccept(key, generation, emit, live, runOptions.resumePrompt ?? buildResumePrompt(effect));
			return;
		}

		const reads = await resolveReads(effect, this.options.workDir);
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
		const model = plan.modelRef === undefined ? undefined : resolveModel(this.options.modelRegistry, plan.modelRef);
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
			modelRegistry: this.options.modelRegistry,
			...(model === undefined ? {} : { model }),
			...(plan.thinkingLevel === undefined ? {} : { thinkingLevel: plan.thinkingLevel }),
			...(plan.tools === undefined ? {} : { tools: plan.tools }),
			customTools: [createFinishTool(effect, sink)],
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
				await live.session.prompt(buildNudgePrompt(live.effect));
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
			const check = await checkArtifactFile(artifact, this.options.workDir);
			if (!check.ok) errors.push(...check.errors);
		}
		return errors;
	}

	private attachProgress(session: AgentSession, effect: AgentEffect, definition: AgentDefinition): () => void {
		let turnCount = 0;
		let toolCount = 0;
		let tokenCount = 0;
		return session.subscribe((event) => {
			if (event.type === "turn_start") {
				turnCount++;
				updateSessionProgress(this.options.sessionsDir, effect.actionUid, {
					actionName: definition.name,
					status: "running",
					turnCount,
				});
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
				updateSessionProgress(this.options.sessionsDir, effect.actionUid, {
					actionName: definition.name,
					status: "running",
					lastMessage: messagePreview(event.message),
					...(tokenCount > 0 ? { tokenCount } : {}),
				});
				return;
			}
			if (event.type === "agent_end") {
				updateSessionProgress(this.options.sessionsDir, effect.actionUid, {
					actionName: definition.name,
					status: event.willRetry ? "running" : "completed",
					completedAt: event.willRetry ? undefined : Date.now(),
					currentTool: undefined,
					currentToolArgs: undefined,
					currentToolStartedAt: undefined,
				});
			}
		});
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

export function sessionMentionsInvocationId(sessionFile: string, invocationId: string): boolean {
	try {
		return readFileSync(sessionFile, "utf8").includes(invocationId);
	} catch {
		return false;
	}
}

export function findCapturedFinish(messages: readonly unknown[], effect: AgentEffect): ChartEvent | undefined {
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
			const result = validateFinishParams(
				effect,
				calls.get(message.toolCallId) as { invocationId?: unknown; event?: unknown; output?: unknown; error?: unknown },
			);
			if (result.ok) captured = result.event;
		}
	}
	return captured;
}

async function resolveReads(effect: AgentEffect, workDir: string): Promise<ResolvedRead[]> {
	const reads: ResolvedRead[] = [];
	for (const artifact of effect.reads ?? []) {
		reads.push(
			artifact.select === undefined ? { artifact } : { artifact, value: await resolveArtifactValue(artifact, workDir) },
		);
	}
	return reads;
}

function resolveModel(modelRegistry: ModelRegistry, modelRef: string) {
	const [provider, ...rest] = modelRef.split("/");
	const modelId = rest.join("/");
	if (!provider || !modelId) {
		throw new Error(`Model '${modelRef}' must be in provider/model-id format`);
	}
	const model = modelRegistry.find(provider, modelId);
	if (model === undefined) {
		throw new Error(`Model '${modelRef}' was not found in the model registry`);
	}
	return model;
}

function latestJsonlForInvocation(dir: string, invocationId: string): string | undefined {
	if (!existsSync(dir)) return undefined;
	return readdirSync(dir)
		.filter((file) => file.endsWith(".jsonl"))
		.map((file) => join(dir, file))
		.filter((file) => sessionMentionsInvocationId(file, invocationId))
		.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
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

function messagePreview(message: unknown): string | undefined {
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
	if (compact.length === 0) return undefined;
	return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}
