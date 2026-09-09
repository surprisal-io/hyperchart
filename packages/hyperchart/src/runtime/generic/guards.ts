import type { ActionUID, ChartEvent, GuardOutcome, GuardRefAst, SchemaAst } from "../../core/types.js";
import type { RenderedArtifact } from "../../core/machine.js";
import { ScriptRunner, type RenderedScriptEnv } from "./script_runner.js";
import { importedModuleSpecifier } from "./imported_module.js";

export type GuardContext = Readonly<{
	chartDir: string;
	workDir: string;
	/** Runtime-supplied original action identity, stable across validation rounds. */
	invocation?: Readonly<{ branchId: string; actionUid: ActionUID; invocationId: string }>;
}>;

/** Runtime-rendered script options. Raw dynamic guard options are never silently discarded. */
export type RenderedGuardInvocation = Readonly<{
	scripts?: ScriptRunner;
	env?: RenderedScriptEnv;
	artifacts?: readonly RenderedArtifact[];
	reply?: SchemaAst;
	actionUid?: ActionUID;
}>;

/** Run a validator. Script guards delegate process, stdin, stderr, and env handling to ScriptRunner. */
export async function runGuard(
	guard: GuardRefAst,
	event: ChartEvent,
	ctx: GuardContext,
	invocation?: RenderedGuardInvocation,
): Promise<GuardOutcome> {
	if (guard.kind === "tsImport") {
		const moduleUrl = importedModuleSpecifier(guard.module, ctx.chartDir);
		const mod = (await import(moduleUrl)) as Record<string, unknown>;
		const fn = mod[guard.export];
		if (typeof fn !== "function") {
			throw new Error(`Guard export '${guard.export}' is not a function in ${guard.module}`);
		}
		// Context carries workspace paths and optional runtime-supplied invocation provenance.
		return normalizeGuardOutcome(await fn(event, ctx));
	}

	const hasRawOptions = guard.env !== undefined || ("artifacts" in guard && guard.artifacts !== undefined) || ("reply" in guard && guard.reply !== undefined);
	if (invocation === undefined && hasRawOptions) {
		throw new Error("Script guard env/artifacts/reply require a rendered guard invocation from ChartRuntime; call runGuard with RenderedGuardInvocation options.");
	}
	const runner = invocation?.scripts ?? new ScriptRunner({ workDir: ctx.workDir });
	return runner.runGuard(guard, event, invocation?.env, invocation?.artifacts, invocation?.reply, invocation?.actionUid, ctx.invocation);
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
