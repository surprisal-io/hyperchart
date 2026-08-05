import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { actionUidKey } from "../../core/action_uid.js";
import type { ActionUID, ChartEvent, GuardOutcome, GuardRefAst, SchemaAst } from "../../core/types.js";
import type { RenderedArtifact, ScriptEffect } from "../../core/machine.js";
import { checkArtifactFile, resolveArtifactValue, serializeEnvValue } from "./artifacts.js";
import { checkSchemaAsync } from "./schema.js";
import type { SchemaRegistryLike } from "../../core/schema_registry.js";

export type RenderedScriptEnv = Readonly<Record<string, string | RenderedArtifact>>;

type ProcessResult = Readonly<{
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}>;

type LiveScript = {
	child?: ChildProcessWithoutNullStreams;
	killTimer?: NodeJS.Timeout;
	cancelled: boolean;
	settled: Promise<void>;
	settle: () => void;
};

export class ScriptRunner {
	private readonly live = new Map<string, LiveScript>();

	constructor(private readonly opts: { workDir: string; schemaRegistry?: SchemaRegistryLike; killGraceMs?: number }) {}

	async run(effect: ScriptEffect, validationAttempt?: { n: number; reason?: string }): Promise<ChartEvent> {
		const key = actionUidKey(effect.actionUid);
		const live = this.begin(key);
		try {
			const env = await this.resolveEnv(effect.env, validationAttempt);
			if (live.cancelled) return { type: "FAILED", error: "script cancelled before process start" };
			const result = await this.runProcess(effect.command, effect.args, env, undefined, live);
			if (result.code !== 0) {
				return { type: "FAILED", error: { code: result.code, signal: result.signal, stderr: tail(result.stderr, 2000) } };
			}
			return this.validateEvent(effect, eventFromStdout(result.stdout, effect.events));
		} finally {
			this.finish(key, live);
		}
	}

	async runGuard(
		guard: Extract<GuardRefAst, { kind: "script" }>,
		event: ChartEvent,
		renderedEnv?: RenderedScriptEnv,
		artifacts?: readonly RenderedArtifact[],
		reply?: SchemaAst,
		actionUid?: ActionUID,
	): Promise<GuardOutcome> {
		const hasRawOptions = guard.env !== undefined || ("artifacts" in guard && guard.artifacts !== undefined) || ("reply" in guard && guard.reply !== undefined);
		if (hasRawOptions && renderedEnv === undefined && artifacts === undefined && reply === undefined) {
			throw new Error("Script guard env/artifacts/reply require rendered guard invocation options.");
		}
		const key = actionUid === undefined ? undefined : actionUidKey(actionUid);
		const live = this.begin(key);
		try {
			const env = await this.resolveEnv(renderedEnv, undefined);
			if (live.cancelled) return { ok: false, reason: "script guard cancelled before process start" };
			const result = await this.runProcess(
				guard.command,
				guard.args ?? [],
				env,
				JSON.stringify(event),
				live,
			);
			if (result.code !== 0) {
				return { ok: false, reason: result.stderr.trim() || `exit ${result.code ?? result.signal ?? "unknown"}` };
			}

			if (reply !== undefined) {
				const replyEvent = eventFromStdout(result.stdout, ["DONE"]);
				const error = await this.replyValidationError(reply, replyEvent);
				if (error !== undefined) return { ok: false, reason: `script guard ${error}` };
			}
			const artifactErrors = await this.validateArtifacts(artifacts);
			if (artifactErrors.length > 0) {
				return { ok: false, reason: `script guard deliverables are invalid: ${artifactErrors.join("; ")}` };
			}
			return true;
		} finally {
			this.finish(key, live);
		}
	}

	cancel(actionUid: ActionUID): Promise<void> {
		const live = this.live.get(actionUidKey(actionUid));
		if (live === undefined) return Promise.resolve();
		live.cancelled = true;
		this.terminate(live);
		return live.settled;
	}

	async dispose(): Promise<void> {
		const lives = [...this.live.values()];
		for (const live of lives) {
			live.cancelled = true;
			this.terminate(live);
		}
		await Promise.all(lives.map((live) => live.settled));
	}

	private begin(key: string | undefined): LiveScript {
		let settle!: () => void;
		const live: LiveScript = {
			cancelled: false,
			settled: new Promise<void>((resolve) => { settle = resolve; }),
			settle: () => settle(),
		};
		if (key !== undefined) {
			if (this.live.has(key)) throw new Error(`Script phase ${key} is already running`);
			this.live.set(key, live);
		}
		return live;
	}

	private finish(key: string | undefined, live: LiveScript): void {
		if (live.killTimer !== undefined) clearTimeout(live.killTimer);
		if (key !== undefined && this.live.get(key) === live) this.live.delete(key);
		live.settle();
	}

