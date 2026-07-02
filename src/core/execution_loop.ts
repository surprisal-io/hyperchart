import { Runtime } from "../runtime/runtime.js";
import { concatAsyncIterables } from "../utils/index.js";
import { createMachine, MachineState, stepMachine, MachineEvent } from "./machine.js";
import { createBranchProjection, projectBranch } from "./projection.js";

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
