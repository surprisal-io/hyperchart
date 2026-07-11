import type { ActionUID, ChartEvent } from "../packages/hyperchart/src/index.js";
import type { AgentEffect, RejectedEffect } from "../packages/hyperchart/src/core/machine.js";
import type { AgentExecutor, EmitCompletion } from "../packages/hyperchart/src/runtime/generic/agent_executor.js";

type Reply = ChartEvent | undefined;

export class FakeAgentExecutor implements AgentExecutor {
	readonly starts: AgentEffect[] = [];
	readonly rejects: RejectedEffect[] = [];
	readonly cancels: ActionUID[] = [];
	private readonly replies = new Map<string, Reply[]>();
	private readonly startWaiters: Array<{ count: number; resolve: () => void }> = [];

	constructor(replies: Record<string, Reply[]> = {}) {
		for (const [state, items] of Object.entries(replies)) {
			this.replies.set(state, [...items]);
		}
	}

	start(effect: AgentEffect, emit: EmitCompletion): void {
		this.starts.push(effect);
		this.resolveStartWaiters();
		this.emitNext(effect.actionUid.state, emit);
	}

	reject(effect: RejectedEffect, emit: EmitCompletion): void {
		this.rejects.push(effect);
		this.emitNext(effect.actionUid.state, emit);
	}

	cancel(actionUid: ActionUID): void {
		this.cancels.push(actionUid);
	}

	async dispose(): Promise<void> {}

	waitForStart(count = this.starts.length + 1): Promise<void> {
		if (this.starts.length >= count) return Promise.resolve();
		return new Promise((resolve) => {
			this.startWaiters.push({ count, resolve });
		});
	}

	private emitNext(state: string, emit: EmitCompletion): void {
		const reply = this.replies.get(state)?.shift();
		if (reply !== undefined) {
			queueMicrotask(() => emit(reply));
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
