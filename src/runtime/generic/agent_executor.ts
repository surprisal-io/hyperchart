import type { ActionUID, ChartEvent } from "../../core/types.js";
import type { AgentEffect, RejectedEffect } from "../../core/machine.js";

export type EmitCompletion = (event: ChartEvent) => void;

export interface AgentExecutor {
	start(effect: AgentEffect, emit: EmitCompletion): void;
	reject(effect: RejectedEffect, emit: EmitCompletion): void;
	cancel(actionUid: ActionUID): void;
	dispose(): Promise<void>;
}
