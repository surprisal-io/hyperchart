import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { MachineState } from "../../core/machine.js";
import { renderJoin, renderRead, renderTemplate } from "../../core/machine.js";
import { nodeAt } from "../../core/paths.js";
import type { RunTerminalState } from "./run_outcome.js";
import { isRunLive, patchRunStatus, readRunStatus } from "./run_status.js";

export const TERMINAL_NOTIFICATION_DIR = "terminal-notification";
export const TERMINAL_NOTIFICATION_REQUEST = "request.json";

export type TerminalNotificationPayload = Readonly<{
	runId: string;
	runDir: string;
	chartId: string;
	outcome: RunTerminalState;
	prompt: string;
	artifacts: readonly string[];
	/** Present for failed outcomes so stale recovery can preserve the real runner error. */
	error?: string;
}>;

export type TerminalNotificationRequest = Readonly<{
	version: 1;
	requestId: string;
	createdAt: string;
	payload: TerminalNotificationPayload;
}>;

export type TerminalNotificationReceipt = Readonly<{
	version: 1;
	requestId: string;
	host: string;
	sessionId: string;
	state: "claimed" | "confirmed";
	claimedAt?: string;
	deliveredAt?: string;
}>;

export const TERMINAL_NOTIFICATION_CLAIM_LEASE_MS = 30_000;

export function terminalNotificationRequestPath(runDir: string): string {
	return join(runDir, TERMINAL_NOTIFICATION_DIR, TERMINAL_NOTIFICATION_REQUEST);
}

export function renderTerminalNotificationPayload(
	state: MachineState,
	input: { runId: string; runDir: string; workDir: string; outcome: RunTerminalState; error?: string },
): TerminalNotificationPayload {
	const standard = input.outcome === "failed"
		? `Hyperchart run ${input.runId} (${state.ast.id}) failed${input.error === undefined ? "" : `: ${input.error}`}. Inspect the durable run at ${input.runDir}.`
		: `Hyperchart run ${input.runId} (${state.ast.id}) completed successfully. Inspect the durable run at ${input.runDir}.`;
	const custom: string[] = [];
	const artifactPaths: string[] = [];
	for (const leaf of state.projection.activeLeaves) {
		const terminal = nodeAt(state.ast, leaf);
		if (terminal?.kind !== "final" || terminal.notify === undefined) continue;
		const scope = terminal.notify.scope ?? leaf;
		if (terminal.notify.prompt !== undefined) custom.push(renderTemplate(state, terminal.notify.prompt, scope));
		for (const read of terminal.notify.artifacts ?? []) {
			const rendered = read.kind === "joinArtifactOf"
				? renderJoin(state, read, scope)
				: [renderRead(state, read, scope)];
			for (const artifact of rendered) artifactPaths.push(authoritativeArtifactPath(input.workDir, artifact.path));
		}
	}
	const artifacts = [...new Set(artifactPaths)];
	const sections = [standard, ...custom];
	if (artifacts.length > 0) sections.push(`Declared artifacts (authoritative paths; contents not inlined):\n${artifacts.map((path) => `- ${path}`).join("\n")}`);
	return {
		runId: input.runId,
		runDir: resolve(input.runDir),
		chartId: state.ast.id,
		outcome: input.outcome,
		prompt: sections.join("\n\n"),
		artifacts,
		...(input.error === undefined ? {} : { error: input.error }),
	};
}

export function defaultFailedTerminalNotificationPayload(input: {
	runId: string;
	runDir: string;
	chartId: string;
	error: string;
}): TerminalNotificationPayload {
	const runDir = resolve(input.runDir);
	return {
		runId: input.runId,
		runDir,
		chartId: input.chartId,
		outcome: "failed",
		prompt: `Hyperchart run ${input.runId} (${input.chartId}) failed: ${input.error}. Inspect the durable run at ${runDir}.`,
		artifacts: [],
		error: input.error,
	};
}

/** A request becomes deliverable only after status.json records the same terminal outcome. */
export function readDeliverableTerminalNotificationRequest(runDir: string): TerminalNotificationRequest | undefined {
	const request = readTerminalNotificationRequest(runDir);
	if (request === undefined) return undefined;
	const status = readRunStatus(runDir);
	return status?.state === request.payload.outcome ? request : undefined;
}

