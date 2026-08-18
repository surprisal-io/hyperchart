import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
	createSdkMcpServer,
	query,
	tool,
	type Options,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { actionUidDirName, actionUidKey, sanitizeSegment } from "@surprisal/hyperchart/internal/core/action_uid";
import type { ActionUID, ChartEvent } from "@surprisal/hyperchart/internal/core/types";
import type { AgentEffect, RejectedEffect } from "@surprisal/hyperchart/internal/core/machine";
import { errorMessage } from "@surprisal/hyperchart/internal/utils/errors";
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
	loadAgentDefinition,
	previewText,
	resolveReads,
	runAcceptanceLoop,
	sessionKey,
	shouldRecoverRestoredFinish,
	stringifyToolArgs,
	validateFinishParams,
	type AgentDefinition,
	type AgentExecutor,
	type EmitCompletion,
	type FinishParams,
	type CompletionSink,
	type SessionPlan,
	type ThinkingLevel,
} from "@surprisal/hyperchart/runtime";
import { readNeutralSessionTranscript } from "@surprisal/hyperchart/inspect";
import type { HyperchartSessionMessageInfo } from "@surprisal/hyperchart/host";
import {
	createThrottledProgressWriter,
	readSessionProgress,
	sessionProgressKey,
	updateSessionProgress,
} from "@surprisal/hyperchart/sessions";
import { createNeutralTranscriptWriter, type NeutralTranscriptWriter } from "./transcript_writer.js";
import { resolveClaudeSubagentDefinitionDirs } from "./agent_definitions.js";

export const FINISH_TOOL_NAME = "mcp__hyperchart__finish";

/** Injection seam for tests: yields the SDK message stream for one session. */
export type QueryFn = (params: {
	prompt: AsyncIterable<SDKUserMessage>;
	options: Options;
}) => AsyncIterable<SDKMessage>;

export type ClaudeExecutorOptions = {
	workDir: string;
	sessionsDir: string;
	branchId: string;
	definitionDirs?: string[];
	defaultModel?: string;
	modelRoles?: Record<string, string>;
	toolsets?: Record<string, string[]>;
	maxFinishRetries?: number;
	schemaRegistry?: SchemaRegistry;
	queryFn?: QueryFn;
};

type RunOptions = {
	forceNewSession: boolean;
	resumePrompt?: string;
	rejectReason?: string;
	resumeSessionFile?: string;
};

class SessionCleanupError extends AggregateError {}

type LiveAgent = {
	session: ClaudeSession;
	effect: AgentEffect;
	sink: CompletionSink;
	generation: number;
};

type TerminalEmitState = { emitted: boolean };

export class ClaudeAgentExecutor implements AgentExecutor {
	private readonly live = new Map<string, LiveAgent>();
	private readonly runs = new Map<string, Map<number, Promise<void>>>();
	private readonly cancellations = new Map<string, Promise<void>>();
	private readonly cleanupTasks = new Set<Promise<void>>();
	private readonly generations = new GenerationTracker();
	private readonly cleanupFailures: unknown[] = [];
	private readonly definitionDirs: string[];
	private readonly maxFinishRetries: number;
	private readonly queryFn: QueryFn;
	private disposed = false;
	private disposal: Promise<void> | undefined;

	constructor(private readonly options: ClaudeExecutorOptions) {
		this.definitionDirs = options.definitionDirs ?? resolveClaudeSubagentDefinitionDirs(options.workDir);
		this.maxFinishRetries = options.maxFinishRetries ?? 2;
		this.queryFn = options.queryFn ?? ((params) => query({ prompt: params.prompt, options: params.options }));
	}

