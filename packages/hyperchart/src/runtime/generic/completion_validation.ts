import type { ChartEvent, SchemaAst } from "../../core/types.js";
import type { RenderedArtifact } from "../../core/machine.js";
import type { SchemaRegistryLike } from "../../core/schema_registry.js";
import { checkArtifactFile } from "./artifacts.js";
import { checkSchemaAsync } from "./schema.js";

export type CompletionContract = Readonly<{
	events: readonly string[];
	reply?: SchemaAst;
	artifacts?: readonly RenderedArtifact[];
}>;

export type CompletionValidationOptions = Readonly<{
	workDir: string;
	schemaRegistry?: SchemaRegistryLike;
	label: string;
}>;

/** Shared action-boundary validation used before script and imported-action completion admission. */
export async function validateActionCompletion(
	contract: CompletionContract,
	event: ChartEvent,
	opts: CompletionValidationOptions,
): Promise<ChartEvent> {
	if (!contract.events.includes(event.type)) {
		return {
			type: "FAILED",
			error: `${opts.label} emitted unsupported event '${event.type}'; allowed: ${contract.events.join(", ")}`,
		};
	}
	if (event.type === "FAILED") {
		if (!("error" in event)) {
			return { type: "FAILED", error: `${opts.label} emitted FAILED without an error` };
		}
	} else if (contract.reply !== undefined) {
		const error = await replyValidationError(contract.reply, event, opts.schemaRegistry);
		if (error !== undefined) {
			return { type: "FAILED", error: `${opts.label} ${error}` };
		}
	}
	const artifactErrors = await validateArtifacts(contract.artifacts, opts.workDir, opts.schemaRegistry);
	if (artifactErrors.length > 0) {
		return { type: "FAILED", error: `${opts.label} deliverables are invalid: ${artifactErrors.join("; ")}` };
	}
	return event;
}

export async function replyValidationError(
	reply: SchemaAst,
	event: ChartEvent,
	schemaRegistry?: SchemaRegistryLike,
): Promise<string | undefined> {
	const check = await checkSchemaAsync(reply, "output" in event ? event.output : undefined, schemaRegistry);
	return check.ok ? undefined : `output does not match reply schema: ${check.errors.join("; ")}`;
}

export async function validateArtifacts(
	artifacts: readonly RenderedArtifact[] | undefined,
	workDir: string,
	schemaRegistry?: SchemaRegistryLike,
): Promise<string[]> {
	const errors: string[] = [];
	for (const artifact of artifacts ?? []) {
		const check = await checkArtifactFile(artifact, workDir, schemaRegistry);
		if (!check.ok) {
			errors.push(...check.errors);
		}
	}
	return errors;
}
