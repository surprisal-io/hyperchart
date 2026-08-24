import { isDeepStrictEqual } from "node:util";
import { createBranchProjection, projectBranch } from "../../core/projection.js";
import type { ChartAst, ChartEvent } from "../../core/types.js";
import type { SchemaRegistryLike } from "../../core/schema_registry.js";
import type { DurableRecordDraft, UserInteractionOpenedLog, UserInteractionResolvedLog } from "../../core/durable_events.js";
import type { NormalizedRunLog } from "./log_store.js";
import { checkSchemaAsync } from "./schema.js";

export type RespondToUserInteractionInput = Readonly<{
	ast: ChartAst;
	gateSeqId: number;
	event: ChartEvent;
	schemaRegistry?: SchemaRegistryLike;
}>;

export type UserInteractionResponseCommit = Readonly<{
	record: UserInteractionResolvedLog;
	idempotent: boolean;
}>;

export type PreparedUserInteractionResponse =
	| Readonly<{ kind: "idempotent"; record: UserInteractionResolvedLog }>
	| Readonly<{
		kind: "append";
		gate: UserInteractionOpenedLog;
		draft: Extract<DurableRecordDraft, { type: "user_interaction"; kind: "resolved" }>;
	}>;

/**
 * Validate one external answer against the exact selected ancestry. Callers must invoke this
 * while holding the backend's serialized writer boundary and append the returned draft before
 * releasing it. Runtime-contract validation may await, so the boundary must remain owned.
 */
export async function prepareUserInteractionResponse(
	normalized: NormalizedRunLog,
	branchId: string,
	input: RespondToUserInteractionInput,
): Promise<PreparedUserInteractionResponse> {
	const prepared = prepareUserInteractionResponseSync(normalized, branchId, input);
	if (prepared.kind === "append" && prepared.gate.reply !== undefined) {
		const check = await checkSchemaAsync(prepared.gate.reply, "output" in input.event ? input.event.output : undefined, input.schemaRegistry);
		if (!check.ok) throw new Error(`User response output does not match reply schema: ${check.errors.join("; ")}`);
	}
	return prepared;
}

/** Structural prefix admission for use inside a synchronous backend critical section. */
export function prepareUserInteractionResponseSync(
	normalized: NormalizedRunLog,
	branchId: string,
	input: RespondToUserInteractionInput,
): PreparedUserInteractionResponse {
	if (!Number.isSafeInteger(input.gateSeqId) || input.gateSeqId <= 0) {
		throw new Error("gateSeqId must be a positive safe integer");
	}
	assertUserEventShape(input.event);
	const ancestry = normalized.ancestry(branchId);
	const existing = ancestry.find((record): record is UserInteractionResolvedLog =>
		record.type === "user_interaction" && record.kind === "resolved" && record.gateSeqId === input.gateSeqId,
	);
	if (existing !== undefined) {
		if (isDeepStrictEqual(existing.event, input.event)) return { kind: "idempotent", record: existing };
		throw new Error(`Conflicting response for user interaction ${input.gateSeqId}`);
	}
	const gate = ancestry.find((record): record is UserInteractionOpenedLog =>
		record.type === "user_interaction" && record.kind === "opened" && record.seqId === input.gateSeqId,
	);
	if (gate === undefined) throw new Error(`User interaction ${input.gateSeqId} is stale or missing from branch '${branchId}'`);
	const projection = projectBranch(createBranchProjection(input.ast), input.ast, ancestry);
	const projected = projection.userInteractions[input.gateSeqId];
	const pending = projection.pendingActions.find((entry) =>
		entry.gateSeqId === input.gateSeqId &&
		entry.actionUid.chart === gate.actionUid.chart &&
		entry.actionUid.state === gate.actionUid.state &&
		entry.actionUid.action === gate.actionUid.action &&
		(entry.phase === "running" || entry.phase === "rejected"),
	);
	if (projection.failure !== undefined || projected?.status !== "open" || pending === undefined) {
		throw new Error(`User interaction ${input.gateSeqId} is stale or closed`);
	}
	if (input.event.type === "FAILED") throw new Error("FAILED is reserved and cannot be returned by a user");
	if (!gate.events.includes(input.event.type)) {
		throw new Error(`Event '${input.event.type}' is not allowed; expected one of ${gate.events.join(", ")}`);
	}
	return {
		kind: "append",
		gate,
		draft: { type: "user_interaction", kind: "resolved", gateSeqId: gate.seqId, actionUid: gate.actionUid, event: input.event },
	};
}

function assertUserEventShape(event: ChartEvent): void {
	if (typeof event !== "object" || event === null || Array.isArray(event) || typeof event.type !== "string" || event.type.length === 0) {
		throw new Error("User response event must contain a non-empty type");
	}
}
