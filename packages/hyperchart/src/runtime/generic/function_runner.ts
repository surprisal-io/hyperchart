import { resolve } from "node:path";
import { actionUidKey } from "../../core/action_uid.js";
import type { ImportedActionEffect, RenderedArtifact } from "../../core/machine.js";
import type { ActionUID, ChartEvent, JsonValue } from "../../core/types.js";
import type { SchemaRegistryLike } from "../../core/schema_registry.js";
import { renderedArtifactPath, resolveArtifactValue } from "./artifacts.js";
import { validateActionCompletion } from "./completion_validation.js";
import { importedModuleSpecifier } from "./imported_module.js";

export type ValidationAttempt = Readonly<{ n: number; reason?: string }>;

export type ImportedActionContext = Readonly<{
	input?: Readonly<Record<string, JsonValue>>;
	events: readonly string[];
	actionUid: ActionUID;
	chartDir: string;
	workDir: string;
	projectDir: string;
	/** Absolute paths keyed by the action's declared artifact names. */
	artifacts: Readonly<Record<string, string>>;
	signal: AbortSignal;
	validationAttempt?: ValidationAttempt;
}>;

export type ImportedActionFunction = (
	params: Readonly<Record<string, unknown>>,
	context: ImportedActionContext,
) => ChartEvent | Promise<ChartEvent>;

type LiveFunction = {
	controller: AbortController;
	cancelled: boolean;
	aborted: Promise<typeof ABORTED>;
	abortWait: () => void;
	settled: Promise<void>;
	settle: () => void;
};

const ABORTED = Symbol("imported action aborted");

/** Executes trusted imported action functions in this runner process. */
export class FunctionRunner {
	private readonly live = new Map<string, LiveFunction>();
	private readonly opts: {
		chartDir: string;
		workDir: string;
		projectDir: string;
		schemaRegistry?: SchemaRegistryLike;
	};

	constructor(opts: {
		chartDir: string;
		workDir: string;
		projectDir?: string;
		schemaRegistry?: SchemaRegistryLike;
	}) {
		this.opts = {
			chartDir: resolve(opts.chartDir),
			workDir: resolve(opts.workDir),
			projectDir: resolve(opts.projectDir ?? opts.workDir),
			...(opts.schemaRegistry === undefined ? {} : { schemaRegistry: opts.schemaRegistry }),
		};
	}

	async run(
		effect: ImportedActionEffect,
		validationAttempt?: ValidationAttempt,
		prepare?: () => Promise<void>,
	): Promise<ChartEvent | undefined> {
		const key = actionUidKey(effect.actionUid);
		const live = this.begin(key);
		const operation = this.invoke(effect, live.controller.signal, validationAttempt, prepare);
		// Promise.race installs a rejection handler on the user operation. Keep this explicit to make
		// late failures harmless even after cancellation wins and the tracked invocation settles.
		void operation.catch(() => undefined);
		try {
			const result = await Promise.race([operation, live.aborted]);
			if (result === ABORTED || live.cancelled) return undefined;
			return validateActionCompletion(effect, result, {
				workDir: this.opts.workDir,
				...(this.opts.schemaRegistry === undefined ? {} : { schemaRegistry: this.opts.schemaRegistry }),
				label: "imported action",
			});
		} finally {
			this.finish(key, live);
		}
	}

	cancel(actionUid: ActionUID): Promise<void> {
		const live = this.live.get(actionUidKey(actionUid));
		if (live === undefined) return Promise.resolve();
		this.abort(live);
		return live.settled;
	}

	/** Abort cooperatively and return without awaiting user code, which may never settle. */
	dispose(): Promise<void> {
		for (const live of this.live.values()) this.abort(live);
		return Promise.resolve();
	}

	private async invoke(
		effect: ImportedActionEffect,
		signal: AbortSignal,
		validationAttempt: ValidationAttempt | undefined,
		prepare: (() => Promise<void>) | undefined,
	): Promise<ChartEvent> {
		await prepare?.();
		if (signal.aborted) throw signal.reason ?? new Error("imported action cancelled");
		const params = await this.resolveParams(effect.env);
		if (signal.aborted) throw signal.reason ?? new Error("imported action cancelled");
		const moduleSpecifier = importedModuleSpecifier(effect.module, this.opts.chartDir);
		const mod = (await import(moduleSpecifier)) as Record<string, unknown>;
		if (signal.aborted) throw signal.reason ?? new Error("imported action cancelled");
		const fn = mod[effect.export];
		if (typeof fn !== "function") {
			throw new Error(`Imported action export '${effect.export}' is not a function in ${effect.module}`);
		}
		const artifacts = Object.fromEntries(
			(effect.artifacts ?? []).map((artifact) => [
				artifact.name ?? artifact.path,
				renderedArtifactPath(artifact, this.opts.workDir),
			]),
		);
		const context: ImportedActionContext = {
			...(effect.input === undefined ? {} : { input: structuredClone(effect.input) }),
			events: [...effect.events],
			actionUid: { ...effect.actionUid },
			chartDir: this.opts.chartDir,
			workDir: this.opts.workDir,
			projectDir: this.opts.projectDir,
			artifacts,
			signal,
			...(validationAttempt === undefined ? {} : { validationAttempt: { ...validationAttempt } }),
		};
		const value = await (fn as ImportedActionFunction)(params, context);
		return explicitChartEvent(value);
	}

	private async resolveParams(
		env: Readonly<Record<string, string | RenderedArtifact>> | undefined,
	): Promise<Readonly<Record<string, unknown>>> {
		return Object.fromEntries(
			await Promise.all(
				Object.entries(env ?? {}).map(
					async ([name, value]) =>
						[
							name,
							typeof value === "string"
								? value
								: await resolveArtifactValue(value, this.opts.workDir, this.opts.schemaRegistry),
						] as const,
				),
			),
		);
	}

	private begin(key: string): LiveFunction {
		if (this.live.has(key)) throw new Error(`Imported action phase ${key} is already running`);
		let abortWait!: () => void;
		let settle!: () => void;
		const live: LiveFunction = {
			controller: new AbortController(),
			cancelled: false,
			aborted: new Promise<typeof ABORTED>((resolve) => {
				abortWait = () => resolve(ABORTED);
			}),
			abortWait: () => abortWait(),
			settled: new Promise<void>((resolve) => {
				settle = resolve;
			}),
			settle: () => settle(),
		};
		this.live.set(key, live);
		return live;
	}

	private abort(live: LiveFunction): void {
		if (!live.cancelled) {
			live.cancelled = true;
			live.controller.abort(new Error("imported action cancelled"));
			live.abortWait();
		}
		// Cancellation means the tracked phase can no longer emit, even if user code keeps running.
		live.settle();
	}

	private finish(key: string, live: LiveFunction): void {
		if (this.live.get(key) === live) this.live.delete(key);
		live.settle();
	}
}

function explicitChartEvent(value: unknown): ChartEvent {
	if (typeof value !== "object" || value === null || typeof (value as { type?: unknown }).type !== "string") {
		throw new Error("Imported action must return an explicit ChartEvent object with a string type");
	}
	const event = value as { type: string; output?: unknown; error?: unknown };
	return event.type === "FAILED"
		? { type: "FAILED", ...(event.error === undefined ? {} : { error: event.error }) }
		: { type: event.type, ...(event.output === undefined ? {} : { output: event.output }) };
}