	start(effect: AgentEffect, emit: EmitCompletion): void {
		if (this.disposed) {
			emit({ type: "FAILED", error: "Claude agent executor is disposed" });
			return;
		}
		const key = actionUidKey(effect.actionUid);
		const generation = this.generations.next(key);
		const terminal: TerminalEmitState = { emitted: false };
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
			terminal,
		).catch((error: unknown) => this.handleRunFailure(key, generation, effect, emit, error, terminal)));
	}

	reject(effect: RejectedEffect, emit: EmitCompletion): void {
		if (this.disposed) {
			emit({ type: "FAILED", error: "Claude agent executor is disposed" });
			return;
		}
		const key = actionUidKey(effect.actionUid);
		const retryEffect = effect.invocation.kind === "agent" ? { ...effect.invocation, id: effect.id } : undefined;
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
			this.live.delete(key);
			this.trackCleanup(this.cleanupSession(live.session));
		}
		const generation = this.generations.next(key);
		const terminal: TerminalEmitState = { emitted: false };
		const runOptions: RunOptions =
			effect.onReject === "restart"
				? { forceNewSession: true, ...(effect.reason === undefined ? {} : { rejectReason: effect.reason }) }
				: { forceNewSession: false, resumePrompt: buildRejectPrompt(effect) };
		this.launch(key, generation, this.run(retryEffect, emit, runOptions, generation, terminal)
			.catch((error: unknown) => this.handleRunFailure(key, generation, retryEffect, emit, error, terminal)));
	}

	async steer(actionKey: string, invokeSeqId: number, message: string): Promise<boolean> {
		if (this.disposed) return false;
		const live = this.live.get(actionKey);
		if (live === undefined || effectInvokeSeqId(live.effect.id) !== invokeSeqId) return false;
		live.session.steer(message);
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
			this.updateProgress(live.effect, { status: "cancelled", completedAt: Date.now() });
		}
		const run = this.runs.get(key)?.get(generation);
		const cancellation = (async () => {
			if (live !== undefined) await this.cleanupSession(live.session);
			await run;
		})();
		this.cancellations.set(key, cancellation);
		void cancellation.then(() => {
			if (this.cancellations.get(key) === cancellation) this.cancellations.delete(key);
		}, () => {
			if (this.cancellations.get(key) === cancellation) this.cancellations.delete(key);
		});
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
		this.live.clear();
		this.runs.clear();
		this.cancellations.clear();
		this.cleanupTasks.clear();
		this.cleanupFailures.length = 0;
		if (failures.length > 0) throw new AggregateError(failures, "Failed to dispose Claude agent executor cleanly");
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
		terminal: TerminalEmitState,
	): Promise<void> {
		const key = actionUidKey(effect.actionUid);
		if (this.isStopped(key, generation)) return;
		const previousProgress = readSessionProgress(this.options.sessionsDir).sessions[
			sessionProgressKey(effect.actionUid, effect.id, this.options.branchId)
		];
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
		// Validate every declared read before considering any restored session. A resumed session
		// must not bypass the local-artifact/URL boundary that a fresh run enforces.
		const reads = await resolveReads(effect, this.options.workDir, this.options.schemaRegistry);
		if (this.isStopped(key, generation)) return;
		const dir = actionSessionDir(this.options.sessionsDir, this.options.branchId, effect);
		const restored = restoredTranscript(this.options.sessionsDir, this.options.branchId, dir, effect, runOptions);
		const plan = buildSessionPlan(definition, effect, {
			...(this.options.defaultModel === undefined ? {} : { defaultModel: this.options.defaultModel }),
			...(this.options.modelRoles === undefined ? {} : { modelRoles: this.options.modelRoles }),
			...(this.options.toolsets === undefined ? {} : { toolsets: this.options.toolsets }),
		});
		const sink: CompletionSink = { captured: undefined };

		if (restored !== undefined && shouldRecoverRestoredFinish(runOptions)) {
			const captured = findCapturedFinishInTranscript(
				this.options.sessionsDir,
				restored.path,
				effect,
				this.options.schemaRegistry,
			);
			const validated = await captured;
			if (this.isStopped(key, generation)) return;
			if (validated !== undefined) {
				sink.captured = validated;
				this.updateProgress(effect, {
					actionName: definition.name,
					status: "completed",
					completedAt: Date.now(),
					sessionFile: restored.path,
					...((previousProgress?.role ?? definition.role) === undefined
						? {}
						: { role: previousProgress?.role ?? definition.role }),
					...((previousProgress?.model ?? plan.modelRef) === undefined
						? {}
						: { model: previousProgress?.model ?? plan.modelRef }),
					...((previousProgress?.thinking ?? plan.thinkingLevel) === undefined
						? {}
						: { thinking: previousProgress?.thinking ?? plan.thinkingLevel }),
					...((previousProgress?.toolset ?? definition.toolset) === undefined
						? {}
						: { toolset: previousProgress?.toolset ?? definition.toolset }),
					...((previousProgress?.tools ?? plan.tools) === undefined
						? {}
						: { tools: previousProgress?.tools ?? plan.tools }),
				});
				// The finish already happened in a previous process; only artifact validation remains.
				await runAcceptanceLoop({
					effect,
					sink,
					maxRetries: 0,
					isCancelled: () => this.generations.isCancelled(key, generation),
					prompt: async () => undefined,
					lastAssistantText: () => undefined,
					checkArtifacts: () => checkEffectArtifacts(effect, this.options.workDir, this.options.schemaRegistry),
					emit: (event) => this.safeEmit(key, generation, emit, event, terminal),
				});
				return;
			}
		}

		const session = await this.createSession({
			effect,
			definition,
			plan,
			sink,
			workDir: this.options.workDir,
			sessionsDir: this.options.sessionsDir,
			branchId: this.options.branchId,
			sessionDir: dir,
			...(this.options.schemaRegistry === undefined ? {} : { schemaRegistry: this.options.schemaRegistry }),
			queryFn: this.queryFn,
			...(restored === undefined ? {} : { resumeSessionId: restored.sessionId }),
		});
		if (this.isStopped(key, generation)) {
			await this.cleanupSession(session);
			return;
		}
		session.begin();
		if (this.isStopped(key, generation)) {
			await this.cleanupSession(session);
			return;
		}
		const live: LiveAgent = { session, effect, sink, generation };
		if (this.isStopped(key, generation)) {
			await this.cleanupSession(session);
			return;
		}
		this.live.set(key, live);

		const initialPrompt =
			restored !== undefined
				? runOptions.resumePrompt ?? buildResumePrompt(effect)
				: [
						runOptions.resumePrompt,
						runOptions.rejectReason === undefined
							? undefined
							: `Previous validation attempt was rejected. Reason: ${runOptions.rejectReason}. Start fresh and fix it.`,
						buildTaskPrompt(effect, reads),
					]
						.filter((part): part is string => part !== undefined)
						.join("\n\n");
		try {
			if (this.isStopped(key, generation)) return;
			await session.prompt(initialPrompt);
			if (this.isStopped(key, generation)) return;
			await runAcceptanceLoop({
				effect,
				sink,
				maxRetries: this.maxFinishRetries,
				isCancelled: () => this.generations.isCancelled(key, generation),
				prompt: (text) => this.isStopped(key, generation) ? Promise.resolve() : session.prompt(text),
				lastAssistantText: () => session.lastAssistantText(),
				checkArtifacts: () => checkEffectArtifacts(effect, this.options.workDir, this.options.schemaRegistry),
				emit: (event) => this.safeEmit(key, generation, emit, event, terminal),
			});
		} finally {
			if (this.live.get(key) === live) this.live.delete(key);
			session.end();
			try {
				await session.settled();
			} finally {
				if (!this.isStopped(key, generation)) {
					this.updateProgress(effect, {
						status: sink.captured === undefined ? "failed" : "completed",
						completedAt: Date.now(),
						currentTool: undefined,
						currentToolArgs: undefined,
						currentToolStartedAt: undefined,
						currentText: undefined,
						currentReasoning: undefined,
					});
				}
			}
		}
	}

	private async createSession(options: ClaudeSessionOptions): Promise<ClaudeSession> {
		return new ClaudeSession(options);
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
		terminal: TerminalEmitState,
	): void {
		if (terminal.emitted) {
			this.cleanupFailures.push(error);
			return;
		}
		if (this.disposed && error instanceof SessionCleanupError) this.cleanupFailures.push(error);
		if (!this.isStopped(key, generation)) this.markProgressFailed(effect, errorMessage(error));
		this.safeEmit(key, generation, emit, { type: "FAILED", error: errorMessage(error) }, terminal);
	}

	private trackCleanup(cleanup: Promise<void>): void {
		const tracked = cleanup.finally(() => this.cleanupTasks.delete(tracked));
		this.cleanupTasks.add(tracked);
		void tracked.catch((error: unknown) => this.cleanupFailures.push(error));
	}

	private async cleanupSession(session: ClaudeSession): Promise<void> {
		const failures: unknown[] = [];
		try {
			session.abort();
		} catch (error) {
			failures.push(error);
		}
		try {
			await session.settled();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length > 0) throw new SessionCleanupError(failures, "Failed to clean up Claude agent session");
	}

	private safeEmit(
		key: string,
		generation: number,
		emit: EmitCompletion,
		event: ChartEvent,
		terminal: TerminalEmitState,
	): void {
		if (terminal.emitted || this.isStopped(key, generation)) return;
		terminal.emitted = true;
		emit(event);
	}
}

