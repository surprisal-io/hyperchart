import type { ActionUID, ChartEvent } from "../packages/hyperchart/src/index.js";
import type { AgentEffect } from "../packages/hyperchart/src/core/machine.js";
import type { AgentExecutor, EmitAgentOutcome } from "../packages/hyperchart/src/runtime/generic/agent_executor.js";

type Reply = ChartEvent | undefined;

export class FakeAgentExecutor implements AgentExecutor {
	readonly starts: AgentEffect[] = [];
	readonly cancels: ActionUID[] = [];
	private readonly replies = new Map<string, Reply[]>();
	private readonly startWaiters: Array<{ count: number; resolve: () => void }> = [];

	constructor(replies: Record<string, Reply[]> = {}) {
		for (const [state, items] of Object.entries(replies)) {
			this.replies.set(state, [...items]);
		}
	}

	start(effect: AgentEffect, emit: EmitAgentOutcome): void {
		this.starts.push(effect);
		this.resolveStartWaiters();
		this.emitNext(effect.actionUid.state, emit);
	}

	async cancel(actionUid: ActionUID): Promise<void> {
		this.cancels.push(actionUid);
	}

	async dispose(): Promise<void> {}

	waitForStart(count = this.starts.length + 1): Promise<void> {
		if (this.starts.length >= count) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.startWaiters.push({ count, resolve });
		});
	}

	private emitNext(state: string, emit: EmitAgentOutcome): void {
		const reply = this.replies.get(state)?.shift();
		if (reply !== undefined) {
			queueMicrotask(() => emit({ kind: "completed", event: reply }));
		}
	}

	private resolveStartWaiters(): void {
		const pending = this.startWaiters.splice(0);
		for (const waiter of pending) {
			if (this.starts.length >= waiter.count) {
				waiter.resolve();
			} else {
				this.startWaiters.push(waiter);
			}
		}
	}
}
