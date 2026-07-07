import type { AgentEffect, RenderedArtifact, RejectedEffect } from "../../core/machine.js";
import { finishableEvents } from "./finish_tool.js";

export type ResolvedRead = {
	artifact: RenderedArtifact;
	value?: unknown;
};

export function buildTaskPrompt(effect: AgentEffect, resolvedReads: ResolvedRead[]): string {
	const sections = [effect.task?.trim() || "Complete the assigned hyperchart step."];
	if (resolvedReads.length > 0) {
		sections.push(formatReads(resolvedReads));
	}
	if ((effect.artifacts?.length ?? 0) > 0) {
		sections.push(formatDeliverables(effect.artifacts ?? []));
	}
	sections.push(formatCompletion(effect));
	return sections.join("\n\n");
}

export function buildNudgePrompt(effect: AgentEffect, lastAssistantText?: string): string {
	const lines = [
		"You finished responding without making an accepted tool call.",
		"Do not write tool-call syntax, XML tags, JSON snippets, markdown, or prose.",
		"Use the actual tool-calling interface now.",
		`If the step is complete, call the \`finish\` tool now with event one of ${JSON.stringify(finishableEvents(effect))}.`,
		"",
		formatCompletion(effect),
	];
	if (lastAssistantText !== undefined && looksLikeTextualToolCall(lastAssistantText)) {
		lines.push(
			"Your previous response looked like a tool call written as plain text. Plain text like `read<arg_key>...`, `<tool_call>...`, or JSON is ignored by the runtime and does not execute tools.",
			"If you still need a file/tool, call the real tool through the tool interface. Otherwise call `finish` now.",
		);
	}
	return lines.join("\n");
}

function looksLikeTextualToolCall(text: string): boolean {
	return /<\/?(?:tool_call|arg_key|arg_value)>/.test(text) || /\b(?:read|write|bash|browser|finish)<arg_key>/.test(text);
}

export function buildRejectPrompt(effect: RejectedEffect): string {
	const completion =
		effect.invocation.kind === "agent" ? `\n\n${formatCompletion({ ...effect.invocation, id: effect.id })}` : "";
	return `Your result was rejected by the validator (validation attempt ${effect.validationAttempts}). Reason: ${
		effect.reason ?? "No reason provided."
	}. Fix the issues and call \`finish\` again.${completion}`;
}

export function buildArtifactFeedbackPrompt(errors: string[]): string {
	return `The deliverables are invalid:\n${errors.map((error) => `- ${error}`).join("\n")}\nFix the files and call \`finish\` again.`;
}

export function buildResumePrompt(effect: AgentEffect): string {
	return `The orchestrator restarted. Continue the task; if it is already complete, call \`finish\` immediately.\n\n${formatCompletion(
		effect,
	)}`;
}

export function formatCompletion(effect: AgentEffect): string {
	const lines = [
		"## Completion",
		"When done, call the `finish` tool exactly once.",
		`- invocationId: exactly ${JSON.stringify(effect.id)}`,
		`- event: one of ${JSON.stringify(finishableEvents(effect))}`,
	];
	if (effect.reply !== undefined) {
		lines.push("- output must match this JSON schema:");
		lines.push("```json");
		lines.push(JSON.stringify(effect.reply.schema, null, 2));
		lines.push("```");
	} else {
		lines.push("- do not include output unless explicitly needed.");
	}
	if (effect.events.includes("FAILED")) {
		lines.push("- `FAILED` is reserved for runtime failures; do not return it yourself.");
	}
	lines.push("Do not describe the result in prose — the finish call is the only accepted completion.");
	return lines.join("\n");
}

function formatReads(reads: ResolvedRead[]): string {
	const lines = ["## Files to read first"];
	for (const read of reads) {
		if (read.artifact.select === undefined) {
			lines.push(`- ${read.artifact.path}`);
			continue;
		}
		lines.push(`- ${read.artifact.select} (from ${read.artifact.path}):`);
		lines.push("```json");
		lines.push(JSON.stringify(read.value, null, 2));
		lines.push("```");
	}
	return lines.join("\n");
}

function formatDeliverables(artifacts: readonly RenderedArtifact[]): string {
	const lines = ["## Deliverables"];
	for (const artifact of artifacts) {
		lines.push(`Write the file \`${artifact.path}\`.`);
		if (artifact.shape !== undefined) {
			lines.push("Its content MUST match this JSON schema:");
			lines.push("```json");
			lines.push(JSON.stringify(artifact.shape.schema, null, 2));
			lines.push("```");
		}
	}
	return lines.join("\n");
}
