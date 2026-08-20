import { ChartAst, DurableLogRecord, Effect, MachineEvent } from "../index.js";
import type { BranchId } from "../core/durable_events.js";

export interface Runtime {
	/** Explicit non-durable branch handle selected for this runtime. */
	readonly branchId: BranchId;
	/** Resolves after every durable append in the batch is committed and acknowledged to the queue. */
	runEffects(effects: Effect[]): Promise<void>;
	eventsQueue(): AsyncIterable<MachineEvent>;
	loadAst(): Promise<ChartAst>;
	loadLogs(): Promise<readonly DurableLogRecord[]>;
}
