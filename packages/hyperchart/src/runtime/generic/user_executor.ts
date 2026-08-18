import { actionUidKey } from "../../core/action_uid.js";
import type { ActionUID } from "../../core/types.js";
import type { BranchId } from "../../core/durable_events.js";
import type { SchemaRegistryLike } from "../../core/schema_registry.js";
import type { RejectedEffect, UserEffect } from "../../core/machine.js";
import type { EmitCompletion } from "./agent_executor.js";
import {
	closeUserInteraction,
	persistUserInteractionRequest,
	readUserInteractionClose,
	readUserInteractionRequest,
	readUserInteractionResponse,
	validateUserInteractionEvent,
} from "./user_interactions.js";

export interface UserExecutor {
	start(effect: UserEffect, emit: EmitCompletion): void;
	reject(effect: RejectedEffect, emit: EmitCompletion): void;
	/** Resolves only after polling/validation for the cancelled phase has quiesced. */
	cancel(actionUid: ActionUID): Promise<void>;
	dispose(): Promise<void>;
}

export type FileUserExecutorOptions = Readonly<{
	runId: string;
	runDir: string;
	branchId: BranchId;
	pollMs?: number;
	schemaRegistry?: SchemaRegistryLike;
	onWarn?: (message: string) => void;
}>;

type LiveUserPhase = {
	seqId: number;
	actionUid: ActionUID;
	emit: EmitCompletion;
	timer: NodeJS.Timeout;
	emitted: boolean;
	checking: boolean;
	polling?: Promise<void>;
	lastError?: string;
};

/** File-backed durable rendezvous for user actions. */
export class FileUserExecutor implements UserExecutor {
	private readonly live = new Map<number, LiveUserPhase>();
	private readonly cancellations = new Map<string, Promise<void>>();
	private readonly pollMs: number;
	private readonly onWarn: (message: string) => void;
	private disposed = false;

	constructor(private readonly options: FileUserExecutorOptions) {
		this.pollMs = options.pollMs ?? 250;
		this.onWarn = options.onWarn ?? (() => {});
	}

	start(effect: UserEffect, emit: EmitCompletion): void {
		this.begin(effect, emit);
	}

	reject(effect: RejectedEffect, emit: EmitCompletion): void {
		if (effect.invocation.kind !== "user") {
			throw new Error(`Cannot retry non-user invocation with FileUserExecutor (${effect.invocation.kind})`);
		}
		this.begin(
			{
				...effect.invocation,
				id: effect.id,
				seqId: effect.seqId,
			},
			emit,
			{
				attempt: effect.validationAttempts,
				onReject: effect.onReject,
				...(effect.reason === undefined ? {} : { reason: effect.reason }),
			},
		);
	}

	cancel(actionUid: ActionUID): Promise<void> {
		const key = actionUidKey(actionUid);
		const existing = this.cancellations.get(key);
		if (existing !== undefined) return existing;
		const phases = [...this.live.entries()].filter(([, phase]) => actionUidKey(phase.actionUid) === key);
		for (const [seqId, phase] of phases) {
			clearInterval(phase.timer);
			this.live.delete(seqId);
			try {
				closeUserInteraction(
					this.options.runDir,
					{ runId: this.options.runId, branchId: this.options.branchId, seqId },
					"machine_abandoned",
				);
			} catch (error) {
				this.onWarn(`Failed to close user interaction (${this.options.runId}, ${seqId}): ${errorMessage(error)}`);
			}
		}
		const cancellation = Promise.all(phases.map(([, phase]) => phase.polling)).then(() => undefined);
		this.cancellations.set(key, cancellation);
		void cancellation.finally(() => {
			if (this.cancellations.get(key) === cancellation) this.cancellations.delete(key);
		});
		return cancellation;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const phases = [...this.live.values()];
		for (const phase of phases) clearInterval(phase.timer);
		this.live.clear();
		// Deliberately do not close mailbox phases: operator stop/dispose is resumable.
		// Validation already in flight must still quiesce before the owning runtime closes its queue.
		await Promise.allSettled(phases.map((phase) => phase.polling));
	}

	private begin(
		effect: UserEffect,
		emit: EmitCompletion,
		rejection?: { attempt: number; onReject: "resume" | "restart"; reason?: string },
	): void {
		if (this.disposed) throw new Error("FileUserExecutor is disposed");
		if (this.live.has(effect.seqId)) return;
		persistUserInteractionRequest(this.options.runDir, {
			runId: this.options.runId,
			branchId: this.options.branchId,
			seqId: effect.seqId,
			actionUid: effect.actionUid,
			prompt: effect.prompt,
			options: effect.action.options,
			events: effect.events,
			...(effect.reply === undefined ? {} : { reply: effect.reply }),
			...(rejection === undefined ? {} : { rejection }),
		});
		let phase: LiveUserPhase;
		const poll = () => {
			if (phase.polling !== undefined) return;
			const polling = this.poll(phase);
			phase.polling = polling;
			void polling.finally(() => {
				if (phase.polling === polling) delete phase.polling;
			});
		};
		phase = {
			seqId: effect.seqId,
			actionUid: effect.actionUid,
			emit,
			timer: setInterval(poll, this.pollMs),
			emitted: false,
			checking: false,
		};
		// Keep this interval referenced: an unresolved promise alone does not keep the
		// detached runner alive while every active branch is waiting for the user.
		this.live.set(effect.seqId, phase);
		poll();
	}

	private async poll(phase: LiveUserPhase): Promise<void> {
		if (phase.emitted || phase.checking || this.disposed || this.live.get(phase.seqId) !== phase) return;
		phase.checking = true;
		try {
			if (readUserInteractionClose(this.options.runDir, this.options.branchId, phase.seqId) !== undefined) {
				clearInterval(phase.timer);
				this.live.delete(phase.seqId);
				return;
			}
			const response = readUserInteractionResponse(this.options.runDir, this.options.branchId, phase.seqId);
			if (response === undefined) return;
			if (response.runId !== this.options.runId || response.branchId !== this.options.branchId || response.seqId !== phase.seqId) {
				throw new Error("response coordinate does not match its mailbox directory");
			}
			const request = readUserInteractionRequest(this.options.runDir, this.options.branchId, phase.seqId);
			if (request === undefined) throw new Error("response has no matching request");
			await validateUserInteractionEvent(request, response.event, this.options.schemaRegistry);
			if (this.disposed || this.live.get(phase.seqId) !== phase) return;
			phase.emitted = true;
			clearInterval(phase.timer);
			this.live.delete(phase.seqId);
			phase.emit(response.event);
		} catch (error) {
			const message = `Invalid user interaction response (${this.options.runId}, ${phase.seqId}): ${errorMessage(error)}`;
			if (phase.lastError !== message) {
				phase.lastError = message;
				this.onWarn(message);
			}
		} finally {
			phase.checking = false;
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
