import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { actionUidDirName, sanitizeSegment } from "../../core/action_uid.js";
import type { ChartEvent } from "../../core/types.js";
import type { AgentEffect } from "../../core/machine.js";
import type { SchemaRegistryLike as SchemaRegistry } from "../../core/schema_registry.js";
import { checkArtifactFile, resolveArtifactValue } from "./artifacts.js";
import { buildArtifactFeedbackPrompt, buildNudgePrompt, type ResolvedRead } from "./agent_prompts.js";
import type { CompletionSink } from "./finish_protocol.js";
import type { AgentDefinition, ThinkingLevel } from "./agent_definitions.js";

export type SessionPlan = {
	modelRef?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	promptMode: "replace" | "append";
};

/**
 * Effect overrides win over the agent definition, which wins over host defaults.
 * A definition role/toolset configured in `modelRoles`/`toolsets` wins over the
 * definition's own model/tools; an unconfigured name falls through to them, and
 * with no fallback declared either the plan fails loudly — a declared role or
 * toolset is a requirement, not a hint.
 */
export function buildSessionPlan(
	definition: AgentDefinition,
	effect: AgentEffect,
	options: {
		defaultModel?: string;
		modelRoles?: Record<string, string>;
		toolsets?: Record<string, string[]>;
	} = {},
): SessionPlan {
	const roleModel = definition.role === undefined ? undefined : options.modelRoles?.[definition.role];
	if (
		definition.role !== undefined &&
		roleModel === undefined &&
		effect.action.model === undefined &&
		definition.model === undefined
	) {
		throw new Error(
			`Agent '${definition.name}' declares model role '${definition.role}' which is not configured; add it to the 'roles' section of hypercharts settings.json or declare a fallback 'model' in the definition`,
		);
	}
	const modelRef = effect.action.model ?? roleModel ?? definition.model ?? options.defaultModel;
	const thinkingLevel = (effect.action.thinking ?? definition.thinking) as ThinkingLevel | undefined;
	const toolsetTools = definition.toolset === undefined ? undefined : options.toolsets?.[definition.toolset];
	if (
		definition.toolset !== undefined &&
		toolsetTools === undefined &&
		effect.action.tools === undefined &&
		definition.tools === undefined
	) {
		throw new Error(
			`Agent '${definition.name}' declares toolset '${definition.toolset}' which is not configured; add it to the 'toolsets' section of hypercharts settings.json or declare fallback 'tools' in the definition`,
		);
	}
	const tools = effect.action.tools ?? toolsetTools ?? definition.tools;
	return {
		...(modelRef === undefined ? {} : { modelRef }),
		...(thinkingLevel === undefined ? {} : { thinkingLevel }),
		...(tools === undefined ? {} : { tools: [...new Set([...tools, "finish"])] }),
		promptMode: definition.systemPromptMode ?? "replace",
	};
}

export function shouldRecoverRestoredFinish(runOptions: { resumePrompt?: string; rejectReason?: string }): boolean {
	return runOptions.resumePrompt === undefined && runOptions.rejectReason === undefined;
}

export function validateDeclaredReadPaths(reads: readonly { path: string }[] | undefined): void {
	for (const artifact of reads ?? []) {
		if (/^[a-z][a-z\d+.-]*:\/\//i.test(artifact.path)) throw new Error(`Read '${artifact.path}' is a web URL, not a local artifact; use browser/search acquisition first`);
	}
}

export async function resolveReads(
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

export async function checkEffectArtifacts(
	effect: AgentEffect,
	workDir: string,
	registry?: SchemaRegistry,
): Promise<string[]> {
	const errors: string[] = [];
	for (const artifact of effect.artifacts ?? []) {
		const check = await checkArtifactFile(artifact, workDir, registry);
		if (!check.ok) errors.push(...check.errors);
	}
	return errors;
}

/**
 * Per-action generation bookkeeping shared by executors: superseded or
 * explicitly cancelled generations must neither emit completions nor keep
 * driving their sessions.
 */
export class GenerationTracker {
	private readonly generations = new Map<string, number>();
	private readonly cancelled = new Set<string>();

	next(key: string): number {
		const generation = (this.generations.get(key) ?? 0) + 1;
		this.generations.set(key, generation);
		this.cancelled.delete(generationKey(key, generation));
		return generation;
	}

	current(key: string): number | undefined {
		return this.generations.get(key);
	}

	markCancelled(key: string, generation: number): void {
		this.cancelled.add(generationKey(key, generation));
	}

	isCancelled(key: string, generation: number): boolean {
		return this.cancelled.has(generationKey(key, generation)) || this.generations.get(key) !== generation;
	}
}

export type AcceptanceLoopOptions = {
	effect: AgentEffect;
	sink: CompletionSink;
	maxRetries: number;
	isCancelled(): boolean;
	prompt(text: string): Promise<void>;
	lastAssistantText(): string | undefined;
	checkArtifacts(): Promise<string[]>;
	/** Called at most once with the accepted completion or a FAILED event. */
	emit(event: ChartEvent): void;
};

/**
 * Drives a session to an accepted completion: nudge when the agent stopped
 * without calling finish, re-prompt with feedback when deliverables are
 * invalid, and fail once the retry budget is exhausted.
 */
export async function runAcceptanceLoop(options: AcceptanceLoopOptions): Promise<void> {
	let remaining = options.maxRetries;
	while (!options.isCancelled()) {
		if (options.sink.captured === undefined) {
			if (remaining-- <= 0) {
				options.emit({ type: "FAILED", error: "agent did not produce a valid completion" });
				return;
			}
			await options.prompt(buildNudgePrompt(options.effect, options.lastAssistantText()));
			continue;
		}
		if (options.sink.captured.type !== "FAILED") {
			const artifactErrors = await options.checkArtifacts();
			if (artifactErrors.length > 0) {
				options.sink.captured = undefined;
				if (remaining-- <= 0) {
					options.emit({
						type: "FAILED",
						error: `agent did not produce valid deliverables: ${artifactErrors.join("; ")}`,
					});
					return;
				}
				await options.prompt(buildArtifactFeedbackPrompt(artifactErrors));
				continue;
			}
		}
		options.emit(options.sink.captured);
		return;
	}
}

/** Session state directory for one action invocation; created because session managers require it. */
export function actionSessionDir(sessionsDir: string, effect: AgentEffect): string {
	const dir = join(sessionsDir, actionUidDirName(effect.actionUid), sanitizeSegment(sessionKey(effect.id)));
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

/** The effect id minus its trailing seqId: stable across retries of the same invocation. */
export function sessionKey(effectId: string): string {
	return effectId.split(":").slice(0, -1).join(":");
}

export function previewText(text: string, limit = 240): string | undefined {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length === 0) return undefined;
	return compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact;
}

export function stringifyToolArgs(args: unknown): string {
	try {
		const text = JSON.stringify(args);
		return text.length > 240 ? `${text.slice(0, 237)}...` : text;
	} catch {
		return String(args);
	}
}

function generationKey(key: string, generation: number): string {
	return `${key}:${generation}`;
}