type ClaudeSessionOptions = {
	effect: AgentEffect;
	definition: AgentDefinition;
	plan: SessionPlan;
	sink: CompletionSink;
	workDir: string;
	sessionsDir: string;
	branchId: string;
	sessionDir: string;
	schemaRegistry?: SchemaRegistry;
	queryFn: QueryFn;
	resumeSessionId?: string;
};

/**
 * One SDK query in streaming-input mode: pushes user prompts, consumes the
 * message stream into session progress and the neutral transcript, and
 * resolves each prompt when its turn's result arrives.
 */
class ClaudeSession {
	private readonly input = createInputQueue();
	private readonly abortController = new AbortController();
	private readonly stream;
	private readonly turnWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
	private consumeLoop: Promise<void> | undefined;
	private muted = false;
	private writer: NeutralTranscriptWriter | undefined;
	private readonly pendingRecords: HyperchartSessionMessageInfo[] = [];
	private lastAssistant: string | undefined;
	private streamError: unknown;
	private recordSequence = 0;
	private toolCount = 0;
	private turnCount = 0;
	private tokenCount = 0;

	constructor(private readonly options: ClaudeSessionOptions) {
		this.stream = createThrottledProgressWriter(
			options.sessionsDir,
			options.effect.actionUid,
			options.definition.name,
			options.effect.id,
			options.branchId,
		);
	}

