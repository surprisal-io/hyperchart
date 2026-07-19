import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { ChartEvent } from "@surprisal/hyperchart/internal/core/types";
import type { AgentEffect } from "@surprisal/hyperchart/internal/core/machine";
import type { SchemaRegistryLike as SchemaRegistry } from "@surprisal/hyperchart/internal/core/schema_registry";
import { checkSchemaAsync } from "@surprisal/hyperchart/runtime";

export type CompletionSink = { captured: ChartEvent | undefined };

type FinishParams = { event?: unknown; output?: unknown };

export function finishableEvents(effect: AgentEffect): string[] {
	return effect.events.filter((event) => event !== "FAILED");
}

export function createFinishTool(
	effect: AgentEffect,
	sink: CompletionSink,
	registry?: SchemaRegistry,
): ToolDefinition {
	return defineTool({
		name: "finish",
		label: "Finish",
		description: "Call exactly once when the task is complete. This ends the assignment.",
		promptSnippet: "Finish the hyperchart assignment with a typed completion event",
		parameters: Type.Unsafe(buildFinishSchema(effect)),
		async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
			const result = await validateFinishParams(effect, params as FinishParams, registry);
			if (!result.ok) return toolError(result.errors.join("\n"));
			if (sink.captured !== undefined) return toolError("finish has already been called for this assignment");
			sink.captured = result.event;
			return {
				content: [{ type: "text", text: "Recorded. You may stop now." }],
				details: result.event,
				terminate: true,
			};
		},
	}) as ToolDefinition;
}

export async function validateFinishParams(
	effect: AgentEffect,
	params: FinishParams,
	registry?: SchemaRegistry,
): Promise<{ ok: true; event: ChartEvent } | { ok: false; errors: string[] }> {
	const errors = validateFinishBasics(effect, params);
	if (effect.reply !== undefined) {
		if (!("output" in params)) errors.push("output is required for this completion event");
		else {
			const check = await checkSchemaAsync(effect.reply, params.output, registry);
			if (!check.ok) errors.push(...check.errors.map((message) => `output ${message}`));
		}
	}
	return errors.length > 0
		? { ok: false, errors }
		: { ok: true, event: { type: params.event as string, ...(params.output === undefined ? {} : { output: params.output }) } };
}

function validateFinishBasics(effect: AgentEffect, params: FinishParams): string[] {
	const errors: string[] = [];
	const unexpected = Object.keys(params).filter((key) => key !== "event" && key !== "output");
	if (unexpected.length > 0) errors.push(`unexpected finish field(s): ${unexpected.join(", ")}`);
	if (typeof params.event !== "string") {
		errors.push("event must be a string");
		return errors;
	}
	const allowedEvents = finishableEvents(effect);
	if (params.event === "FAILED") errors.push("FAILED is reserved for runtime failures and cannot be returned by an agent");
	else if (!allowedEvents.includes(params.event)) {
		errors.push(`event '${params.event}' is not allowed; expected one of ${allowedEvents.join(", ")}`);
	}
	return errors;
}

function buildFinishSchema(effect: AgentEffect): TSchema {
	const events = finishableEvents(effect);
	return {
		type: "object",
		properties: {
			event: { type: "string", enum: events },
			...(effect.reply === undefined ? {} : { output: effect.reply.schema }),
		},
		required: effect.reply === undefined ? ["event"] : ["event", "output"],
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
