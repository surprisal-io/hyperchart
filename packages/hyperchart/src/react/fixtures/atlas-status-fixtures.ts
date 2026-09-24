import { agent, chart, compound, final, tsAction } from "../../core/dsl.js";
import type { DurableLogRecord } from "../../core/durable_events.js";
import { createMachine, type Effect, type MachineEvent } from "../../core/machine.js";
import { createBranchProjection, projectBranch } from "../../core/projection.js";
import { loop } from "../../execution/execution_loop.js";
import type { HyperchartRunInfo } from "../../host/models.js";
import type { Runtime } from "../../runtime/runtime.js";
import { storyScenario } from "./story-scenario.js";

const compoundScenario = storyScenario(
	chart({
		kind: "chart",
		id: "storybook-atlas-compound-status",
		initial: "scope",
		states: {
			scope: compound({
				initial: "work",
				onDone: "done",
				states: {
					work: { kind: "state", action: agent("scope-worker"), transitions: { DONE: "finished" } },
					finished: final(),
				},
			}),
			done: final(),
		},
	}),
);
const functionScenario = storyScenario(
	chart({
		kind: "chart",
		id: "storybook-atlas-function-status",
		initial: "execute",
		states: {
			execute: { kind: "state", action: tsAction("./actions/score.ts", "score"), transitions: { DONE: "done" } },
			done: final(),
		},
	}),
);

class SnapshotReached extends Error {}
export type AtlasStatusSnapshot = "compound-running" | "compound-done" | "function-running" | "function-failed";
class AtlasStatusRuntime implements Runtime {
	readonly branchId = "main";
	readonly records: DurableLogRecord[] = [];
	private readonly queued: MachineEvent[] = [];
	private readonly waiters: Array<() => void> = [];
	private seqId = 0;
	constructor(private readonly snapshot: AtlasStatusSnapshot) {}
	async runEffects(effects: Effect[]) {
		for (const effect of effects) {
			switch (effect.kind) {
				case "durable_records": {
					const added = effect.records.map(
						(draft): DurableLogRecord =>
							({
								...draft,
								seqId: ++this.seqId,
								parentId: this.seqId === 1 ? null : this.seqId - 1,
								branchId: this.branchId,
								timestamp: 1_700_500_000_000 + this.seqId * 1_000,
							}) as DurableLogRecord,
					);
					this.records.push(...added);
					const reached =
						this.snapshot === "compound-running"
							? added.some(
									(record) =>
										record.type === "state_action" &&
										record.kind === "invoke" &&
										record.actionUid.state === "scope.work",
								)
							: this.snapshot === "compound-done"
								? added.some(
										(record) =>
											record.type === "state_action" &&
											record.kind === "complete" &&
											record.actionUid.state === "scope.work",
									)
								: this.snapshot === "function-running"
									? added.some(
											(record) =>
												record.type === "state_action" &&
												record.kind === "invoke" &&
												record.actionUid.state === "execute",
										)
									: added.some((record) => record.type === "failure_intent");
					if (reached) {
						throw new SnapshotReached();
					}
					this.push({ kind: "durable_records_added", effectId: effect.id, records: added });
					break;
				}
				case "agent":
					this.push({ kind: "agent", effectId: effect.id, outcome: { kind: "completed", event: { type: "DONE" } } });
					break;
				case "tsImport":
					this.push({ kind: "tsImport", effectId: effect.id, event: { type: "FAILED", error: "Scoring failed" } });
					break;
				case "cancel":
					break;
				default:
					throw new Error(`Unexpected atlas status effect ${effect.kind}`);
			}
		}
	}
	async *eventsQueue(): AsyncIterable<MachineEvent> {
		while (true) {
			if (this.queued.length === 0) {
				await new Promise<void>((resolve) => this.waiters.push(resolve));
			}
			const next = this.queued.shift();
			if (next !== undefined) {
				yield next;
			}
		}
	}
	private push(event: MachineEvent) {
		this.queued.push(event);
		this.waiters.shift()?.();
	}
}

const cache = new Map<AtlasStatusSnapshot, Promise<HyperchartRunInfo>>();
export function captureAtlasStatus(snapshot: AtlasStatusSnapshot): Promise<HyperchartRunInfo> {
	const cached = cache.get(snapshot);
	if (cached !== undefined) {
		return cached;
	}
	const pending = (async () => {
		const scenario = snapshot.startsWith("compound") ? compoundScenario : functionScenario;
		const ast = scenario.ast;
		const runtime = new AtlasStatusRuntime(snapshot);
		await runtime.runEffects([{ kind: "durable_records", id: "args", records: [{ type: "args", args: {} }] }]);
		const projection = projectBranch(createBranchProjection(ast), ast, runtime.records);
		try {
			await loop(runtime, { machineState: () => createMachine(ast, projection) });
		} catch (error) {
			if (!(error instanceof SnapshotReached)) {
				throw error;
			}
		}
		return scenario.runtimeRun(runtime.records, {
			runId: `atlas:${snapshot}`,
			status: { state: snapshot === "function-failed" ? "failed" : "running" },
			cwd: "/storybook/atlas",
			createdAt: 1_700_500_000_000,
			updatedAt: 1_700_500_100_000,
		});
	})();
	cache.set(snapshot, pending);
	return pending;
}
