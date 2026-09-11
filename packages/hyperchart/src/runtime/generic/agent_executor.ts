import type { ActionUID } from "../../core/types.js";
import type { AgentEffect, AgentOutcome } from "../../core/machine.js";

export type EmitAgentOutcome = (outcome: AgentOutcome) => void;

export interface AgentExecutor {
	start(effect: AgentEffect, emit: EmitAgentOutcome): void;
	/** Resolves only after the cancelled action can no longer perform work or emit an outcome. */
	cancel(actionUid: ActionUID): Promise<void>;
	dispose(): Promise<void>;
}