	begin(): void {
		const messages = this.options.queryFn({ prompt: this.input.iterable, options: this.buildOptions() });
		this.consumeLoop = this.consume(messages).catch((error: unknown) => {
			this.streamError = error;
			for (const waiter of this.turnWaiters.splice(0)) waiter.reject(error);
			throw error;
		});
		this.consumeLoop.catch(() => undefined);
	}

	async prompt(text: string): Promise<void> {
		if (this.streamError !== undefined) throw this.streamError;
		this.recordUserMessage(text);
		const done = new Promise<void>((resolve, reject) => {
			this.turnWaiters.push({ resolve, reject });
		});
		this.input.push({
			type: "user",
			message: { role: "user", content: text },
			parent_tool_use_id: null,
		});
		await done;
	}

	steer(text: string): void {
		this.recordUserMessage(text);
		// priority "now" delivers into the live turn after the current tool call
		// instead of waiting for the next turn boundary.
		this.input.push({
			type: "user",
			message: { role: "user", content: text },
			parent_tool_use_id: null,
			priority: "now",
		});
	}

	lastAssistantText(): string | undefined {
		return this.lastAssistant;
	}

	/** Closes the input stream so the query can finish draining. */
	end(): void {
		this.muted = true;
		this.stream.dispose();
		this.input.close();
	}

	abort(): void {
		// A cancelled or superseded session must stop touching session progress:
		// the successor generation (or the cancelled status) owns the file now.
		this.muted = true;
		this.input.close();
		this.abortController.abort();
		this.stream.dispose();
	}

	async settled(): Promise<void> {
		await this.consumeLoop;
	}

	private buildOptions(): Options {
		const plan = this.options.plan;
		const definition = this.options.definition;
		const toolsWithoutFinish = plan.tools?.filter((name) => name !== "finish");
		const systemPrompt = definition.systemPrompt.trim();
		// A replaced system prompt drops Claude Code's environment block, so the
		// session would not know its working directory; restate it explicitly or
		// agents guess absolute paths and write outside the run's workDir.
		const environmentNote = [
			`Working directory: ${this.options.workDir}`,
			"Create and reference files relative to this working directory; do not write outside it unless the task names an absolute path inside it.",
		].join("\n");
		return {
			cwd: this.options.workDir,
			abortController: this.abortController,
			includePartialMessages: true,
			// Headless chart runs cannot answer permission prompts; the chart's guards
			// and validators are the control surface instead.
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			// Chart agents must behave identically across machines: no user/project
			// settings or CLAUDE.md leakage into their context.
			settingSources: [],
			mcpServers: { hyperchart: this.createFinishServer() },
			...(systemPrompt.length === 0
				? {}
				: {
						systemPrompt:
							plan.promptMode === "append"
								? { type: "preset", preset: "claude_code", append: systemPrompt }
								: `${systemPrompt}\n\n${environmentNote}`,
					}),
			...(plan.modelRef === undefined ? {} : { model: plan.modelRef }),
			...thinkingOptions(plan.thinkingLevel),
			...(toolsWithoutFinish === undefined ? {} : { tools: toolsWithoutFinish }),
			allowedTools: [...(toolsWithoutFinish ?? []), FINISH_TOOL_NAME],
			...(this.options.resumeSessionId === undefined ? {} : { resume: this.options.resumeSessionId }),
		};
	}

