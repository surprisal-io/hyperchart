import { promises as fsp } from "node:fs";
import { dirname } from "node:path";
import type { Runtime } from "../runtime.js";
import type { ChartAst, ChartEvent, GuardOutcome } from "../../core/types.js";
import type { SchemaRegistryLike } from "../../core/schema_registry.js";
import type { ArtifactPin, BranchId, DurableLogRecord } from "../../core/durable_events.js";
import type { AgentEffect, Effect, MachineEvent, RejectedEffect, RenderedArtifact } from "../../core/machine.js";
import { ArtifactStore, hashFile } from "./artifact_store.js";
import { renderedArtifactPath } from "./artifacts.js";
import type { SchemaCheck } from "./schema.js";
import { actorContextForState } from "../../core/actors.js";
import { nodeAt } from "../../core/paths.js";
import { createAsyncQueue, type AsyncQueue } from "../../utils/async_queue.js";
import { errorMessage } from "../../utils/errors.js";
import type { AgentExecutor } from "./agent_executor.js";
import type { CheckpointRepository, LogStore, PrepareStampedCommit } from "./log_store.js";
import { runGuard, type RenderedGuardInvocation } from "./guards.js";
import { ScriptRunner } from "./script_runner.js";
import { checkSchemaAsync } from "./schema.js";

export type ChartRuntimeOptions = {
	ast: ChartAst;
	/** Explicit non-durable branch handle for replay and every append. */
	branchId: BranchId;
	logStore: LogStore & CheckpointRepository;
	/** Execution-owned opaque prepare/confirm callback invoked under the store writer boundary. */
	prepareStampedCommit?: PrepareStampedCommit;
	/** Execution-owned semantic validation over runtime-acquired immutable bytes. */
	validateArtifactSnapshot?: (artifact: RenderedArtifact, content: string) => Promise<SchemaCheck>;
	agentExecutor: AgentExecutor;
	/** Repository/project directory that owns the run. Scripts remain cwd-scoped to workDir. */
	projectDir?: string;
	/** Branch-isolated workspace used as the action cwd. */
	workDir: string;
	chartDir: string;
	/** Enables artifact pinning: accepted deliverables are snapshotted into `<runDir>/artifact_store`. */
	runDir?: string;
	schemaRegistry?: SchemaRegistryLike;
	now?: () => number;
	onWarn?: (msg: string) => void;
};

export class ChartRuntime implements Runtime {
	readonly branchId: BranchId;
	private readonly queue: AsyncQueue<MachineEvent> = createAsyncQueue<MachineEvent>();
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private readonly scripts: ScriptRunner;
	private readonly artifactStore?: ArtifactStore;
	private readonly now: () => number;
	private readonly onWarn: (msg: string) => void;
	private readonly pending = new Set<Promise<void>>();
	private readonly effectRuns = new Set<Promise<void>>();
	private readonly backgroundErrors: unknown[] = [];
	/** While set, completions are held back so they cannot overtake a pending durable append. */
	private sendBuffer: MachineEvent[] | undefined;
	private quiescing = false;
	private disposed = false;
	private disposal?: Promise<void>;

	constructor(private readonly options: ChartRuntimeOptions) {
		if (options.logStore.branchId !== options.branchId) {
			throw new Error(`ChartRuntime branch '${options.branchId}' does not match log store branch '${options.logStore.branchId}'`);
		}
		this.branchId = options.branchId;
		this.scripts = new ScriptRunner({
			workDir: options.workDir,
			projectDir: options.projectDir ?? options.workDir,
			...(options.schemaRegistry === undefined ? {} : { schemaRegistry: options.schemaRegistry }),
		});
		if (options.runDir !== undefined) this.artifactStore = new ArtifactStore(options.runDir);
		this.now = options.now ?? Date.now;
		this.onWarn = options.onWarn ?? (() => {});
	}

	/** Composition metadata used by the execution layer; contains no projection state. */
	executionInputs(): { ast: ChartAst; store: LogStore & CheckpointRepository; schemaRegistry?: SchemaRegistryLike } {
		return { ast: this.options.ast, store: this.options.logStore, ...(this.options.schemaRegistry === undefined ? {} : { schemaRegistry: this.options.schemaRegistry }) };
	}

