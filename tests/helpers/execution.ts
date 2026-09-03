import type { BranchProjection } from "../../packages/hyperchart/src/core/projection.js";
import type { ChartAst } from "../../packages/hyperchart/src/core/types.js";
import type { Runtime } from "../../packages/hyperchart/src/runtime/runtime.js";
import type { MachineState } from "../../packages/hyperchart/src/core/machine.js";
import type { ChartRuntime } from "../../packages/hyperchart/src/runtime/generic/chart_runtime.js";
import type { CheckpointRepository } from "../../packages/hyperchart/src/runtime/generic/log_store.js";
import { BranchExecution } from "../../packages/hyperchart/src/execution/branch_execution.js";
import { loop as executionLoop } from "../../packages/hyperchart/src/execution/execution_loop.js";
import { artifactSnapshotValidator } from "../../packages/hyperchart/src/execution/artifact_admission.js";

export type SnapshotTestRuntime = Runtime & {
	loadAst(): Promise<ChartAst>;
	loadProjection(): Promise<BranchProjection>;
};

export async function start(runtime: SnapshotTestRuntime | ChartRuntime, args?: Readonly<Record<string, unknown>>): Promise<MachineState> {
	if ("executionInputs" in runtime) {
		const { ast, store } = runtime.executionInputs();
		return startChartRuntime(runtime, ast, store, args);
	}
	let projection = await runtime.loadProjection();
	if (projection.seqId === 0 && args !== undefined) {
		await runtime.runEffects([{ kind: "durable_records", id: "args", records: [{ type: "args", args }] }]);
		projection = await runtime.loadProjection();
	}
	const ast = await runtime.loadAst();
	return executionLoop(runtime, BranchExecution.fromProjection(ast, runtime.branchId, projection));
}

export async function startChartRuntime(runtime: ChartRuntime, ast: ChartAst, store: CheckpointRepository, args?: Readonly<Record<string, unknown>>): Promise<MachineState> {
	const execution = await BranchExecution.restore({ ast, branchId: runtime.branchId, store });
	runtime.bindStampedCommit(execution.prepareStampedCommit);
	runtime.bindArtifactValidator(artifactSnapshotValidator(runtime.executionInputs().schemaRegistry));
	return import("../../packages/hyperchart/src/execution/execution_loop.js").then(({ start }) => start(runtime, execution, args));
}

export async function loop(runtime: SnapshotTestRuntime): Promise<MachineState> {
	const [ast, projection] = await Promise.all([runtime.loadAst(), runtime.loadProjection()]);
	return executionLoop(runtime, BranchExecution.fromProjection(ast, runtime.branchId, projection));
}
