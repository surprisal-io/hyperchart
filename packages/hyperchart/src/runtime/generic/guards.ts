import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChartEvent, GuardOutcome, GuardRef } from "../../core/types.js";

export type GuardContext = { chartDir: string; workDir: string };

export async function runGuard(guard: GuardRef, event: ChartEvent, ctx: GuardContext): Promise<GuardOutcome> {
	if (guard.kind === "tsImport") {
		const moduleUrl =
			guard.module.startsWith("./") || guard.module.startsWith("../")
				? pathToFileURL(resolve(ctx.chartDir, guard.module)).href
				: guard.module;
		const mod = (await import(moduleUrl)) as Record<string, unknown>;
		const fn = mod[guard.export];
		if (typeof fn !== "function") {
			throw new Error(`Guard export '${guard.export}' is not a function in ${guard.module}`);
		}
		return normalizeGuardOutcome(await fn(event));
	}

	return runScriptGuard(guard.command, guard.args ?? [], event, ctx.workDir);
}

async function runScriptGuard(
	command: string,
	args: readonly string[],
	event: ChartEvent,
	workDir: string,
): Promise<GuardOutcome> {
	const child = spawn(command, [...args], { cwd: workDir });
	child.stdout.resume();
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.stdin.end(JSON.stringify(event));
	const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	if (exit.code === 0) {
		return true;
	}
	return { ok: false, reason: stderr.trim() || `exit ${exit.code ?? exit.signal ?? "unknown"}` };
}

function normalizeGuardOutcome(value: unknown): GuardOutcome {
	if (typeof value === "boolean") {
		return value;
	}
	if (
		typeof value === "object" &&
		value !== null &&
		(value as { ok?: unknown }).ok === false &&
		typeof (value as { reason?: unknown }).reason === "string"
	) {
		return value as GuardOutcome;
	}
	throw new Error("Guard must return boolean or {ok:false, reason:string}");
}