	private createFinishServer() {
		const { effect, sink, schemaRegistry } = this.options;
		const finish = tool(
			"finish",
			"Call exactly once when the task is complete. This ends the assignment.",
			{ event: z.string(), output: z.unknown().optional() },
			async (args) => {
				let result = await validateFinishParams(effect, args as FinishParams, schemaRegistry);
				if (!result.ok) {
					const reparsed = reparseStringOutput(args as FinishParams);
					if (reparsed !== undefined) {
						const retry = await validateFinishParams(effect, reparsed, schemaRegistry);
						if (retry.ok) result = retry;
					}
				}
				if (!result.ok) return { content: [{ type: "text" as const, text: result.errors.join("\n") }], isError: true };
				if (sink.captured !== undefined) {
					return {
						content: [{ type: "text" as const, text: "finish has already been called for this assignment" }],
						isError: true,
					};
				}
				sink.captured = result.event;
				return { content: [{ type: "text" as const, text: "Recorded. You may stop now." }] };
			},
		);
		return createSdkMcpServer({ name: "hyperchart", tools: [finish] });
	}

	private async consume(messages: AsyncIterable<SDKMessage>): Promise<void> {
		for await (const message of messages) {
			if (message.type === "system" && message.subtype === "init") {
				this.onInit(message.session_id, message.model);
				continue;
			}
			if (message.type === "result") {
				this.onResult(message.usage as unknown, message.is_error ? collectResultErrors(message) : undefined);
				continue;
			}
			if (this.muted) continue;
			if (message.type === "stream_event") {
				const event = message.event;
				if (event.type === "content_block_delta") {
					if (event.delta.type === "text_delta") this.stream.appendText(event.delta.text);
					if (event.delta.type === "thinking_delta") this.stream.appendReasoning(event.delta.thinking);
				}
				continue;
			}
			if (message.type === "assistant") {
				this.onAssistant(message.message);
				continue;
			}
			if (message.type === "user") {
				this.onToolResults(message.message);
				continue;
			}
		}
		// Stream ended (input closed or aborted); fail any prompt still waiting.
		const remaining = this.turnWaiters.splice(0);
		for (const waiter of remaining) waiter.reject(this.streamError ?? new Error("Claude session ended before the turn completed"));
	}

	private onInit(sessionId: string, model: string): void {
		if (this.muted) return;
		if (this.writer === undefined) {
			this.writer = createNeutralTranscriptWriter(join(this.options.sessionDir, `${sessionId}.jsonl`), sessionId);
			for (const record of this.pendingRecords.splice(0)) this.writer.append(record);
		}
		this.updateProgress({
			actionName: this.options.definition.name,
			status: "running",
			model,
			sessionFile: this.writer.path,
			...(this.options.definition.role === undefined ? {} : { role: this.options.definition.role }),
			...(this.options.plan.thinkingLevel === undefined ? {} : { thinking: this.options.plan.thinkingLevel }),
			...(this.options.definition.toolset === undefined ? {} : { toolset: this.options.definition.toolset }),
			...(this.options.plan.tools === undefined ? {} : { tools: this.options.plan.tools }),
		});
	}

