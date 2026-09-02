import type { Runtime } from "../packages/hyperchart/src/runtime/runtime.js";
import { toAsyncIterable } from "../packages/hyperchart/src/index.js";
import { createBranchProjection, projectBranch, type ChartAst, type DurableLogRecord, type Effect, type MachineEvent } from "../packages/hyperchart/src/index.js";

type MaybeAsyncIterable<T> = Iterable<T> | AsyncIterable<T>;

export class MockRuntime implements Runtime {
	readonly branchId = "main";
	readonly calls: string[] = [];
	readonly effectBatches: Effect[][] = [];

	private readonly ast: ChartAst;
	private readonly logs: DurableLogRecord[];
	private readonly events: AsyncIterable<MachineEvent>;
	private readonly onRunEffects: ((effects: Effect[]) => void) | undefined;

	constructor(options: {
		ast: ChartAst;
		logs?: readonly DurableLogRecord[];
		events?: MaybeAsyncIterable<MachineEvent>;
		onRunEffects?: (effects: Effect[]) => void;
	}) {
		this.ast = options.ast;
		this.logs = [...(options.logs ?? [])];
		this.events = toAsyncIterable(options.events ?? []);
		this.onRunEffects = options.onRunEffects;
	}

	async runEffects(effects: Effect[]): Promise<void> {
		this.calls.push("runEffects");
		this.effectBatches.push(effects);
		// A real runtime persists appended records; the mock does too, so records seeded before
		// the loop (e.g. start()'s args fact) show up in loadLogs.
		for (const effect of effects) {
			if (effect.kind === "durable_records") {
				let seqId = this.logs.at(-1)?.seqId ?? 0;
				let parentId = seqId === 0 ? null : seqId;
				for (const draft of effect.records) {
					const record = { ...draft, seqId: ++seqId, parentId, branchId: this.branchId, timestamp: Date.now() } as DurableLogRecord;
					this.logs.push(record);
					parentId = record.seqId;
				}
			}
		}
		this.onRunEffects?.(effects);
	}

	eventsQueue(): AsyncIterable<MachineEvent> {
		this.calls.push("eventsQueue");
		return this.events;
	}

	async loadAst(): Promise<ChartAst> {
		this.calls.push("loadAst");
		return this.ast;
	}

	async loadProjection() {
		this.calls.push("loadProjection");
		return projectBranch(createBranchProjection(this.ast), this.ast, this.logs);
	}

	async loadLogs(): Promise<readonly DurableLogRecord[]> {
		this.calls.push("loadLogs");
		return this.logs;
	}
}

export function failOnPullEvents(message = "runtime event queue should not be pulled"): AsyncIterable<MachineEvent> {
	return {
		[Symbol.asyncIterator](): AsyncIterator<MachineEvent> {
			return {
				async next(): Promise<IteratorResult<MachineEvent>> {
					throw new Error(message);
				},
			};
		},
	};
}
