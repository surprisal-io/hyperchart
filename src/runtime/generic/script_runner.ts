import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { actionUidKey } from "../../core/action_uid.js";
import type { ActionUID, ChartEvent } from "../../core/types.js";
import type { ScriptEffect } from "../../core/machine.js";
import { checkArtifactFile, resolveArtifactValue, serializeEnvValue } from "./artifacts.js";
import { checkSchema } from "./schema.js";

export class ScriptRunner {
	private readonly live = new Map<string, { child: ChildProcessWithoutNullStreams; killTimer?: NodeJS.Timeout }>();

	constructor(private readonly opts: { workDir: string }) {}

	async run(effect: ScriptEffect, attempt?: { n: number; reason?: string }): Promise<ChartEvent> {
		const key = actionUidKey(effect.actionUid);
		const env = await this.resolveEnv(effect, attempt);
		const child = spawn(effect.command, [...effect.args], {
			cwd: this.opts.workDir,
			env,
		});
		this.live.set(key, { child });

		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		try {
			const exit = await waitForExit(child);
			if (exit.code !== 0) {
				return { type: "FAILED", error: { code: exit.code, signal: exit.signal, stderr: tail(stderr, 2000) } };
			}
			return await this.validateEvent(effect, eventFromStdout(stdout, effect.events));
		} finally {
			const live = this.live.get(key);
			if (live?.child === child) {
				if (live.killTimer !== undefined) clearTimeout(live.killTimer);
				this.live.delete(key);
			}
		}
	}

	cancel(actionUid: ActionUID): void {
		const key = actionUidKey(actionUid);
		const live = this.live.get(key);
		if (live === undefined) return;
		live.child.kill("SIGTERM");
		live.killTimer = setTimeout(() => {
			if (!live.child.killed) {
				live.child.kill("SIGKILL");
			}
		}, 5000);
		live.killTimer.unref();
	}

	async dispose(): Promise<void> {
		for (const [key, live] of this.live) {
			live.child.kill("SIGTERM");
			if (live.killTimer !== undefined) clearTimeout(live.killTimer);
			this.live.delete(key);
		}
	}

	private async resolveEnv(effect: ScriptEffect, attempt: { n: number; reason?: string } | undefined) {
		const env: Record<string, string> = { ...process.env } as Record<string, string>;
		for (const [name, value] of Object.entries(effect.env ?? {})) {
			env[name] =
				typeof value === "string" ? value : serializeEnvValue(await resolveArtifactValue(value, this.opts.workDir));
		}
		if (attempt !== undefined) {
			env.HYPERCHART_ATTEMPT = String(attempt.n);
			if (attempt.reason !== undefined) {
				env.HYPERCHART_REJECT_REASON = attempt.reason;
			}
		}
		return env;
	}

	private async validateEvent(effect: ScriptEffect, event: ChartEvent): Promise<ChartEvent> {
		if (!effect.events.includes(event.type)) {
			return {
				type: "FAILED",
				error: `script emitted unsupported event '${event.type}'; allowed: ${effect.events.join(", ")}`,
			};
		}
		if (event.type === "FAILED") {
			if (!("error" in event)) {
				return { type: "FAILED", error: "script emitted FAILED without an error" };
			}
		} else if (effect.reply !== undefined) {
			const check = checkSchemaForEvent(effect, event);
			if (check !== undefined) return check;
		}

		const artifactErrors: string[] = [];
		for (const artifact of effect.artifacts ?? []) {
			const check = await checkArtifactFile(artifact, this.opts.workDir);
			if (!check.ok) artifactErrors.push(...check.errors);
		}
		if (artifactErrors.length > 0) {
			return { type: "FAILED", error: `script deliverables are invalid: ${artifactErrors.join("; ")}` };
		}
		return event;
	}
}

function checkSchemaForEvent(effect: ScriptEffect, event: ChartEvent): ChartEvent | undefined {
	if (effect.reply === undefined) return undefined;
	const check = checkSchema(effect.reply, "output" in event ? event.output : undefined);
	return check.ok
		? undefined
		: { type: "FAILED", error: `script output does not match reply schema: ${check.errors.join("; ")}` };
}

function eventFromStdout(stdout: string, events: readonly string[]): ChartEvent {
	const lastLine = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.at(-1);
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
	if (nonFailedEvents.length === 1) {
		return { type: nonFailedEvents[0] as string };
	}
	return {
		type: "FAILED",
		error: `ambiguous completion: print JSON {"type": ...} as the last stdout line; allowed: ${events.join(", ")}`,
	};
}

function waitForExit(
	child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
}

function tail(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}
