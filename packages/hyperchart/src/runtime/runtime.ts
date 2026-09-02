import { ChartAst, Effect, MachineEvent } from "../index.js";
import type { BranchProjection } from "../core/projection.js";
import type { BranchId } from "../core/durable_events.js";

export interface Runtime {
	/** Explicit non-durable branch handle selected for this runtime. */
	readonly branchId: BranchId;
	/** Resolves after every durable append in the batch is committed and acknowledged to the queue. */
	runEffects(effects: Effect[]): Promise<void>;
	eventsQueue(): AsyncIterable<MachineEvent>;
	loadAst(): Promise<ChartAst>;
	/** Restore the selected immutable head through checkpoints plus bounded replay. */
	loadProjection(): Promise<BranchProjection>;
}
