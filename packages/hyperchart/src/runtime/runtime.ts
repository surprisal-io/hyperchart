import { ChartAst, DurableLogRecord, Effect, MachineEvent } from "../index.js";
import type { BranchId } from "../core/durable_events.js";

export interface Runtime {
	/** Explicit non-durable branch handle selected for this runtime. */
	readonly branchId: BranchId;
	runEffects(effects: Effect[]): void;
	eventsQueue(): AsyncIterable<MachineEvent>;
	loadAst(): Promise<ChartAst>;
	loadLogs(): Promise<readonly DurableLogRecord[]>;
}
