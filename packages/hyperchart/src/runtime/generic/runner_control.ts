import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ChartEvent } from "../../core/types.js";
import type { BranchId, UserInteractionResolvedLog } from "../../core/durable_events.js";
import type { UserInteractionResponseCommit } from "./log_store.js";
import { isRunLive, readRunStatus } from "./run_status.js";

const CONTROL_VERSION = 1;
const CONTROL_POLL_MS = 50;
const CONTROL_TIMEOUT_MS = 30_000;

type RunnerControlBase = Readonly<{
	version: 1;
	id: string;
	attemptId: string;
	branchId: BranchId;
	createdAt: number;
}>;

export type RunnerUserResponseRequest = RunnerControlBase & Readonly<{
	kind: "respond_user_interaction";
	gateSeqId: number;
	event: ChartEvent;
}>;

export type RunnerMoveBranchRequest = RunnerControlBase & Readonly<{
	kind: "move_branch";
	targetHeadSeqId: number | null;
}>;

export type RunnerControlRequest = RunnerUserResponseRequest | RunnerMoveBranchRequest;

type RunnerControlFailure = Readonly<{
	version: 1;
	kind: RunnerControlRequest["kind"];
	requestId: string;
	attemptId: string;
	ok: false;
	error: string;
	completedAt: number;
}>;

export type RunnerUserResponseResult = Readonly<{
	version: 1;
	kind: "respond_user_interaction";
	requestId: string;
	attemptId: string;
	ok: true;
	idempotent: boolean;
	record: UserInteractionResolvedLog;
	completedAt: number;
}> | RunnerControlFailure;

export type RunnerMoveBranchCommit = Readonly<{
	moveSeqId: number;
	previousHeadSeqId: number | null;
	preservedRecords: number;
}>;

export type RunnerMoveBranchResult = Readonly<{
	version: 1;
	kind: "move_branch";
	requestId: string;
	attemptId: string;
	ok: true;
	moveSeqId: number;
	previousHeadSeqId: number | null;
	preservedRecords: number;
	completedAt: number;
}> | RunnerControlFailure;

export type RunnerControlResult = RunnerUserResponseResult | RunnerMoveBranchResult;
export type RunnerControlCommit = UserInteractionResponseCommit | RunnerMoveBranchCommit;

export class RunnerControlUnavailableError extends Error {
	constructor(message: string) { super(message); this.name = "RunnerControlUnavailableError"; }
}

