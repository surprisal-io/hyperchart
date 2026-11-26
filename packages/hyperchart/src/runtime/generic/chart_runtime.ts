import type { ActionUID } from "../../core/types.js";
import { resolveRunPaths } from "./run_paths.js";
import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";
import { actionUidKey } from "../../core/action_uid.js";
import type { Runtime } from "../runtime.js";
import type { ChartAst, ChartEvent, GuardOutcome } from "../../core/types.js";
import type { SchemaRegistryLike } from "../../core/schema_registry.js";
import type { ArtifactPin, BranchId, DurableLogRecord } from "../../core/durable_events.js";
import {
	isJoinedArtifacts,
	type AgentEffect,
	type AgentOutcome,
	type BorrowEffect,
	type Effect,
	type MachineEvent,
	type RenderedArtifact,
	type RenderedEnvValue,
} from "../../core/machine.js";
import { ArtifactStore } from "./artifact_store.js";
import { agentRetryDelayMs, isTransientProviderFailure } from "./agent_retry_backoff.js";
import { renderedArtifactPath } from "./artifacts.js";
import { materializeWorkspaceFromPins } from "./artifact_workspace.js";
import type { SchemaCheck } from "./schema.js";
import { createAsyncQueue, type AsyncQueue } from "../../utils/async_queue.js";
import { errorMessage } from "../../utils/errors.js";
import type { AgentExecutor } from "./agent_executor.js";
import type { CheckpointRepository, LogStore, PrepareStampedCommit } from "./log_store.js";
import { runGuard, type RenderedGuardInvocation } from "./guards.js";
import { ScriptRunner, type RenderedScriptEnv } from "./script_runner.js";
import { FunctionRunner } from "./function_runner.js";
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
	runId?: string;
	schemaRegistry?: SchemaRegistryLike;
	/** Host services handed to imported guards and actions in this process; never journaled. */
	hostServices?: unknown;
	now?: () => number;
	onWarn?: (msg: string) => void;
};

