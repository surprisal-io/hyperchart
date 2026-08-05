import type { ActionUID, ChartEvent } from "../../core/types.js";
import type { AgentEffect, RejectedEffect } from "../../core/machine.js";

export type EmitCompletion = (event: ChartEvent) => void;

export interface AgentExecutor {
	start(effect: AgentEffect, emit: EmitCompletion): void;
	reject(effect: RejectedEffect, emit: EmitCompletion): void;
	/** Resolves only after the cancelled action can no longer perform work or emit completion. */
	cancel(actionUid: ActionUID): Promise<void>;
	dispose(): Promise<void>;
}