	/** Composition hook: accepts an opaque callback without importing execution semantics. */
	bindArtifactValidator(validate: (artifact: RenderedArtifact, content: string) => Promise<SchemaCheck>): void {
		if (this.options.validateArtifactSnapshot !== undefined && this.options.validateArtifactSnapshot !== validate) throw new Error("ChartRuntime artifact validator is already bound");
		this.options.validateArtifactSnapshot = validate;
	}

	bindStampedCommit(prepare: PrepareStampedCommit): void {
		if (this.options.prepareStampedCommit !== undefined && this.options.prepareStampedCommit !== prepare) throw new Error("ChartRuntime commit preparer is already bound");
		this.options.prepareStampedCommit = prepare;
	}

	runEffects(effects: Effect[]): Promise<void> {
		if (this.quiescing) return Promise.resolve();
		let tracked!: Promise<void>;
		tracked = this.performRunEffects(effects).finally(() => this.effectRuns.delete(tracked));
		this.effectRuns.add(tracked);
		return tracked;
	}

	private async performRunEffects(effects: Effect[]): Promise<void> {
		if (this.quiescing) return;
		// The machine drops completions whose invoke facts it has not projected yet, so no
		// event may be delivered between dispatching this batch and enqueueing its
		// durable_records_added acknowledgements. Buffer sends until the batch settles.
		this.sendBuffer = [];
		try {
			for (const effect of effects) {
				if (this.quiescing) return;
				switch (effect.kind) {
				case "durable_records": {
					const records = await this.options.logStore.appendDrafts(effect.records, this.options.prepareStampedCommit);
					if (!this.quiescing) this.queue.send({ kind: "durable_records_added", effectId: effect.id, records });
					break;
				}
				case "actor_create":
					this.track(
						checkSchemaAsync(effect.declaration.input, effect.input, this.options.schemaRegistry).then((check) => {
							this.send({
								kind: "actor_effect",
								effectId: effect.id,
								operation: "create",
								ok: check.ok,
								...(check.ok ? {} : { error: `Actor input does not match exact placement schema: ${check.errors.join("; ")}` }),
							});
						}),
					);
					break;
				case "actor_enqueue":
					this.track(
						Promise.all(effect.messages.map((message) => checkSchemaAsync(effect.schema, message.input, this.options.schemaRegistry))).then((checks) => {
							const errors = checks.flatMap((check, index) => check.ok ? [] : check.errors.map((error) => `inputs[${index}]: ${error}`));
							this.send({
								kind: "actor_effect",
								effectId: effect.id,
								operation: "enqueue",
								ok: errors.length === 0,
								...(errors.length === 0 ? {} : { error: `Atomic actor batch validation failed: ${errors.join("; ")}` }),
							});
						}),
					);
					break;
				case "actor_reply":
					this.track(
						(effect.schema === undefined
							? Promise.resolve({ ok: true } as const)
							: checkSchemaAsync(effect.schema, effect.output, this.options.schemaRegistry)
						).then((check) => {
							this.send({
								kind: "actor_effect",
								effectId: effect.id,
								operation: "reply",
								ok: check.ok,
								...(check.ok ? {} : { error: `Actor reply does not match exact protocol schema: ${check.errors.join("; ")}` }),
							});
						}),
					);
					break;
				case "agent":
					this.track(
						this.restorePinnedReads(effect.reads)
							.then(() => {
								if (this.quiescing) return;
								this.options.agentExecutor.start(effect, (event) => this.dispatchAgentCompletion(effect, event));
							})
							.catch((error: unknown) => {
								this.send({ kind: "agent", effectId: effect.id, event: toFailedEvent(error) });
							}),
					);
					break;
				case "script":
					this.track(
						this.restorePinnedReads(envArtifacts(effect.env))
							.then(() => this.quiescing ? undefined : this.scripts.run(effect))
							.then((event) => event === undefined || this.quiescing ? undefined : this.admitCompletion(event, effect.artifacts))
							.then((admitted) => {
								if (admitted !== undefined) this.send({ kind: "script", effectId: effect.id, ...admitted });
							})
							.catch((error: unknown) => {
								this.send({ kind: "script", effectId: effect.id, event: toFailedEvent(error) });
							}),
					);
					break;
				case "validate": {
					this.track(
						runGuard(
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
							.then((outcome) => this.send({ kind: "validated", effectId: effect.id, outcome })),
					);
					break;
				}
				case "rejected":
					this.dispatchRejected(effect);
					break;
				case "timer": {
					const delay = Math.max(0, effect.firesAt - this.now());
					const timer = setTimeout(() => {
						this.timers.delete(effect.id);
						this.send({ kind: "timer", effectId: effect.id });
					}, delay);
					timer.unref();
					this.timers.set(effect.id, timer);
					break;
				}
				case "cancel": {
					const cancellations = [
						this.options.agentExecutor.cancel(effect.actionUid),
						this.scripts.cancel(effect.actionUid),
					];
					this.track(Promise.allSettled(cancellations).then((results) => {
						for (const result of results) {
							if (result.status === "rejected") this.onWarn(`Cancellation ${effect.id} failed: ${errorMessage(result.reason)}`);
						}
					}));
					break;
				}

				}
			}
		} finally {
			const buffered = this.sendBuffer;
			this.sendBuffer = undefined;
			if (buffered !== undefined) for (const event of buffered) this.send(event);
		}
	}

	/** Queue records committed by an external control path; execution was confirmed under the store writer boundary. */
	acknowledgeCommittedRecords(records: readonly DurableLogRecord[], effectId: string): void {
		if (records.length === 0 || this.disposed) return;
		this.send({ kind: "durable_records_added", effectId, records });
	}

	eventsQueue(): AsyncIterable<MachineEvent> {
		return this.queue;
	}

	/** Synchronously reject new effects and late host callbacks without finalizing durable state. */
	beginDrain(): void {
		if (this.quiescing) return;
		this.quiescing = true;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}

	dispose(): Promise<void> {
		if (this.disposal !== undefined) return this.disposal;
		this.beginDrain();
		this.disposed = true;
		this.disposal = this.performDispose();
		return this.disposal;
	}

	private async performDispose(): Promise<void> {
		const cleanups = [
			Promise.resolve().then(() => this.scripts.dispose()),
			Promise.resolve().then(() => this.options.agentExecutor.dispose()),
		];
		const cleanupResults = await Promise.allSettled(cleanups);
		while (this.effectRuns.size > 0) await Promise.allSettled([...this.effectRuns]);
		await this.drainPending();
		this.queue.close();
		const errors = [
			...cleanupResults.flatMap((result) => result.status === "rejected" ? [result.reason] : []),
			...this.backgroundErrors,
		];
		if (errors.length > 0) {
			throw new AggregateError(errors, `ChartRuntime disposal failed: ${errors.map(errorMessage).join("; ")}`);
		}
	}

	private track(task: Promise<unknown>): void {
		let tracked!: Promise<void>;
		tracked = task.then(
			() => undefined,
			(error: unknown) => {
				this.backgroundErrors.push(error);
				this.onWarn(`Runtime background task failed: ${errorMessage(error)}`);
			},
		).finally(() => {
			this.pending.delete(tracked);
		});
		this.pending.add(tracked);
	}

	private async drainPending(): Promise<void> {
		while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
	}

	private send(event: MachineEvent): void {
		if (this.quiescing) return;
		if (this.sendBuffer !== undefined) {
			this.sendBuffer.push(event);
			return;
		}
		this.queue.send(event);
	}

	private dispatchAgentCompletion(effect: AgentEffect, event: ChartEvent): void {
		if (this.quiescing) return;
		this.track(
			this.admitCompletion(event, effect.artifacts)
				.then((admitted) => this.send({ kind: "agent", effectId: effect.id, ...admitted }))
				.catch((error: unknown) => {
					this.send({ kind: "agent", effectId: effect.id, event: toFailedEvent(error) });
				}),
		);
	}

	/**
	 * Action entry: restore each declared read to its pinned revision. The runtime cannot control
	 * how agents read files, so the guarantee is placed on entry — whatever overwrote the authored
	 * path (a sibling branch, an out-of-band edit), the action sees the accepted state its chart
	 * channel declared. Reads whose producer completion carries no pin keep current-file semantics.
	 */
	private async restorePinnedReads(reads: readonly RenderedArtifact[] | undefined): Promise<void> {
		const store = this.artifactStore;
		if (store === undefined || reads === undefined || reads.length === 0) return;
		for (const artifact of reads) {
			const pin = artifact.pin;
			if (pin === undefined) continue;
			const path = renderedArtifactPath(artifact, this.options.workDir);
			if (await matchesHash(path, pin.hash)) continue;
			const source = await store.get(pin.hash);
			await fsp.mkdir(dirname(path), { recursive: true });
			await fsp.copyFile(source, path);
		}
	}

	/**
	 * Completion admission: snapshot each declared deliverable into the artifact store (copy, then
	 * hash the copy) and re-check the stored bytes, so the pinned revision — not the still-mutable
	 * working file — is what the log accepts. Without a store the completion is admitted unpinned.
	 */
	private async admitCompletion(
		event: ChartEvent,
		artifacts: readonly RenderedArtifact[] | undefined,
	): Promise<{ event: ChartEvent; artifacts?: Readonly<Record<string, ArtifactPin>> }> {
		const store = this.artifactStore;
		if (event.type === "FAILED" || store === undefined || artifacts === undefined || artifacts.length === 0) {
			return { event };
		}
		try {
			const pins: Record<string, ArtifactPin> = {};
			for (const artifact of artifacts) {
				const pin = await store.put(renderedArtifactPath(artifact, this.options.workDir));
				if (artifact.shape !== undefined) {
					const content = await fsp.readFile(store.objectPath(pin.hash), "utf8");
					const validate = this.options.validateArtifactSnapshot;
					if (validate === undefined) throw new Error("Execution did not provide artifact snapshot validation");
					const check = await validate(artifact, content);
					if (!check.ok) {
						throw new Error(`Artifact ${artifact.path}: snapshotted content is invalid: ${check.errors.join("; ")}`);
					}
				}
				pins[artifact.path] = pin;
			}
			return { event, artifacts: pins };
		} catch (error) {
			return { event: toFailedEvent(error) };
		}
	}

	private dispatchRejected(effect: RejectedEffect): void {
		if (this.quiescing) return;
		const mainState = nodeAt(this.options.ast, effect.actionUid.state);
		const actorState = actorContextForState(this.options.ast, effect.actionUid.state)?.node;
		const state = mainState?.kind === "state" ? mainState : actorState?.kind === "state" ? actorState : undefined;
		if (state === undefined) {
			this.send({
				kind: "agent",
				effectId: effect.id,
				event: toFailedEvent(`Rejected effect for non-action state ${effect.actionUid.state}`),
			});
			return;
		}
		if (state.action.kind === "agent") {
			const artifacts = effect.invocation.kind === "agent" ? effect.invocation.artifacts : undefined;
			this.options.agentExecutor.reject(effect, (event) => {
				if (this.quiescing) return;
				this.track(
					this.admitCompletion(event, artifacts)
						.then((admitted) => this.send({ kind: "agent", effectId: effect.id, ...admitted }))
						.catch((error: unknown) => {
							this.send({ kind: "agent", effectId: effect.id, event: toFailedEvent(error) });
						}),
				);
			});
			return;
		}
		if (state.action.kind === "script") {
			const scriptEffect = effect.invocation.kind === "script" ? effect.invocation : undefined;
			if (scriptEffect === undefined) {
				this.send({
					kind: "script",
					effectId: effect.id,
					event: toFailedEvent("Cannot retry rejected script: replay-derived script invocation is missing"),
				});
				return;
			}
			this.track(
				this.scripts
					.run(scriptEffect, {
						n: effect.validationAttempts,
						...(effect.reason === undefined ? {} : { reason: effect.reason }),
					})
					.then((event) => this.quiescing ? undefined : this.admitCompletion(event, scriptEffect.artifacts))
					.then((admitted) => {
						if (admitted !== undefined) this.send({ kind: "script", effectId: effect.id, ...admitted });
					})
					.catch((error: unknown) => {
						this.send({ kind: "script", effectId: effect.id, event: toFailedEvent(error) });
					}),
			);
			return;
		}
	}
}

function toFailedEvent(error: unknown): { type: "FAILED"; error: string } {
	return { type: "FAILED", error: errorMessage(error) };
}

function envArtifacts(env: Readonly<Record<string, string | RenderedArtifact>> | undefined): RenderedArtifact[] {
	return Object.values(env ?? {}).filter((value): value is RenderedArtifact => typeof value !== "string");
}


async function matchesHash(path: string, hash: string): Promise<boolean> {
	try {
		return (await hashFile(path)) === hash;
	} catch {
		return false;
	}
}