	private terminate(live: LiveScript): void {
		const child = live.child;
		if (child === undefined || !this.isRunning(child)) return;
		try {
			child.kill("SIGTERM");
		} catch {
			// The process may have closed between isRunning() and kill().
		}
		if (live.killTimer === undefined) {
			live.killTimer = setTimeout(() => {
				if (this.isRunning(child)) {
					try {
						child.kill("SIGKILL");
					} catch {
						// The process closed during escalation.
					}
				}
			}, this.opts.killGraceMs ?? 5000);
			live.killTimer.unref();
		}
	}

	private isRunning(child: ChildProcessWithoutNullStreams): boolean {
		return child.exitCode === null && child.signalCode === null;
	}

	private async runProcess(
		command: string,
		args: readonly string[],
		env: Record<string, string>,
		stdin: string | undefined,
		live: LiveScript,
	): Promise<ProcessResult> {
		const child = spawn(command, [...args], { cwd: this.opts.workDir, env });
		live.child = child;
		let stdout = "";
		let stderr = "";
		let stdinError: Error | undefined;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.stdin.on("error", (error: NodeJS.ErrnoException) => {
			// A guard is allowed to ignore stdin. Large completion envelopes can still be in flight
			// when such a guard exits, causing the parent-side pipe to report EPIPE. The child exit
			// status remains authoritative; without this listener Node terminates the runner.
			if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") stdinError = error;
		});
		if (stdin !== undefined) child.stdin.end(stdin);
		try {
			const exit = await waitForExit(child);
			if (stdinError !== undefined && exit.code === 0) {
				return { code: 1, signal: exit.signal, stdout, stderr: `${stderr}${stdinError.message}` };
			}
			return { ...exit, stdout, stderr };
		} finally {
			if (live.killTimer !== undefined) {
				clearTimeout(live.killTimer);
				delete live.killTimer;
			}
			if (live.child === child) delete live.child;
		}
	}

	private async resolveEnv(renderedEnv: RenderedScriptEnv | undefined, validationAttempt: { n: number; reason?: string } | undefined) {
		const env: Record<string, string> = { ...process.env } as Record<string, string>;
		for (const [name, value] of Object.entries(renderedEnv ?? {})) {
			env[name] = typeof value === "string" ? value : serializeEnvValue(await resolveArtifactValue(value, this.opts.workDir, this.opts.schemaRegistry));
		}
		if (validationAttempt !== undefined) {
			env.HYPERCHART_VALIDATION_ATTEMPT = String(validationAttempt.n);
			if (validationAttempt.reason !== undefined) env.HYPERCHART_REJECT_REASON = validationAttempt.reason;
		}
		return env;
	}

	private async validateEvent(effect: ScriptEffect, event: ChartEvent): Promise<ChartEvent> {
		if (!effect.events.includes(event.type)) {
			return { type: "FAILED", error: `script emitted unsupported event '${event.type}'; allowed: ${effect.events.join(", ")}` };
		}
		if (event.type === "FAILED") {
			if (!("error" in event)) return { type: "FAILED", error: "script emitted FAILED without an error" };
		} else if (effect.reply !== undefined) {
			const error = await this.replyValidationError(effect.reply, event);
			if (error !== undefined) return { type: "FAILED", error: `script ${error}` };
		}
		const artifactErrors = await this.validateArtifacts(effect.artifacts);
		if (artifactErrors.length > 0) return { type: "FAILED", error: `script deliverables are invalid: ${artifactErrors.join("; ")}` };
		return event;
	}

	private async replyValidationError(reply: SchemaAst, event: ChartEvent): Promise<string | undefined> {
		const check = await checkSchemaAsync(reply, "output" in event ? event.output : undefined, this.opts.schemaRegistry);
		return check.ok ? undefined : `output does not match reply schema: ${check.errors.join("; ")}`;
	}

	private async validateArtifacts(artifacts: readonly RenderedArtifact[] | undefined): Promise<string[]> {
		const errors: string[] = [];
		for (const artifact of artifacts ?? []) {
			const check = await checkArtifactFile(artifact, this.opts.workDir, this.opts.schemaRegistry);
			if (!check.ok) errors.push(...check.errors);
		}
		return errors;
	}
}

function eventFromStdout(stdout: string, events: readonly string[]): ChartEvent {
	const lastLine = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0).at(-1);
	if (lastLine !== undefined) {
		try {
			const parsed = JSON.parse(lastLine) as unknown;
			if (typeof parsed === "object" && parsed !== null && typeof (parsed as { type?: unknown }).type === "string") {
				const obj = parsed as { type: string; output?: unknown; error?: unknown };
				return obj.type === "FAILED"
					? { type: "FAILED", error: obj.error ?? obj.output ?? "script reported FAILED" }
					: { type: obj.type, ...(obj.output === undefined ? {} : { output: obj.output }) };
			}
		} catch {
			// Not a JSON completion line; fall through to the implicit exit-0 rule.
		}
	}
	const nonFailedEvents = events.filter((event) => event !== "FAILED");
	if (nonFailedEvents.length === 1) return { type: nonFailedEvents[0] as string };
	return { type: "FAILED", error: `ambiguous completion: print JSON {"type": ...} as the last stdout line; allowed: ${events.join(", ")}` };
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
}

function tail(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}
