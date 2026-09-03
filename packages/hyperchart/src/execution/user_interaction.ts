import type { BranchProjection } from "../core/projection.js";
import type { ChartAst, ChartEvent } from "../core/types.js";
import type { SchemaRegistryLike } from "../core/schema_registry.js";
import type { DurableRecordDraft, UserInteractionOpenedLog } from "../core/durable_events.js";
import { checkSchemaAsync } from "../runtime/generic/schema.js";

export type RespondToUserInteractionInput = Readonly<{
	ast: ChartAst;
	gateSeqId: number;
	event: ChartEvent;
	schemaRegistry?: SchemaRegistryLike;
}>;

export async function prepareUserInteractionResponseFromProjection(
	projection: BranchProjection,
	branchId: string,
	gate: UserInteractionOpenedLog,
	input: RespondToUserInteractionInput,
): Promise<Extract<DurableRecordDraft, { type: "user_interaction"; kind: "resolved" }>> {
	if (gate.seqId !== input.gateSeqId) throw new Error(`User interaction ${input.gateSeqId} is stale or missing from branch '${branchId}'`);
	assertUserEventShape(input.event);
	const projected = projection.openUserInteractions[input.gateSeqId];
	const pending = projection.pendingActions.find((entry) =>
		entry.gateSeqId === input.gateSeqId && entry.actionUid.chart === gate.actionUid.chart
		&& entry.actionUid.state === gate.actionUid.state && entry.actionUid.action === gate.actionUid.action
		&& (entry.phase === "running" || entry.phase === "rejected"));
	if (projection.failure !== undefined || projected?.status !== "open" || pending === undefined) throw new Error(`User interaction ${input.gateSeqId} is stale or closed`);
	if (input.event.type === "FAILED") throw new Error("FAILED is reserved and cannot be returned by a user");
	if (!gate.events.includes(input.event.type)) throw new Error(`Event '${input.event.type}' is not allowed; expected one of ${gate.events.join(", ")}`);
	if (gate.reply !== undefined) {
		const check = await checkSchemaAsync(gate.reply, "output" in input.event ? input.event.output : undefined, input.schemaRegistry);
		if (!check.ok) throw new Error(`User response output does not match reply schema: ${check.errors.join("; ")}`);
	}
	return { type: "user_interaction", kind: "resolved", gateSeqId: gate.seqId, actionUid: gate.actionUid, event: input.event };
}

function assertUserEventShape(event: ChartEvent): void {
	if (typeof event !== "object" || event === null || Array.isArray(event) || typeof event.type !== "string" || event.type.length === 0) {
		throw new Error("User response event must contain a non-empty type");
	}
}
