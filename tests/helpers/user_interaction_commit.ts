import { isDeepStrictEqual } from "node:util";
import type { ChartAst, ChartEvent } from "../../packages/hyperchart/src/core/types.js";
import type { SchemaRegistryLike } from "../../packages/hyperchart/src/core/schema_registry.js";
import type { DurableRecordDraft } from "../../packages/hyperchart/src/core/durable_events.js";
import type { MemoryLogStore } from "../../packages/hyperchart/src/runtime/generic/memory_log_store.js";
import type {
	RunLogStore,
	UserInteractionResponseCommit,
} from "../../packages/hyperchart/src/runtime/generic/log_store.js";
import { BranchExecution } from "../../packages/hyperchart/src/execution/branch_execution.js";
import { StaleUserInteractionError } from "../../packages/hyperchart/src/execution/user_interaction.js";

type PreparedCommitStore = RunLogStore | MemoryLogStore;
export type PreparedTestUserInteraction = Readonly<{
	expectedHeadSeqId: number | null;
	gateSeqId: number;
	drafts: readonly DurableRecordDraft[];
	semantic: BranchExecution;
	existing?: UserInteractionResponseCommit["record"];
}>;

/** Test-only mirror of the execution-owned preparation path. */
export async function prepareUserInteractionCommit(
	store: PreparedCommitStore,
	ast: ChartAst,
	gateSeqId: number,
	event: ChartEvent,
	options: {
		branchId?: string;
		snapshot?: Readonly<{ branchId: string; headSeqId: number | null }>;
		schemaRegistry?: SchemaRegistryLike;
	} = {},
): Promise<PreparedTestUserInteraction> {
	const branchId = options.branchId ?? store.branchId;
	const snapshot = options.snapshot ?? (await store.captureSnapshot(branchId));
	const semantic = await BranchExecution.restore({ ast, branchId, store, snapshot, saveCheckpoint: "never" });
	const existing = await store.findUserInteractionResponse({ headSeqId: snapshot.headSeqId, gateSeqId });
	if (existing !== undefined) {
		if (!isDeepStrictEqual(existing.event, event)) {
			throw new Error(`Conflicting response for user interaction ${gateSeqId}`);
		}
		return {
			expectedHeadSeqId: snapshot.headSeqId,
			gateSeqId,
			drafts: [],
			semantic,
			existing,
		};
	}
	const gate = await store.getRecord(gateSeqId);
	if (
		(gate?.type !== "user_interaction" && gate?.type !== "gate") ||
		gate.kind !== "opened" ||
		!(await store.containsInHistory({ headSeqId: snapshot.headSeqId, seqId: gateSeqId }))
	) {
		throw new StaleUserInteractionError(branchId, gateSeqId);
	}
	const drafts = await semantic.prepareUserInteraction(gate, event, options.schemaRegistry);
	return { expectedHeadSeqId: snapshot.headSeqId, gateSeqId, drafts, semantic };
}

export async function commitUserInteractionResponse(
	store: PreparedCommitStore,
	ast: ChartAst,
	gateSeqId: number,
	event: ChartEvent,
	options: {
		branchId?: string;
		snapshot?: Readonly<{ branchId: string; headSeqId: number | null }>;
		schemaRegistry?: SchemaRegistryLike;
	} = {},
): Promise<UserInteractionResponseCommit> {
	const prepared = await prepareUserInteractionCommit(store, ast, gateSeqId, event, options);
	if (prepared.existing !== undefined) {
		return { record: prepared.existing, idempotent: true };
	}
	const records = await store.appendDraftsAtHead(
		{ expectedHeadSeqId: prepared.expectedHeadSeqId, drafts: prepared.drafts },
		prepared.semantic.prepareStampedCommit,
	);
	return { record: records[0] as UserInteractionResponseCommit["record"], idempotent: false };
}