	private onAssistant(message: { content?: unknown; usage?: unknown }): void {
		const blocks = Array.isArray(message.content) ? message.content : [];
		for (const block of blocks) {
			if (!isRecord(block)) continue;
			if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
				this.appendRecord({ role: "reasoning", text: block.thinking });
			}
			if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
				this.lastAssistant = block.text;
				this.appendRecord({ role: "assistant", text: block.text });
				const preview = previewText(block.text);
				this.updateProgress({
					actionName: this.options.definition.name,
					status: "running",
					currentText: undefined,
					currentReasoning: undefined,
					...(preview === undefined ? {} : { lastMessage: preview }),
				});
			}
			if (block.type === "tool_use" && typeof block.name === "string") {
				this.toolCount++;
				const displayName = block.name === FINISH_TOOL_NAME ? "finish" : block.name;
				const args = stringifyToolArgs(block.input);
				this.appendRecord({
					role: "tool",
					toolName: displayName,
					...(typeof block.id === "string" ? { toolCallId: block.id } : {}),
					toolInput: stringifyToolInput(block.input),
					toolStatus: "running",
				});
				this.updateProgress({
					actionName: this.options.definition.name,
					status: "running",
					toolCount: this.toolCount,
					currentTool: displayName,
					currentToolArgs: args,
					currentToolStartedAt: Date.now(),
				});
			}
		}
		this.stream.reset();
	}

	private onToolResults(message: { content?: unknown }): void {
		const blocks = Array.isArray(message.content) ? message.content : [];
		let sawToolResult = false;
		let toolError = false;
		for (const block of blocks) {
			if (!isRecord(block) || block.type !== "tool_result") continue;
			sawToolResult = true;
			if (block.is_error === true) toolError = true;
			this.appendRecord({
				role: "tool",
				toolName: "tool",
				...(typeof block.tool_use_id === "string" ? { toolCallId: block.tool_use_id } : {}),
				...(toolResultText(block.content) === undefined ? {} : { toolOutput: toolResultText(block.content) as string }),
				toolStatus: block.is_error === true ? "error" : "completed",
				...(block.is_error === true ? { isError: true } : {}),
			});
		}
		if (sawToolResult) {
			this.updateProgress({
				actionName: this.options.definition.name,
				status: "running",
				currentTool: undefined,
				currentToolArgs: undefined,
				currentToolStartedAt: undefined,
				...(toolError ? { error: "tool failed" } : { error: undefined }),
			});
		}
	}

	private onResult(usage: unknown, error: string | undefined): void {
		this.turnCount++;
		this.tokenCount += usageTokens(usage);
		this.stream.reset();
		if (this.muted) {
			this.resolveTurn(error);
			return;
		}
		this.updateProgress({
			actionName: this.options.definition.name,
			status: "running",
			turnCount: this.turnCount,
			currentText: undefined,
			currentReasoning: undefined,
			...(this.tokenCount > 0 ? { tokenCount: this.tokenCount } : {}),
			...(error === undefined ? {} : { error }),
		});
		this.resolveTurn(error);
	}

	private updateProgress(patch: Parameters<typeof updateSessionProgress>[2]): void {
		if (this.muted) return;
		updateSessionProgress(
			this.options.sessionsDir,
			this.options.effect.actionUid,
			patch,
			this.options.effect.id,
			this.options.branchId,
		);
	}

	private resolveTurn(error: string | undefined): void {
		const waiter = this.turnWaiters.shift();
		if (waiter !== undefined) {
			if (error !== undefined) waiter.reject(new Error(error));
			else waiter.resolve();
		}
	}

	private recordUserMessage(text: string): void {
		this.appendRecord({ role: "user", text });
	}

	private appendRecord(record: Omit<HyperchartSessionMessageInfo, "id" | "timestamp">): void {
		this.recordSequence++;
		const entry = { id: `r${this.recordSequence}`, timestamp: Date.now(), ...record };
		if (this.writer === undefined) {
			// The first prompt is pushed before the SDK announces the session id.
			this.pendingRecords.push(entry);
			return;
		}
		this.writer.append(entry);
	}
}

export async function findCapturedFinishInTranscript(
	sessionsDir: string,
	transcriptPath: string,
	effect: AgentEffect,
	registry?: SchemaRegistry,
): Promise<ChartEvent | undefined> {
	const messages = readNeutralSessionTranscript(sessionsDir, transcriptPath);
	if (messages === undefined) return undefined;
	let lastUser = -1;
	messages.forEach((message, index) => {
		if (message.role === "user") lastUser = index;
	});
	let captured: ChartEvent | undefined;
	for (const message of messages.slice(lastUser + 1)) {
		if (message.role !== "tool" || message.toolName !== "finish") continue;
		if (message.toolStatus !== "completed" || message.isError === true) continue;
		let params: FinishParams;
		try {
			params = JSON.parse(message.toolInput ?? "") as FinishParams;
		} catch {
			continue;
		}
		const result = await validateFinishParams(effect, params, registry);
		if (result.ok) captured = result.event;
	}
	return captured;
}

