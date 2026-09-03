import type { Effect, MachineEvent } from "../core/machine.js";
import type { BranchId } from "../core/durable_events.js";

/** Effect/event port. Runtime performs I/O and never owns or observes semantic projection state. */
export interface Runtime {
	readonly branchId: BranchId;
	runEffects(effects: Effect[]): Promise<void>;
	eventsQueue(): AsyncIterable<MachineEvent>;
	beginDrain?(): void;
	dispose?(): Promise<void>;
}