/** Submit a gate response through the owning live runtime and wait for its durable acknowledgement. */
export async function requestLiveRunnerUserResponse(
	runDir: string,
	input: { attemptId: string; branchId: BranchId; gateSeqId: number; event: ChartEvent },
	options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<UserInteractionResponseCommit> {
	const request: RunnerUserResponseRequest = {
		version: CONTROL_VERSION,
		kind: "respond_user_interaction",
		id: randomUUID(),
		attemptId: input.attemptId,
		branchId: input.branchId,
		gateSeqId: input.gateSeqId,
		event: input.event,
		createdAt: Date.now(),
	};
	const result = await publishAndWait(runDir, request, options);
	if (result.kind !== "respond_user_interaction") throw new RunnerControlUnavailableError("Runner returned the wrong control result kind");
	return { record: result.record, idempotent: result.idempotent };
}

/** Submit a live branch-head move through the owning runtime's sealed writer. */
export async function requestLiveRunnerBranchMove(
	runDir: string,
	input: { attemptId: string; branchId: BranchId; targetHeadSeqId: number | null },
	options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<RunnerMoveBranchCommit> {
	const request: RunnerMoveBranchRequest = {
		version: CONTROL_VERSION,
		kind: "move_branch",
		id: randomUUID(),
		attemptId: input.attemptId,
		branchId: input.branchId,
		targetHeadSeqId: input.targetHeadSeqId,
		createdAt: Date.now(),
	};
	const result = await publishAndWait(runDir, request, options);
	if (result.kind !== "move_branch") throw new RunnerControlUnavailableError("Runner returned the wrong control result kind");
	return { moveSeqId: result.moveSeqId, previousHeadSeqId: result.previousHeadSeqId, preservedRecords: result.preservedRecords };
}

/** Runner-owned control drain. Commands are transport only; the journal remains semantic truth. */
export function watchRunnerControl(
	runDir: string,
	attemptId: string,
	deliver: (request: RunnerControlRequest) => Promise<RunnerControlCommit>,
): () => void {
	let disposed = false;
	let draining = false;
	const drain = async () => {
		if (disposed || draining) return;
		draining = true;
		try {
			for (const file of requestFiles(runDir)) {
				if (disposed) break;
				const path = join(requestsDir(runDir), file);
				const request = readRequest(path);
				if (request === undefined) { safeUnlink(path); continue; }
				if (request.attemptId !== attemptId) { safeUnlink(path); continue; }
				let result: RunnerControlResult;
				try {
					const committed = await deliver(request);
					if (request.kind === "move_branch") {
						if (!isMoveCommit(committed)) throw new Error("Runner move control returned invalid commit metadata");
						result = { version: CONTROL_VERSION, kind: request.kind, requestId: request.id, attemptId, ok: true, ...committed, completedAt: Date.now() };
					} else {
						if (typeof committed !== "object" || committed === null || !("record" in committed)) throw new Error("Runner response control returned an invalid commit");
						result = { version: CONTROL_VERSION, kind: request.kind, requestId: request.id, attemptId, ok: true, idempotent: committed.idempotent, record: committed.record, completedAt: Date.now() };
					}
				} catch (error) {
					result = { version: CONTROL_VERSION, kind: request.kind, requestId: request.id, attemptId, ok: false, error: error instanceof Error ? error.message : String(error), completedAt: Date.now() };
				}
				try { publishJsonExclusive(resultPath(runDir, request.id), result); }
				catch (error) { if (!isNodeError(error) || error.code !== "EEXIST") continue; }
				safeUnlink(path);
			}
		} finally { draining = false; }
	};
	void drain();
	// This referenced control loop keeps a detached runtime alive while every branch is
	// durably waiting at a user gate. Controller shutdown clears it.
	const timer = setInterval(() => void drain(), CONTROL_POLL_MS);
	return () => { disposed = true; clearInterval(timer); };
}

/** Backward-compatible response-only watcher used by focused admission tests. */
export function watchRunnerUserResponses(
	runDir: string,
	attemptId: string,
	deliver: (request: RunnerUserResponseRequest) => Promise<UserInteractionResponseCommit>,
): () => void {
	return watchRunnerControl(runDir, attemptId, (request) => {
		if (request.kind !== "respond_user_interaction") return Promise.reject(new Error("This runner control watcher does not accept branch moves"));
		return deliver(request);
	});
}

async function publishAndWait(
	runDir: string,
	request: RunnerControlRequest,
	options: { timeoutMs?: number; pollMs?: number },
): Promise<Extract<RunnerControlResult, { ok: true }>> {
	publishJsonExclusive(requestPath(runDir, request.id), request);
	return waitForResult(runDir, request, options);
}

function waitForResult(
	runDir: string,
	request: RunnerControlRequest,
	options: { timeoutMs?: number; pollMs?: number },
): Promise<Extract<RunnerControlResult, { ok: true }>> {
	const timeoutMs = options.timeoutMs ?? CONTROL_TIMEOUT_MS;
	const pollMs = options.pollMs ?? CONTROL_POLL_MS;
	const started = Date.now();
	return new Promise((resolveResult, rejectResult) => {
		const finish = (callback: () => void) => { clearInterval(timer); callback(); };
		const check = () => {
			const result = readResult(resultPath(runDir, request.id));
			if (result !== undefined) {
				return finish(() => {
					rmSync(resultPath(runDir, request.id), { force: true });
					if (result.attemptId !== request.attemptId) return rejectResult(new RunnerControlUnavailableError("Runner attempt changed before control acknowledgement"));
					if (result.kind !== request.kind) return rejectResult(new RunnerControlUnavailableError("Runner returned the wrong control result kind"));
					if (!result.ok) return rejectResult(new Error(result.error));
					resolveResult(result);
				});
			}
			const status = readRunStatus(runDir);
			if (!isRunLive(status) || status?.attemptId !== request.attemptId) {
				return finish(() => { rmSync(requestPath(runDir, request.id), { force: true }); rejectResult(new RunnerControlUnavailableError("Owning Hyperchart runtime stopped before control acknowledgement")); });
			}
			if (Date.now() - started >= timeoutMs) {
				return finish(() => { rmSync(requestPath(runDir, request.id), { force: true }); rejectResult(new RunnerControlUnavailableError("Timed out waiting for owning Hyperchart runtime control acknowledgement")); });
			}
		};
		const timer = setInterval(check, pollMs);
		timer.unref();
		check();
	});
}

function controlDir(runDir: string): string { return resolve(runDir, "runner-control", "user-responses"); }
function requestsDir(runDir: string): string { return join(controlDir(runDir), "requests"); }
function resultsDir(runDir: string): string { return join(controlDir(runDir), "results"); }
function requestPath(runDir: string, id: string): string { return join(requestsDir(runDir), `${id}.json`); }
function resultPath(runDir: string, id: string): string { return join(resultsDir(runDir), `${id}.json`); }
function requestFiles(runDir: string): string[] {
	try { return readdirSync(requestsDir(runDir)).filter((file) => file.endsWith(".json")).sort(); }
	catch { return []; }
}
function publishJsonExclusive(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	try { renameSync(temporary, path); } catch (error) { rmSync(temporary, { force: true }); throw error; }
}
function readRequest(path: string): RunnerControlRequest | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<RunnerControlRequest>;
		if (value.version !== CONTROL_VERSION || typeof value.id !== "string" || typeof value.attemptId !== "string" || typeof value.branchId !== "string" || typeof value.createdAt !== "number") return undefined;
		if (value.kind === "move_branch") {
			if (value.targetHeadSeqId !== null && !isPositiveInteger(value.targetHeadSeqId)) return undefined;
			return value as RunnerMoveBranchRequest;
		}
		if (value.kind !== "respond_user_interaction" || !isPositiveInteger(value.gateSeqId) || !isChartEvent(value.event)) return undefined;
		return value as RunnerUserResponseRequest;
	} catch { return undefined; }
}
function readResult(path: string): RunnerControlResult | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & { record?: Partial<UserInteractionResolvedLog> };
		if (value.version !== CONTROL_VERSION || (value.kind !== "respond_user_interaction" && value.kind !== "move_branch") || typeof value.requestId !== "string" || typeof value.attemptId !== "string" || typeof value.ok !== "boolean" || typeof value.completedAt !== "number") return undefined;
		if (!value.ok) return typeof value.error === "string" ? value as unknown as RunnerControlFailure : undefined;
		if (value.kind === "move_branch") {
			return isPositiveInteger(value.moveSeqId) && (value.previousHeadSeqId === null || isPositiveInteger(value.previousHeadSeqId)) && isNonNegativeInteger(value.preservedRecords)
				? value as unknown as RunnerMoveBranchResult
				: undefined;
		}
		if (typeof value.idempotent !== "boolean" || value.record?.type !== "user_interaction" || value.record.kind !== "resolved" || !isPositiveInteger(value.record.seqId) || !isPositiveInteger(value.record.gateSeqId)) return undefined;
		return value as unknown as RunnerUserResponseResult;
	} catch { return undefined; }
}
function isChartEvent(value: unknown): value is ChartEvent { return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { type?: unknown }).type === "string"; }
function isMoveCommit(value: RunnerControlCommit): value is RunnerMoveBranchCommit {
	return typeof value === "object" && value !== null && "moveSeqId" in value && isPositiveInteger(value.moveSeqId)
		&& (value.previousHeadSeqId === null || isPositiveInteger(value.previousHeadSeqId)) && isNonNegativeInteger(value.preservedRecords);
}
function isPositiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function isNonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function safeUnlink(path: string): void { try { unlinkSync(path); } catch {} }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
