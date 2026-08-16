import type { Runtime } from "../runtime.js";
import type { ChartAst, GuardOutcome } from "../../core/types.js";
import type { SchemaRegistryLike } from "../../core/schema_registry.js";
import type { BranchId, DurableLogRecord } from "../../core/durable_events.js";
import type { Effect, MachineEvent, RejectedEffect } from "../../core/machine.js";
import { actorContextForState } from "../../core/actors.js";
import { nodeAt } from "../../core/paths.js";
import { createAsyncQueue, type AsyncQueue } from "../../utils/async_queue.js";
import { errorMessage } from "../../utils/errors.js";
import type { AgentExecutor } from "./agent_executor.js";
import type { UserExecutor } from "./user_executor.js";
import type { LogStore } from "./log_store.js";
import { runGuard, type RenderedGuardInvocation } from "./guards.js";
import { ScriptRunner } from "./script_runner.js";
import { checkSchemaAsync } from "./schema.js";

export type ChartRuntimeOptions = {
	ast: ChartAst;
	/** Explicit non-durable branch handle for replay and every append. */
	branchId: BranchId;
	logStore: LogStore;
	agentExecutor: AgentExecutor;
	/** Required only when this runtime may execute user actions; detached runners always provide it. */
	userExecutor?: UserExecutor;
	workDir: string;
	chartDir: string;
	schemaRegistry?: SchemaRegistryLike;
	now?: () => number;
	onWarn?: (msg: string) => void;
};

export class ChartRuntime implements Runtime {
	readonly branchId: BranchId;
	private readonly queue: AsyncQueue<MachineEvent> = createAsyncQueue<MachineEvent>();
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private readonly scripts: ScriptRunner;
	private readonly now: () => number;
	private readonly onWarn: (msg: string) => void;

	constructor(private readonly options: ChartRuntimeOptions) {
		if (options.logStore.branchId !== options.branchId) {
			throw new Error(`ChartRuntime branch '${options.branchId}' does not match log store branch '${options.logStore.branchId}'`);
		}
		this.branchId = options.branchId;
		this.scripts = new ScriptRunner({
			workDir: options.workDir,
			...(options.schemaRegistry === undefined ? {} : { schemaRegistry: options.schemaRegistry }),
		});
		this.now = options.now ?? Date.now;
		this.onWarn = options.onWarn ?? (() => {});
	}

	runEffects(effects: Effect[]): void {
		for (const effect of effects) {
			switch (effect.kind) {
				case "durable_records": {
					const records = this.options.logStore.appendDrafts(effect.records);
					this.queue.send({ kind: "durable_records_added", effectId: effect.id, records });
					break;
				}
				case "actor_create":
					void checkSchemaAsync(effect.declaration.input, effect.input, this.options.schemaRegistry).then((check) => {
						this.queue.send({
							kind: "actor_effect",
							effectId: effect.id,
							operation: "create",
							ok: check.ok,
							...(check.ok ? {} : { error: `Actor input does not match exact placement schema: ${check.errors.join("; ")}` }),
						});
					});
					break;
				case "actor_enqueue":
					void Promise.all(effect.messages.map((message) => checkSchemaAsync(effect.schema, message.input, this.options.schemaRegistry))).then((checks) => {
						const errors = checks.flatMap((check, index) => check.ok ? [] : check.errors.map((error) => `inputs[${index}]: ${error}`));
						this.queue.send({
							kind: "actor_effect",
							effectId: effect.id,
							operation: "enqueue",
							ok: errors.length === 0,
							...(errors.length === 0 ? {} : { error: `Atomic actor batch validation failed: ${errors.join("; ")}` }),
						});
					});
					break;
				case "actor_reply":
					void (effect.schema === undefined
						? Promise.resolve({ ok: true } as const)
						: checkSchemaAsync(effect.schema, effect.output, this.options.schemaRegistry)
					).then((check) => {
						this.queue.send({
							kind: "actor_effect",
							effectId: effect.id,
							operation: "reply",
							ok: check.ok,
							...(check.ok ? {} : { error: `Actor reply does not match exact protocol schema: ${check.errors.join("; ")}` }),
						});
					});
					break;
				case "agent":
					this.options.agentExecutor.start(effect, (event) => {
						this.queue.send({ kind: "agent", effectId: effect.id, event });
					});
					break;
				case "script":
					void this.scripts
						.run(effect)
						.then((event) => this.queue.send({ kind: "script", effectId: effect.id, event }))
						.catch((error: unknown) =>
							this.queue.send({ kind: "script", effectId: effect.id, event: toFailedEvent(error) }),
						);
					break;
				case "validate": {
					void runGuard(
						effect.guard,
						effect.event,
						{ chartDir: this.options.chartDir, workDir: this.options.workDir },
						{
							scripts: this.scripts,
							...(effect.env === undefined ? {} : { env: effect.env }),
							...(effect.artifacts === undefined ? {} : { artifacts: effect.artifacts }),
							...(effect.reply === undefined ? {} : { reply: effect.reply }),
							actionUid: effect.actionUid,
						} satisfies RenderedGuardInvocation,
					)
						.catch((error: unknown): GuardOutcome => ({ ok: false, reason: errorMessage(error) }))
						.then((outcome) => this.queue.send({ kind: "validated", effectId: effect.id, outcome }));
					break;
				}
				case "rejected":
					this.dispatchRejected(effect);
					break;
				case "timer": {
					const delay = Math.max(0, effect.firesAt - this.now());
					const timer = setTimeout(() => {
						this.timers.delete(effect.id);
						this.queue.send({ kind: "timer", effectId: effect.id });
					}, delay);
					timer.unref();
					this.timers.set(effect.id, timer);
					break;
				}
				case "cancel": {
					const cancellations = [
						this.options.agentExecutor.cancel(effect.actionUid),
						...(this.options.userExecutor === undefined ? [] : [this.options.userExecutor.cancel(effect.actionUid)]),
						this.scripts.cancel(effect.actionUid),
					];
					void Promise.all(cancellations).catch((error: unknown) => {
						this.onWarn(`Cancellation ${effect.id} failed: ${errorMessage(error)}`);
					});
					break;
				}
				case "user":
					if (this.options.userExecutor === undefined) {
						throw new Error("ChartRuntime requires a userExecutor to execute user actions");
					}
					this.options.userExecutor.start(effect, (event) => {
						this.queue.send({ kind: "user", effectId: effect.id, event });
					});
					break;
			}
		}
	}

