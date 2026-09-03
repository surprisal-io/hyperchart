import type { Runtime } from "../runtime/runtime.js";
import { concatAsyncIterables } from "../utils/index.js";
import { stepMachine, type MachineState, type MachineEvent } from "../core/machine.js";

export interface ExecutionSession {
	isFresh(): boolean;
	machineState(): MachineState;
}

// Runs a chart: execution owns the restored projection; runtime only performs effects and I/O.
export async function start(runtime: Runtime, execution: ExecutionSession, args?: Readonly<Record<string, unknown>>): Promise<MachineState> {
	if (execution.isFresh() && args !== undefined) {
		await runtime.runEffects([{ kind: "durable_records", id: "args", records: [{ type: "args", args }] }]);
	}
	return loop(runtime, execution);
}

export async function loop(runtime: Runtime, execution: Pick<ExecutionSession, "machineState">): Promise<MachineState> {
	let state = execution.machineState();
	const queue: AsyncIterable<MachineEvent> = concatAsyncIterables([{ kind: "start" }], runtime.eventsQueue());
	for await (const event of queue) {
		const output = stepMachine(state, event);
		switch (output.kind) {
			case "effect":
				await runtime.runEffects(output.effects);
				break;
			case "final":
				if (output.effects.length > 0) await runtime.runEffects(output.effects);
				return output.state;
			case "error":
				throw new Error(output.error);
		}
	}
	throw new Error("Event queue closed before reaching a final state");
}