function restoredTranscript(
	sessionsDir: string,
	branchId: string,
	dir: string,
	effect: AgentEffect,
	runOptions: RunOptions,
): { path: string; sessionId: string } | undefined {
	const candidate = restoredTranscriptPath(sessionsDir, branchId, dir, effect, runOptions);
	if (candidate === undefined) return undefined;
	const sessionId = transcriptSessionId(candidate);
	return sessionId === undefined ? undefined : { path: candidate, sessionId };
}

function restoredTranscriptPath(
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
		return latestTranscriptForPreviousActionSession(sessionsDir, branchId, effect);
	}
	return latestTranscript(dir);
}

function transcriptSessionId(path: string): string | undefined {
	try {
		const firstLine = readFileSync(path, "utf8").split("\n", 1)[0];
		if (firstLine === undefined) return undefined;
		const parsed = JSON.parse(firstLine) as { hyperchartTranscript?: unknown; sessionId?: unknown };
		if (parsed.hyperchartTranscript !== 1 || typeof parsed.sessionId !== "string") return undefined;
		return parsed.sessionId;
	} catch {
		return undefined;
	}
}

function latestTranscript(dir: string): string | undefined {
	if (!existsSync(dir)) return undefined;
	return readdirSync(dir)
		.filter((file) => file.endsWith(".jsonl"))
		.map((file) => join(dir, file))
		.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

function latestTranscriptForPreviousActionSession(sessionsDir: string, branchId: string, effect: AgentEffect): string | undefined {
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

// The SDK MCP bridge presents the finish tool's schemaless `output` field to the
// model as a string, so structured replies arrive JSON-encoded. When raw validation
// fails, retry with the parsed value; genuine string replies pass raw validation first.
function reparseStringOutput(params: FinishParams): FinishParams | undefined {
	if (typeof params.output !== "string") return undefined;
	try {
		return { ...params, output: JSON.parse(params.output) };
	} catch {
		return undefined;
	}
}

function thinkingOptions(level: ThinkingLevel | undefined): Pick<Options, "thinking" | "effort"> {
	if (level === undefined) return {};
	if (level === "off") return { thinking: { type: "disabled" } };
	return { thinking: { type: "adaptive" }, effort: level === "minimal" ? "low" : level };
}

function createInputQueue(): {
	iterable: AsyncIterable<SDKUserMessage>;
	push(message: SDKUserMessage): void;
	close(): void;
} {
	const buffer: SDKUserMessage[] = [];
	let waiting: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;
	let closed = false;
	const iterable: AsyncIterable<SDKUserMessage> = {
		[Symbol.asyncIterator]() {
			return {
				next(): Promise<IteratorResult<SDKUserMessage>> {
					const value = buffer.shift();
					if (value !== undefined) return Promise.resolve({ done: false, value });
					if (closed) return Promise.resolve({ done: true, value: undefined });
					return new Promise((resolve) => {
						waiting = resolve;
					});
				},
			};
		},
	};
	return {
		iterable,
		push(message) {
			if (closed) return;
			if (waiting !== undefined) {
				const resolve = waiting;
				waiting = undefined;
				resolve({ done: false, value: message });
				return;
			}
			buffer.push(message);
		},
		close() {
			if (closed) return;
			closed = true;
			if (waiting !== undefined) {
				const resolve = waiting;
				waiting = undefined;
				resolve({ done: true, value: undefined });
			}
		},
	};
}

function collectResultErrors(message: { subtype: string; errors?: unknown }): string {
	const errors = Array.isArray(message.errors) ? message.errors.filter((entry) => typeof entry === "string") : [];
	return errors.length > 0 ? errors.join("; ") : `Claude session turn failed (${message.subtype})`;
}

function usageTokens(usage: unknown): number {
	if (!isRecord(usage)) return 0;
	const total = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
		.map((key) => (typeof usage[key] === "number" ? (usage[key] as number) : 0))
		.reduce((sum, value) => sum + value, 0);
	return total;
}

function stringifyToolInput(input: unknown): string {
	try {
		return JSON.stringify(input, null, 2);
	} catch {
		return String(input);
	}
}

function toolResultText(content: unknown): string | undefined {
	if (typeof content === "string") return content.length === 0 ? undefined : content;
	if (!Array.isArray(content)) return undefined;
	const parts = content.flatMap((block) =>
		isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
	);
	return parts.length === 0 ? undefined : parts.join("\n\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