/**
 * Repair a runner that died before publishing terminal status. If the outbox was
 * already written, its outcome wins; otherwise persist a failed request first.
 */
export function recoverStaleRunTerminalNotification(
	runDir: string,
	now = Date.now(),
): TerminalNotificationRequest | undefined {
	const status = readRunStatus(runDir);
	if (status === undefined || (status.state !== "starting" && status.state !== "running") || isRunLive(status, now)) {
		return undefined;
	}
	let request = readTerminalNotificationRequest(runDir);
	if (request === undefined) {
		const error = status.error ?? "runner exited before recording a terminal status";
		request = persistTerminalNotificationRequest(
			runDir,
			defaultFailedTerminalNotificationPayload({
				runId: status.runId,
				runDir,
				chartId: status.chartId,
				error,
			}),
		);
	}
	patchRunStatus(runDir, {
		state: request.payload.outcome,
		pid: undefined,
		heartbeatAt: undefined,
		exitCode: request.payload.outcome === "complete" ? 0 : 1,
		error: request.payload.outcome === "failed"
			? request.payload.error ?? status.error ?? "runner exited before recording a terminal status"
			: undefined,
	});
	return request;
}

/** Persist-once outbox write. Existing identical payloads are reused; divergent terminal replay fails loud. */
export function persistTerminalNotificationRequest(runDir: string, payload: TerminalNotificationPayload): TerminalNotificationRequest {
	const path = terminalNotificationRequestPath(runDir);
	const existing = readTerminalNotificationRequest(runDir);
	if (existing !== undefined) {
		if (stableJson(existing.payload) !== stableJson(payload)) {
			throw new Error(`Terminal notification payload conflict for run '${payload.runId}'`);
		}
		return existing;
	}
	mkdirSync(join(runDir, TERMINAL_NOTIFICATION_DIR), { recursive: true });
	const request: TerminalNotificationRequest = {
		version: 1,
		// Identity belongs to this outbox generation, not its payload. Rewind removes the
		// outbox, so replaying an identical terminal creates a notification that hosts can
		// distinguish from the pre-rewind delivery.
		requestId: randomUUID(),
		createdAt: new Date().toISOString(),
		payload,
	};
	atomicWriteJson(path, request);
	return request;
}

export function readTerminalNotificationRequest(runDir: string): TerminalNotificationRequest | undefined {
	const path = terminalNotificationRequestPath(runDir);
	if (!existsSync(path)) return undefined;
	const value = JSON.parse(readFileSync(path, "utf8")) as TerminalNotificationRequest;
	if (value.version !== 1 || typeof value.requestId !== "string" || typeof value.payload?.prompt !== "string") {
		throw new Error(`Invalid terminal notification request: ${path}`);
	}
	return value;
}

export function terminalNotificationReceiptPath(runDir: string, host: string, sessionId: string): string {
	const key = createHash("sha256").update(`${host}\0${sessionId}`).digest("hex");
	return join(runDir, TERMINAL_NOTIFICATION_DIR, "receipts", `${key}.json`);
}

export function hasTerminalNotificationReceipt(runDir: string, host: string, sessionId: string): boolean {
	const request = readTerminalNotificationRequest(runDir);
	if (request === undefined) return false;
	const receipt = readReceipt(terminalNotificationReceiptPath(runDir, host, sessionId));
	return receipt !== undefined &&
		receipt.requestId === request.requestId &&
		receipt.host === host &&
		receipt.sessionId === sessionId &&
		// Receipts written by the original implementation had no state. Treat them as
		// confirmed so upgrading does not duplicate notifications already delivered.
		(receipt.state === "confirmed" || (receipt.state === undefined && typeof receipt.deliveredAt === "string"));
}

/**
 * Atomically acquire a recoverable delivery lease. A claim is not a receipt: only
 * markTerminalNotificationReceipt confirms delivery. If a process dies before
 * delivery, another process may reclaim after the lease expires.
 */
