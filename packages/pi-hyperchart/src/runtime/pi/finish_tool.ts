import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { ChartEvent } from "@surprisal-io/hyperchart/internal/core/types";
import type { AgentEffect } from "@surprisal-io/hyperchart/internal/core/machine";
import { checkSchema } from "@surprisal-io/hyperchart/runtime";

export type CompletionSink = { captured: ChartEvent | undefined };

type FinishParams = { invocationId?: unknown; event?: unknown; output?: unknown; error?: unknown };

export function finishableEvents(effect: AgentEffect): string[] {
	return effect.events.filter((event) => event !== "FAILED");
}

export function createFinishTool(effect: AgentEffect, sink: CompletionSink): ToolDefinition {
	return defineTool({
		name: "finish",
		label: "Finish",
		description: "Call exactly once when the task is complete. This ends the assignment.",
		promptSnippet: "Finish the hyperchart assignment with a typed completion event",
		parameters: Type.Unsafe(buildFinishSchema(effect)),
		async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
			const result = validateFinishParams(effect, params as FinishParams);
			if (!result.ok) {
				return toolError(result.errors.join("\n"));
			}
			if (sink.captured !== undefined) {
				return toolError("finish has already been called for this assignment");
			}
			sink.captured = result.event;
			return {
				content: [{ type: "text", text: "Recorded. You may stop now." }],
				details: result.event,
				terminate: true,
			};
		},
	}) as ToolDefinition;
}

export function validateFinishParams(
	effect: AgentEffect,
	params: FinishParams,
): { ok: true; event: ChartEvent } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	if (params.invocationId !== effect.id) {
		errors.push(`invocationId must be '${effect.id}'`);
	}
	if (typeof params.event !== "string") {
		errors.push("event must be a string");
		return { ok: false, errors };
	}
	const allowedEvents = finishableEvents(effect);
	if (params.event === "FAILED") {
		errors.push("FAILED is reserved for runtime failures and cannot be returned by an agent");
	} else if (!allowedEvents.includes(params.event)) {
		errors.push(`event '${params.event}' is not allowed; expected one of ${allowedEvents.join(", ")}`);
	}
	if (effect.reply !== undefined) {
		if (!("output" in params)) {
			errors.push("output is required for this completion event");
		} else {
			const check = checkSchema(effect.reply, params.output);
			if (!check.ok) errors.push(...check.errors.map((message) => `output ${message}`));
		}
	}
	return errors.length > 0
		? { ok: false, errors }
		: { ok: true, event: { type: params.event, ...(params.output === undefined ? {} : { output: params.output }) } };
}

function buildFinishSchema(effect: AgentEffect): TSchema {
	const events = finishableEvents(effect);
	return {
		type: "object",
		properties: {
			invocationId: { type: "string", enum: [effect.id] },
			event: { type: "string", enum: events },
			...(effect.reply === undefined ? {} : { output: effect.reply.schema }),
		},
		required: effect.reply === undefined ? ["invocationId", "event"] : ["invocationId", "event", "output"],
		additionalProperties: false,
	} as TSchema;
}

function toolError(message: string): AgentToolResult<unknown> & { isError: true } {
	return {
		content: [{ type: "text", text: message }],
		details: { error: message },
		isError: true,
	};
}
