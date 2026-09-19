import { allowedEventsForAction, type BranchProjection } from "../core/projection.js";
import type { ChartAst, ChartEvent } from "../core/types.js";
import type { SchemaRegistryLike } from "../core/schema_registry.js";
import type { DurableRecordDraft, OpenedGateLog } from "../core/durable_events.js";
import { createMachine, emittedRecordsForAcceptedCompletion } from "../core/machine.js";
import { checkSchemaAsync } from "../runtime/generic/schema.js";

/**
 * The addressed gate is not an open user interaction in the branch's current
 * history: it was answered, or a head move removed it. A host that decided
 * from a stale view should re-read state and decide again.
 */
export class StaleUserInteractionError extends Error {
	constructor(
		readonly branchId: string,
		readonly gateSeqId: number,
	) {
		super(`User interaction ${gateSeqId} is stale or missing from branch '${branchId}'`);
		this.name = "StaleUserInteractionError";
	}
}

export type RespondToUserInteractionInput = Readonly<{
	ast: ChartAst;
	gateSeqId: number;
	event: ChartEvent;
	schemaRegistry?: SchemaRegistryLike;
}>;

export async function prepareUserInteractionResponseFromProjection(
	projection: BranchProjection,
	branchId: string,
	gate: OpenedGateLog,
	input: RespondToUserInteractionInput,
): Promise<readonly DurableRecordDraft[]> {
	if (gate.seqId !== input.gateSeqId) {
		throw new StaleUserInteractionError(branchId, input.gateSeqId);
	}
	assertUserEventShape(input.event);
	const projected = projection.openUserInteractions[input.gateSeqId];
	const pending = projection.pendingActions.find(
		(entry) =>
			entry.gateSeqId === input.gateSeqId &&
			entry.actionUid.chart === gate.actionUid.chart &&
			entry.actionUid.state === gate.actionUid.state &&
			entry.actionUid.action === gate.actionUid.action &&
			entry.phase === "running",
	);
	if (projection.failure !== undefined || projected?.status !== "open" || pending === undefined) {
		throw new Error(`User interaction ${input.gateSeqId} is stale or closed`);
	}
	if (input.event.type === "FAILED") {
		throw new Error("FAILED is reserved and cannot resolve an interaction");
	}
	const events =
		gate.type === "user_interaction"
			? gate.events
			: allowedEventsForAction(input.ast, gate.actionUid.state).filter((event) => event !== "FAILED");
	if (!events.includes(input.event.type)) {
		throw new Error(`Event '${input.event.type}' is not allowed; expected one of ${events.join(", ")}`);
	}
	if (gate.reply !== undefined) {
		const check = await checkSchemaAsync(
			gate.reply,
			"output" in input.event ? input.event.output : undefined,
			input.schemaRegistry,
		);
		if (!check.ok) {
			throw new Error(`User response output does not match reply schema: ${check.errors.join("; ")}`);
		}
	}
	const resolved: DurableRecordDraft = {
		type: gate.type,
		kind: "resolved",
		gateSeqId: gate.seqId,
		actionUid: gate.actionUid,
		event: input.event,
	};
	return [
		resolved,
		...emittedRecordsForAcceptedCompletion(createMachine(input.ast, projection), gate.actionUid, input.event),
	];
}

function assertUserEventShape(event: ChartEvent): void {
	if (
		typeof event !== "object" ||
		event === null ||
		Array.isArray(event) ||
		typeof event.type !== "string" ||
		event.type.length === 0
	) {
		throw new Error("User response event must contain a non-empty type");
	}
}