export function claimTerminalNotificationReceipt(
	runDir: string,
	host: string,
	sessionId: string,
	options: { now?: number; leaseMs?: number } = {},
): boolean {
	const request = readTerminalNotificationRequest(runDir);
	if (request === undefined) throw new Error(`No terminal notification request exists for ${runDir}`);
	const path = terminalNotificationReceiptPath(runDir, host, sessionId);
	const now = options.now ?? Date.now();
	const leaseMs = options.leaseMs ?? TERMINAL_NOTIFICATION_CLAIM_LEASE_MS;
	const claim: TerminalNotificationReceipt = {
		version: 1,
		requestId: request.requestId,
		host,
		sessionId,
		state: "claimed",
		claimedAt: new Date(now).toISOString(),
	};
	mkdirSync(join(runDir, TERMINAL_NOTIFICATION_DIR, "receipts"), { recursive: true });
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			writeFileSync(path, `${JSON.stringify(claim, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
			return true;
		} catch (error) {
			if (!isNodeError(error) || error.code !== "EEXIST") throw error;
		}
		const existing = readReceipt(path);
		if (existing !== undefined && existing.requestId === request.requestId && existing.host === host && existing.sessionId === sessionId) {
			if (existing.state === "confirmed" || (existing.state === undefined && typeof existing.deliveredAt === "string")) return false;
			const claimedAt = existing.claimedAt === undefined ? Number.NaN : Date.parse(existing.claimedAt);
			if (Number.isFinite(claimedAt) && now - claimedAt < leaseMs) return false;
		}
		const displaced = `${path}.${process.pid}.${randomUUID()}.stale`;
		try {
			renameSync(path, displaced);
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") continue;
			throw error;
		}
		try {
			writeFileSync(path, `${JSON.stringify(claim, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
			return true;
		} catch (error) {
			if (!isNodeError(error) || error.code !== "EEXIST") throw error;
			return false;
		} finally {
			rmSync(displaced, { force: true });
		}
	}
	return false;
}

/** Confirm only after the host-facing delivery operation succeeds. */
export function markTerminalNotificationReceipt(runDir: string, host: string, sessionId: string): TerminalNotificationReceipt {
	const request = readTerminalNotificationRequest(runDir);
	if (request === undefined) throw new Error(`No terminal notification request exists for ${runDir}`);
	const path = terminalNotificationReceiptPath(runDir, host, sessionId);
	const existing = readReceipt(path);
	if (existing !== undefined && existing.requestId === request.requestId && existing.host === host && existing.sessionId === sessionId && existing.state === "confirmed") {
		return existing as TerminalNotificationReceipt;
	}
	const receipt: TerminalNotificationReceipt = {
		version: 1,
		requestId: request.requestId,
		host,
		sessionId,
		state: "confirmed",
		deliveredAt: new Date().toISOString(),
	};
	mkdirSync(join(runDir, TERMINAL_NOTIFICATION_DIR, "receipts"), { recursive: true });
	atomicWriteJson(path, receipt);
	return receipt;
}

export function removeTerminalNotificationReceipt(runDir: string, host: string, sessionId: string): void {
	rmSync(terminalNotificationReceiptPath(runDir, host, sessionId), { force: true });
}

export function removeTerminalNotificationOutbox(runDir: string): void {
	rmSync(join(runDir, TERMINAL_NOTIFICATION_DIR), { recursive: true, force: true });
}

function authoritativeArtifactPath(workDir: string, authoredPath: string): string {
	if (/^[a-z][a-z\d+.-]*:\/\//i.test(authoredPath)) throw new Error(`Terminal artifact '${authoredPath}' is not a local path`);
	const root = resolve(workDir);
	const path = resolve(root, authoredPath);
	const rel = relative(root, path);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Terminal artifact '${authoredPath}' escapes workDir ${root}`);
	return path;
}

function atomicWriteJson(path: string, value: unknown): void {
	const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
	try {
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function readReceipt(path: string): (Partial<TerminalNotificationReceipt> & Pick<TerminalNotificationReceipt, "requestId" | "host" | "sessionId">) | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		if (typeof value.requestId !== "string" || typeof value.host !== "string" || typeof value.sessionId !== "string") return undefined;
		return value as Partial<TerminalNotificationReceipt> & Pick<TerminalNotificationReceipt, "requestId" | "host" | "sessionId">;
	} catch {
		return undefined;
	}
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
