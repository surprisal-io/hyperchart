import { isDeepStrictEqual } from "node:util";
import type { ChartAst, ChartEvent } from "../../packages/hyperchart/src/core/types.js";
import type { SchemaRegistryLike } from "../../packages/hyperchart/src/core/schema_registry.js";
import type { MemoryLogStore } from "../../packages/hyperchart/src/runtime/generic/memory_log_store.js";
import type { PreparedUserInteractionCommit, RunLogStore, UserInteractionResponseCommit } from "../../packages/hyperchart/src/runtime/generic/log_store.js";
import { loadBranchProjection, projectionContractForAst } from "../../packages/hyperchart/src/runtime/generic/projection_loader.js";
import { prepareUserInteractionResponseFromProjection } from "../../packages/hyperchart/src/runtime/generic/user_interaction_admission.js";

type PreparedCommitStore = RunLogStore | MemoryLogStore;

/** Test-only mirror of the controller's projection-backed preparation path. */
export async function prepareUserInteractionCommit(
	store: PreparedCommitStore,
	ast: ChartAst,
	gateSeqId: number,
	event: ChartEvent,
	options: { branchId?: string; snapshot?: Readonly<{ branchId: string; headSeqId: number | null }>; schemaRegistry?: SchemaRegistryLike } = {},
): Promise<PreparedUserInteractionCommit> {
	const branchId = options.branchId ?? store.branchId;
	const snapshot = options.snapshot ?? await store.captureSnapshot(branchId);
	const existing = await store.findUserInteractionResponse({ headSeqId: snapshot.headSeqId, gateSeqId });
	if (existing !== undefined) {
		if (!isDeepStrictEqual(existing.event, event)) throw new Error(`Conflicting response for user interaction ${gateSeqId}`);
		return {
			expectedHeadSeqId: snapshot.headSeqId,
			gateSeqId,
			draft: { type: "user_interaction", kind: "resolved", gateSeqId, actionUid: existing.actionUid, event },
		};
	}
	const gate = await store.getRecord(gateSeqId);
	if (gate?.type !== "user_interaction" || gate.kind !== "opened" || !await store.containsInHistory({ headSeqId: snapshot.headSeqId, seqId: gateSeqId })) {
		throw new Error(`User interaction ${gateSeqId} is stale or missing from branch '${branchId}'`);
	}
	const loaded = await loadBranchProjection({ ast, branchId, store, contract: projectionContractForAst(ast), snapshot, saveCheckpoint: "never" });
	const draft = await prepareUserInteractionResponseFromProjection(loaded.projection, branchId, gate, {
		ast,
		gateSeqId,
		event,
		...(options.schemaRegistry === undefined ? {} : { schemaRegistry: options.schemaRegistry }),
	});
	return { expectedHeadSeqId: snapshot.headSeqId, gateSeqId, draft };
}

export async function commitUserInteractionResponse(
	store: PreparedCommitStore,
	ast: ChartAst,
	gateSeqId: number,
	event: ChartEvent,
	options: { branchId?: string; snapshot?: Readonly<{ branchId: string; headSeqId: number | null }>; schemaRegistry?: SchemaRegistryLike } = {},
): Promise<UserInteractionResponseCommit> {
	return store.commitPreparedUserInteraction(await prepareUserInteractionCommit(store, ast, gateSeqId, event, options));
}
