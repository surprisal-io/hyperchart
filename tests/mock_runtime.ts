import type { Runtime } from "../src/runtime/runtime.js";
import { toAsyncIterable } from "../src/index.js";
import type { ChartAst, DurableLogRecord, Effect, MachineEvent } from "../src/index.js";

type MaybeAsyncIterable<T> = Iterable<T> | AsyncIterable<T>;

export class MockRuntime implements Runtime {
	readonly calls: string[] = [];
	readonly effectBatches: Effect[][] = [];

	private readonly ast: ChartAst;
	private readonly logs: readonly DurableLogRecord[];
	private readonly events: AsyncIterable<MachineEvent>;
	private readonly onRunEffects: ((effects: Effect[]) => void) | undefined;

	constructor(options: {
		ast: ChartAst;
		logs?: readonly DurableLogRecord[];
		events?: MaybeAsyncIterable<MachineEvent>;
		onRunEffects?: (effects: Effect[]) => void;
	}) {
		this.ast = options.ast;
		this.logs = options.logs ?? [];
		this.events = toAsyncIterable(options.events ?? []);
		this.onRunEffects = options.onRunEffects;
	}

	runEffects(effects: Effect[]): void {
		this.calls.push("runEffects");
		this.effectBatches.push(effects);
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