export class ChartRuntime implements Runtime {
	readonly branchId: BranchId;
	private readonly queue: AsyncQueue<MachineEvent> = createAsyncQueue<MachineEvent>();
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private readonly delayedAgents = new Map<string, { actionUid: AgentEffect["actionUid"]; cancel(): void }>();
	private readonly scripts: ScriptRunner;
	private readonly functions: FunctionRunner;
	private readonly artifactStore?: ArtifactStore;
	/**
	 * Operational occupancy of rollback working files mounted by a borrow effect and not yet restored:
	 * detects conflicting borrowers, lets actions with the same view share one mount, and lets
	 * disposal restore views the machine could not release.
	 */
	private readonly borrowedPaths = new Map<string, { holders: Set<string>; artifact: RenderedArtifact }>();
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
			throw new Error(
				`ChartRuntime branch '${options.branchId}' does not match log store branch '${options.logStore.branchId}'`,
			);
		}
		this.branchId = options.branchId;
		this.scripts = new ScriptRunner({
			workDir: options.workDir,
			projectDir: options.projectDir ?? options.workDir,
			...(options.schemaRegistry === undefined ? {} : { schemaRegistry: options.schemaRegistry }),
		});
		this.functions = new FunctionRunner({
			chartDir: options.chartDir,
			workDir: options.workDir,
			projectDir: options.projectDir ?? options.workDir,
			...(options.schemaRegistry === undefined ? {} : { schemaRegistry: options.schemaRegistry }),
			...(options.hostServices === undefined ? {} : { hostServices: options.hostServices }),
		});
		if (options.runId !== undefined) {
			this.artifactStore = new ArtifactStore(resolveRunPaths(options.runId).runDir);
		}
		this.now = options.now ?? Date.now;
		this.onWarn = options.onWarn ?? (() => {});
	}

	executionInputs(): { ast: ChartAst; store: LogStore & CheckpointRepository; schemaRegistry?: SchemaRegistryLike } {
		return {
			ast: this.options.ast,
			store: this.options.logStore,
			...(this.options.schemaRegistry === undefined ? {} : { schemaRegistry: this.options.schemaRegistry }),
		};
	}

	/** Composition hook: accepts an opaque callback without importing execution semantics. */
	bindArtifactValidator(validate: (artifact: RenderedArtifact, content: string) => Promise<SchemaCheck>): void {
		if (this.options.validateArtifactSnapshot !== undefined && this.options.validateArtifactSnapshot !== validate) {
			throw new Error("ChartRuntime artifact validator is already bound");
		}
		this.options.validateArtifactSnapshot = validate;
	}

	bindStampedCommit(prepare: PrepareStampedCommit): void {
		if (this.options.prepareStampedCommit !== undefined && this.options.prepareStampedCommit !== prepare) {
			throw new Error("ChartRuntime commit preparer is already bound");
		}
		this.options.prepareStampedCommit = prepare;
	}

	runEffects(effects: Effect[]): Promise<void> {
		if (this.quiescing) {
			return Promise.resolve();
		}
		let tracked!: Promise<void>;
		tracked = this.performRunEffects(effects).finally(() => this.effectRuns.delete(tracked));
		this.effectRuns.add(tracked);
		return tracked;
	}

	private async performRunEffects(effects: Effect[]): Promise<void> {
		if (this.quiescing) {
			return;
		}
		// The machine drops completions whose invoke facts it has not projected yet, so no
		// event may be delivered between dispatching this batch and enqueueing its
		// durable_records_added acknowledgements. Buffer sends until the batch settles.
		this.sendBuffer = [];
		try {
			for (const effect of effects) {
				if (this.quiescing) {
					return;
				}
				switch (effect.kind) {
					case "durable_records": {
						const records = await this.options.logStore.appendDrafts(effect.records, this.options.prepareStampedCommit);
						if (!this.quiescing) {
							this.queue.send({ kind: "durable_records_added", effectId: effect.id, records });
						}
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
									...(check.ok
										? {}
										: { error: `Actor input does not match exact placement schema: ${check.errors.join("; ")}` }),
								});
							}),
						);
						break;
					case "actor_enqueue":
						this.track(
							Promise.all(
								effect.messages.map((message) =>
									checkSchemaAsync(effect.schema, message.input, this.options.schemaRegistry),
								),
							).then((checks) => {
								const errors = checks.flatMap((check, index) =>
									check.ok ? [] : check.errors.map((error) => `inputs[${index}]: ${error}`),
								);
								this.send({
									kind: "actor_effect",
									effectId: effect.id,
									operation: "enqueue",
									ok: errors.length === 0,
									...(errors.length === 0
										? {}
										: { error: `Atomic actor batch validation failed: ${errors.join("; ")}` }),
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
									...(check.ok
										? {}
										: { error: `Actor reply does not match exact protocol schema: ${check.errors.join("; ")}` }),
								});
							}),
						);
						break;
					case "completion_notify":
						this.track(
							checkSchemaAsync(effect.schema, effect.payload, this.options.schemaRegistry).then((check) => {
								this.send({
									kind: "completion_effect",
									effectId: effect.id,
									operation: "notify",
									ok: check.ok,
									...(check.ok
										? {}
										: { error: `Completion payload does not match exact endpoint schema: ${check.errors.join("; ")}` }),
								});
							}),
						);
						break;
					case "waitFor":
						// Render-only internal action description; never dispatched by the machine.
						break;
					case "agent":
						this.track(
							this.waitForAgentRetry(effect)
								.then(async (ready) => {
									if (!ready || this.quiescing) {
										return;
									}
									const prepared = await this.prepareAction(effect);
									if (this.quiescing) {
										return;
									}
									this.options.agentExecutor.start(prepared, (outcome) => this.dispatchAgentOutcome(effect, outcome));
								})
								.catch((error: unknown) => {
									this.send({
										kind: "agent",
										effectId: effect.id,
										outcome: {
											kind: "failed",
											failure: { kind: "runtime", retryable: false, message: errorMessage(error) },
										},
									});
								}),
						);
						break;
					case "script":
						this.track(
							this.prepareAction(effect)
								.then((prepared) => (this.quiescing ? undefined : this.scripts.run(prepared)))
								.then((event) =>
									event === undefined || this.quiescing ? undefined : this.admitCompletion(event, effect.artifacts),
								)
								.then((admitted) => {
									if (admitted !== undefined) {
										this.send({ kind: "script", effectId: effect.id, ...admitted });
									}
								})
								.catch((error: unknown) => {
									this.send({ kind: "script", effectId: effect.id, event: toFailedEvent(error) });
								}),
						);
						break;
					case "tsImport": {
						const { env: _env, ...prepared } = effect;
						this.track(
							this.functions
								.run(prepared, undefined, async () => {
									Object.assign(prepared, await this.prepareAction(effect));
								})
								.then((event) =>
									event === undefined || this.quiescing ? undefined : this.admitCompletion(event, effect.artifacts),
								)
								.then((admitted) => {
									if (admitted !== undefined) {
										this.send({ kind: "tsImport", effectId: effect.id, ...admitted });
									}
								})
								.catch((error: unknown) => {
									this.send({ kind: "tsImport", effectId: effect.id, event: toFailedEvent(error) });
								}),
						);
						break;
					}
					case "validate": {
						this.track(
							(effect.completionBranchId !== undefined && effect.completionBranchId !== this.branchId
								? Promise.resolve<GuardOutcome>({
										ok: false,
										reason: foreignCompletionReason(effect.completionBranchId, this.branchId),
									})
								: this.prepareReadPaths(effect).then((prepared) =>
										runGuard(
											effect.guard,
											effect.event,
											{
												chartDir: this.options.chartDir,
												workDir: this.options.workDir,
												invocation: {
													branchId: this.branchId,
													actionUid: effect.actionUid,
													invocationId: effect.invocationId,
												},
												...(this.options.hostServices === undefined ? {} : { hostServices: this.options.hostServices }),
											},
											{
												scripts: this.scripts,
												...(prepared.env === undefined ? {} : { env: prepared.env }),
												...(effect.artifacts === undefined ? {} : { artifacts: effect.artifacts }),
												...(effect.reply === undefined ? {} : { reply: effect.reply }),
												actionUid: effect.actionUid,
											} satisfies RenderedGuardInvocation,
										),
									)
							)
								.catch((error: unknown): GuardOutcome => ({ ok: false, reason: errorMessage(error) }))
								.then((outcome) => this.send({ kind: "validated", effectId: effect.id, outcome })),
						);
						break;
					}
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
						for (const delayed of this.delayedAgents.values()) {
							if (
								delayed.actionUid.chart === effect.actionUid.chart &&
								delayed.actionUid.state === effect.actionUid.state &&
								delayed.actionUid.action === effect.actionUid.action
							) {
								delayed.cancel();
							}
						}
						const cancellations = [
							this.options.agentExecutor.cancel(effect.actionUid),
							this.scripts.cancel(effect.actionUid),
							this.functions.cancel(effect.actionUid),
						];
						const cancelled = Promise.allSettled(cancellations).then((results) => {
							for (const result of results) {
								if (result.status === "rejected") {
									this.onWarn(`Cancellation ${effect.id} failed: ${errorMessage(result.reason)}`);
								}
							}
						});
						if (effect.restore === undefined) {
							this.track(cancelled);
							break;
						}
						// Restore only after the executors stopped, and before any later effect can reuse the path.
						await cancelled;
						await this.restore(effect.restore, effect.actionUid);
						break;
					}
					case "borrow":
						await this.borrow(effect);
						break;
					case "restore":
						await this.restore(effect.artifacts, effect.actionUid);
						break;
				}
			}
		} finally {
			const buffered = this.sendBuffer;
			this.sendBuffer = undefined;
			if (buffered !== undefined) {
				for (const event of buffered) {
					this.send(event);
				}
			}
		}
	}

	/** Queue records committed by an external control path; execution was confirmed under the store writer boundary. */
	acknowledgeCommittedRecords(records: readonly DurableLogRecord[], effectId: string): void {
		if (records.length === 0 || this.disposed) {
			return;
		}
		this.send({ kind: "durable_records_added", effectId, records });
	}

	eventsQueue(): AsyncIterable<MachineEvent> {
		return this.queue;
	}

	/** Synchronously reject new effects and late host callbacks without finalizing durable state. */
	beginDrain(): void {
		if (this.quiescing) {
			return;
		}
		this.quiescing = true;
		for (const delayed of this.delayedAgents.values()) {
			delayed.cancel();
		}
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();
	}

	dispose(): Promise<void> {
		if (this.disposal !== undefined) {
			return this.disposal;
		}
		this.beginDrain();
		this.disposed = true;
		this.disposal = this.performDispose();
		return this.disposal;
	}

	private async performDispose(): Promise<void> {
		const cleanups = [
			Promise.resolve().then(() => this.scripts.dispose()),
			Promise.resolve().then(() => this.functions.dispose()),
			Promise.resolve().then(() => this.options.agentExecutor.dispose()),
		];
		const cleanupResults = await Promise.allSettled(cleanups);
		while (this.effectRuns.size > 0) {
			await Promise.allSettled([...this.effectRuns]);
		}
		await this.drainPending();
		// Views still mounted here belong to actions the machine will resume (or never release).
		const rollbackErrors: unknown[] = [];
		for (const { artifact } of [...this.borrowedPaths.values()]) {
			try {
				await this.restore([artifact]);
			} catch (error) {
				rollbackErrors.push(error);
			}
		}
		this.queue.close();
		const errors = [
			...cleanupResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
			...this.backgroundErrors,
			...rollbackErrors,
		];
		if (errors.length > 0) {
			throw new AggregateError(errors, `ChartRuntime disposal failed: ${errors.map(errorMessage).join("; ")}`);
		}
	}

	private track(task: Promise<unknown>): void {
		let tracked!: Promise<void>;
		tracked = task
			.then(
				() => undefined,
				(error: unknown) => {
					this.backgroundErrors.push(error);
					this.onWarn(`Runtime background task failed: ${errorMessage(error)}`);
				},
			)
			.finally(() => {
				this.pending.delete(tracked);
			});
		this.pending.add(tracked);
	}

	private async drainPending(): Promise<void> {
		while (this.pending.size > 0) {
			await Promise.allSettled([...this.pending]);
		}
	}

	private send(event: MachineEvent): void {
		if (this.quiescing) {
			return;
		}
		if (this.sendBuffer !== undefined) {
			this.sendBuffer.push(event);
			return;
		}
		this.queue.send(event);
	}

	private waitForAgentRetry(effect: AgentEffect): Promise<boolean> {
		const delayMs = agentRetryDelayMs(effect);
		if (this.quiescing) {
			return Promise.resolve(false);
		}
		if (delayMs === 0) {
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			const finish = (ready: boolean) => {
				clearTimeout(timer);
				this.delayedAgents.delete(effect.id);
				resolve(ready);
			};
			const timer = setTimeout(() => finish(true), delayMs);
			this.delayedAgents.set(effect.id, { actionUid: effect.actionUid, cancel: () => finish(false) });
		});
	}

	private dispatchAgentOutcome(effect: AgentEffect, outcome: AgentOutcome): void {
		if (this.quiescing) {
			return;
		}
		if (outcome.kind === "failed") {
			const failure = outcome.failure;
			const transient =
				(failure.kind === "provider" || failure.kind === "runtime") && isTransientProviderFailure(failure.message);
			this.send({
				kind: "agent",
				effectId: effect.id,
				outcome: transient ? { kind: "failed", failure: { ...failure, retryable: true } } : outcome,
			});
			return;
		}
		this.track(
			this.admitCompletion(outcome.event, effect.artifacts)
				.then((admitted) =>
					this.send({ kind: "agent", effectId: effect.id, outcome: { kind: "completed", ...admitted } }),
				)
				.catch((error: unknown) => {
					this.send({
						kind: "agent",
						effectId: effect.id,
						outcome: { kind: "failed", failure: { kind: "artifacts", retryable: true, message: errorMessage(error) } },
					});
				}),
		);
	}

	/** Reject paths another action holds as a rollback view, then resolve snapshot inputs. */
	private async prepareAction<
		T extends {
			actionUid: ActionUID;
			artifacts?: readonly RenderedArtifact[];
			reads?: readonly RenderedArtifact[];
			env?: Readonly<Record<string, RenderedEnvValue>>;
		},
	>(effect: T): Promise<T & { env?: RenderedScriptEnv }> {
		const outputs = new Set(
			(effect.artifacts ?? [])
				.filter((artifact) => artifact.rollback === undefined)
				.map((artifact) => renderedArtifactPath(artifact, this.options.workDir)),
		);
		for (const artifact of effect.artifacts ?? []) {
			if (artifact.rollback !== undefined && outputs.has(renderedArtifactPath(artifact, this.options.workDir))) {
				throw new Error(`Temporary artifact '${artifact.path}' cannot also be declared as a completion output`);
			}
		}
		// Snapshot reads resolve to saved objects, not the working path, so they never conflict.
		const reads = (effect.reads ?? envArtifacts(effect.env)).filter((read) => read.snapshot === undefined);
		for (const artifact of [...(effect.artifacts ?? []), ...reads]) {
			this.assertNotBorrowedByAnother(artifact, effect.actionUid);
		}
		return this.prepareReadPaths(effect);
	}

	/** Mount borrowed working files from their selected snapshot (or empty), holding rollback paths. */
	private async borrow(effect: BorrowEffect): Promise<void> {
		const store = this.artifactStore;
		if (store === undefined) {
			throw new Error("Borrowed artifacts require a run artifact store");
		}
		const action = actionUidKey(effect.actionUid);
		for (const artifact of effect.artifacts) {
			const path = renderedArtifactPath(artifact, this.options.workDir);
			const held = this.borrowedPaths.get(path);
			if (held !== undefined && (held.holders.size > 1 || !held.holders.has(action))) {
				// Another action still reads this mount. Only the identical view may join it, and the
				// file is left in place: replacing it would pull it from under the other holders.
				if (!sameRollbackView(held.artifact, artifact)) {
					throw new Error(`Artifact '${artifact.path}' is temporarily borrowed by another action; serialize access`);
				}
				held.holders.add(action);
				continue;
			}
			if (artifact.rollback !== undefined) {
				this.borrowedPaths.set(path, { holders: new Set([action]), artifact });
			}
			if (artifact.snapshot === "empty") {
				await this.replaceWorkingFile(artifact, undefined);
				await fsp.mkdir(dirname(path), { recursive: true });
				await fsp.writeFile(path, "");
			} else if (artifact.snapshot === undefined) {
				throw new Error(`Borrowed artifact '${artifact.path}' has no accepted revision`);
			} else {
				await this.replaceWorkingFile(artifact, artifact.snapshot);
			}
		}
	}

	/**
	 * Return rollback paths to their accepted revision at invoke (`rollback.to`), or remove them.
	 * A path shared with other actions is only released; its last holder restores it. Without an
	 * action (disposal) the path is restored whoever still holds it.
	 */
	private async restore(artifacts: readonly RenderedArtifact[], actionUid?: ActionUID): Promise<void> {
		for (const artifact of artifacts) {
			const path = renderedArtifactPath(artifact, this.options.workDir);
			const held = this.borrowedPaths.get(path);
			if (held !== undefined && actionUid !== undefined) {
				held.holders.delete(actionUidKey(actionUid));
				if (held.holders.size > 0) {
					continue;
				}
			}
			await this.replaceWorkingFile(artifact, artifact.rollback?.to);
			this.borrowedPaths.delete(path);
		}
	}

	/** Unlink first (never write through a link an action left; a directory fails), then materialize. */
	private async replaceWorkingFile(artifact: RenderedArtifact, pin: ArtifactPin | undefined): Promise<void> {
		await fsp.rm(renderedArtifactPath(artifact, this.options.workDir), { force: true });
		if (pin === undefined) {
			return;
		}
		if (this.artifactStore === undefined) {
			throw new Error("Borrowed artifacts require a run artifact store");
		}
		await materializeWorkspaceFromPins({ [artifact.path]: pin }, this.artifactStore, this.options.workDir);
	}

	private assertNotBorrowedByAnother(artifact: RenderedArtifact, actionUid: ActionUID): void {
		const holder = this.borrowedPaths.get(renderedArtifactPath(artifact, this.options.workDir));
		if (holder !== undefined && !holder.holders.has(actionUidKey(actionUid))) {
			throw new Error(`Artifact '${artifact.path}' is temporarily borrowed by another action; serialize access`);
		}
	}

	/** Resolve snapshot reads to verified store objects and workspace reads inside workDir. */
	private async prepareReadPaths<
		T extends {
			reads?: readonly RenderedArtifact[];
			env?: Readonly<Record<string, RenderedEnvValue>>;
			actionUid?: ActionUID;
		},
	>(effect: T): Promise<T & { env?: RenderedScriptEnv }> {
		const reads = effect.reads ?? envArtifacts(effect.env);
		for (const read of reads) {
			if (
				this.artifactStore !== undefined &&
				read.sourceState !== undefined &&
				read.snapshot === undefined &&
				read.sourceState !== effect.actionUid?.state
			) {
				throw new Error(`Artifact of '${read.sourceState}' has no accepted CAS revision`);
			}
		}
		const resolved = new Map<RenderedArtifact, Promise<RenderedArtifact>>();
		const resolveRead = (read: RenderedArtifact): Promise<RenderedArtifact> => {
			const snapshot = read.snapshot;
			if (snapshot === undefined) {
				return Promise.resolve({ ...read, path: renderedArtifactPath(read, this.options.workDir) });
			}
			let pending = resolved.get(read);
			if (pending === undefined) {
				const store = this.artifactStore;
				if (store === undefined) {
					throw new Error("Snapshot reads require a run artifact store");
				}
				const pin = snapshot === "empty" ? undefined : snapshot;
				pending = (pin === undefined ? this.emptySnapshot(store) : store.get(pin.hash)).then(async (path) => {
					if (pin !== undefined && (await fsp.stat(path)).size !== pin.size) {
						throw new Error("Artifact revision has an invalid size");
					}
					return { ...read, path };
				});
				resolved.set(read, pending);
			}
			return pending;
		};
		const preparedReads = await Promise.all(reads.map(resolveRead));
		const env: RenderedScriptEnv | undefined =
			effect.env === undefined
				? undefined
				: Object.fromEntries(
						await Promise.all(
							Object.entries(effect.env).map(async ([name, value]) => {
								if (typeof value === "string") {
									return [name, value];
								}
								if (isJoinedArtifacts(value)) {
									const artifacts = await Promise.all(value.map(resolveRead));
									return [name, JSON.stringify(artifacts.map((artifact) => artifact.path))];
								}
								const artifact = await resolveRead(value);
								return [name, artifact.select === undefined ? artifact.path : artifact];
							}),
						),
					);
		return {
			...effect,
			...(effect.reads === undefined ? {} : { reads: preparedReads }),
			...(env === undefined ? {} : { env }),
		};
	}

	private async emptySnapshot(store: ArtifactStore): Promise<string> {
		const dir = await fsp.mkdtemp(join(this.options.workDir, ".hyperchart-empty-"));
		try {
			const path = join(dir, "empty");
			await fsp.writeFile(path, "");
			const pin = await store.put(path);
			return await store.get(pin.hash);
		} finally {
			await fsp.rm(dir, { recursive: true, force: true });
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
				if (artifact.rollback !== undefined) {
					continue;
				}
				const pin = await store.put(renderedArtifactPath(artifact, this.options.workDir));
				if (artifact.shape !== undefined) {
					const content = await fsp.readFile(store.objectPath(pin.hash), "utf8");
					const validate = this.options.validateArtifactSnapshot;
					if (validate === undefined) {
						throw new Error("Execution did not provide artifact snapshot validation");
					}
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
}

function toFailedEvent(error: unknown): { type: "FAILED"; error: string } {
	return { type: "FAILED", error: errorMessage(error) };
}

function envArtifacts(env: Readonly<Record<string, RenderedEnvValue>> | undefined): RenderedArtifact[] {
	return Object.values(env ?? {}).flatMap((value) => {
		if (typeof value === "string") {
			return [];
		}
		return isJoinedArtifacts(value) ? value : [value];
	});
}

function foreignCompletionReason(sourceBranchId: string, branchId: string): string {
	return `Completion artifacts from branch '${sourceBranchId}' are provisional and were not inherited by '${branchId}'. Produce a fresh branch-local completion and its declared artifacts before validation; do not reuse the inherited result with older accepted files. The declared recovery policy and durable budget still apply.`;
}

function samePin(left: ArtifactPin | "empty" | undefined, right: ArtifactPin | "empty" | undefined): boolean {
	if (left === undefined || right === undefined || left === "empty" || right === "empty") {
		return left === right;
	}
	return left.hash === right.hash && left.size === right.size;
}

/** Two rollback bindings of one path that mount the same bytes and return to the same revision. */
function sameRollbackView(left: RenderedArtifact, right: RenderedArtifact): boolean {
	return (
		left.rollback !== undefined &&
		right.rollback !== undefined &&
		samePin(left.snapshot, right.snapshot) &&
		samePin(left.rollback.to, right.rollback.to)
	);
}
