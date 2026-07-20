import type { ChartEvent } from "../../core/types.js";
import type { AgentEffect } from "../../core/machine.js";
import type { SchemaRegistryLike as SchemaRegistry } from "../../core/schema_registry.js";
import { checkSchemaAsync } from "./schema.js";

/**
 * The host-agnostic half of the `finish` tool contract. Each host wraps this in
 * its own tool-definition mechanism; validation, the JSON parameter schema, and
 * the captured-completion sink are shared so completion semantics cannot drift
 * between hosts.
 */
export type CompletionSink = { captured: ChartEvent | undefined };

export type FinishParams = { event?: unknown; output?: unknown };

export function finishableEvents(effect: AgentEffect): string[] {
	return effect.events.filter((event) => event !== "FAILED");
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

export function buildFinishSchema(effect: AgentEffect): Record<string, unknown> {
	const events = finishableEvents(effect);
	return {
		type: "object",
		properties: {
			event: { type: "string", enum: events },
			...(effect.reply === undefined ? {} : { output: effect.reply.schema }),
		},
		required: effect.reply === undefined ? ["event"] : ["event", "output"],
		additionalProperties: false,
	};
}
