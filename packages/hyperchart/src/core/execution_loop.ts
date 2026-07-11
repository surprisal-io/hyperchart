import { Runtime } from "../runtime/runtime.js";
import { concatAsyncIterables } from "../utils/index.js";
import { createMachine, MachineState, stepMachine, MachineEvent } from "./machine.js";
import { createBranchProjection, projectBranch } from "./projection.js";

// Runs a chart: a fresh log gets the run's arguments seeded as its first fact; a non-empty log
// means the run already exists and is simply resumed — the logged args win over the ones passed.
export async function start(runtime: Runtime, args?: Readonly<Record<string, unknown>>): Promise<MachineState> {
	const existing = await runtime.loadLogs();
	if (existing.length === 0 && args !== undefined) {
		runtime.runEffects([
			{
				kind: "durable_records",
				id: "args",
				records: [{ type: "args", args, parentId: null, seqId: 1, timestamp: Date.now() }],
			},
		]);
	}
	return loop(runtime);
}

export async function loop(runtime: Runtime): Promise<MachineState> {
	let ast = await runtime.loadAst();
	let projection = createBranchProjection(ast);
	projection = projectBranch(projection, ast, await runtime.loadLogs());
	let state = createMachine(ast, projection);
	let queue: AsyncIterable<MachineEvent> = concatAsyncIterables(
		[
			{
				kind: "start",
			},
		],
		runtime.eventsQueue(),
	);
	for await (const event of queue) {
		const output = stepMachine(state, event);
		switch (output.kind) {
			case "effect":
				runtime.runEffects(output.effects);
				break;
			case "final":
				if (output.effects.length > 0) {
					runtime.runEffects(output.effects);
				}
				return output.state;
			case "error":
				throw new Error(output.error);
		}
	}
	throw new Error("Event queue closed before reaching a final state");
}

