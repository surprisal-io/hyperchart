import { Runtime } from "../runtime/runtime.js";
import { concatAsyncIterables } from "../utils/index.js";
import { createMachine, MachineState, stepMachine, MachineEvent } from "./machine.js";

// Runs a chart: a fresh log gets the run's arguments seeded as its first fact; a non-empty log
// means the run already exists and is simply resumed — the logged args win over the ones passed.
export async function start(runtime: Runtime, args?: Readonly<Record<string, unknown>>): Promise<MachineState> {
	const existing = await runtime.loadProjection();
	if (existing.seqId === 0 && args !== undefined) {
		await runtime.runEffects([
			{
				kind: "durable_records",
				id: "args",
				records: [{ type: "args", args }],
			},
		]);
	}
	return loop(runtime);
}

export async function loop(runtime: Runtime): Promise<MachineState> {
	const ast = await runtime.loadAst();
	const projection = await runtime.loadProjection();
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
				await runtime.runEffects(output.effects);
				break;
			case "final":
				if (output.effects.length > 0) {
					await runtime.runEffects(output.effects);
				}
				return output.state;
			case "error":
				throw new Error(output.error);
		}
	}
	throw new Error("Event queue closed before reaching a final state");
}

