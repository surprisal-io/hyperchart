import { actionUidKey } from "../../core/action_uid.js";
import type { ActionUID } from "../../core/types.js";
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
	cancel(actionUid: ActionUID): void;
	dispose(): Promise<void>;
}

export type FileUserExecutorOptions = Readonly<{
	runId: string;
	runDir: string;
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
	lastError?: string;
};

/** File-backed durable rendezvous for user actions. */
export class FileUserExecutor implements UserExecutor {
	private readonly live = new Map<number, LiveUserPhase>();
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

	cancel(actionUid: ActionUID): void {
		const key = actionUidKey(actionUid);
		for (const [seqId, phase] of this.live) {
			if (actionUidKey(phase.actionUid) !== key) continue;
			clearInterval(phase.timer);
			this.live.delete(seqId);
			try {
				closeUserInteraction(
					this.options.runDir,
					{ runId: this.options.runId, seqId },
					"machine_abandoned",
				);
			} catch (error) {
				this.onWarn(`Failed to close user interaction (${this.options.runId}, ${seqId}): ${errorMessage(error)}`);
			}
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		for (const phase of this.live.values()) clearInterval(phase.timer);
		this.live.clear();
		// Deliberately do not close mailbox phases: operator stop/dispose is resumable.
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
			seqId: effect.seqId,
			actionUid: effect.actionUid,
			prompt: effect.prompt,
			options: effect.action.options,
			events: effect.events,
			...(effect.reply === undefined ? {} : { reply: effect.reply }),
			...(rejection === undefined ? {} : { rejection }),
		});
		let phase: LiveUserPhase;
		const poll = () => void this.poll(phase);
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
		void this.poll(phase);
	}

	private async poll(phase: LiveUserPhase): Promise<void> {
		if (phase.emitted || phase.checking || this.disposed || this.live.get(phase.seqId) !== phase) return;
		phase.checking = true;
		try {
			if (readUserInteractionClose(this.options.runDir, phase.seqId) !== undefined) {
				clearInterval(phase.timer);
				this.live.delete(phase.seqId);
				return;
			}
			const response = readUserInteractionResponse(this.options.runDir, phase.seqId);
			if (response === undefined) return;
			if (response.runId !== this.options.runId || response.seqId !== phase.seqId) {
				throw new Error("response coordinate does not match its mailbox directory");
			}
			const request = readUserInteractionRequest(this.options.runDir, phase.seqId);
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