	eventsQueue(): AsyncIterable<MachineEvent> {
		return this.queue;
	}

	async loadAst(): Promise<ChartAst> {
		return this.options.ast;
	}

	async loadLogs(): Promise<readonly DurableLogRecord[]> {
		return this.options.logStore.readAll();
	}

	async dispose(): Promise<void> {
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();
		await this.scripts.dispose();
		await this.options.agentExecutor.dispose();
		await this.options.userExecutor?.dispose();
		this.queue.close();
	}

	private dispatchRejected(effect: RejectedEffect): void {
		const mainState = nodeAt(this.options.ast, effect.actionUid.state);
		const actorState = actorContextForState(this.options.ast, effect.actionUid.state)?.node;
		const state = mainState?.kind === "state" ? mainState : actorState?.kind === "state" ? actorState : undefined;
		if (state === undefined) {
			this.queue.send({
				kind: "agent",
				effectId: effect.id,
				event: toFailedEvent(`Rejected effect for non-action state ${effect.actionUid.state}`),
			});
			return;
		}
		if (state.action.kind === "agent") {
			this.options.agentExecutor.reject(effect, (event) => {
				this.queue.send({ kind: "agent", effectId: effect.id, event });
			});
			return;
		}
		if (state.action.kind === "script") {
			const scriptEffect = effect.invocation.kind === "script" ? effect.invocation : undefined;
			if (scriptEffect === undefined) {
				this.queue.send({
					kind: "script",
					effectId: effect.id,
					event: toFailedEvent("Cannot retry rejected script: replay-derived script invocation is missing"),
				});
				return;
			}
			void this.scripts
				.run(scriptEffect, {
					n: effect.validationAttempts,
					...(effect.reason === undefined ? {} : { reason: effect.reason }),
				})
				.then((event) => this.queue.send({ kind: "script", effectId: effect.id, event }))
				.catch((error: unknown) =>
					this.queue.send({ kind: "script", effectId: effect.id, event: toFailedEvent(error) }),
				);
			return;
		}
		if (state.action.kind === "user") {
			if (this.options.userExecutor === undefined) {
				this.queue.send({
					kind: "user",
					effectId: effect.id,
					event: toFailedEvent("ChartRuntime requires a userExecutor to retry user actions"),
				});
				return;
			}
			try {
				this.options.userExecutor.reject(effect, (event) => {
					this.queue.send({ kind: "user", effectId: effect.id, event });
				});
			} catch (error) {
				this.queue.send({ kind: "user", effectId: effect.id, event: toFailedEvent(error) });
			}
			return;
		}
	}
}

function toFailedEvent(error: unknown): { type: "FAILED"; error: string } {
	return { type: "FAILED", error: errorMessage(error) };
}
