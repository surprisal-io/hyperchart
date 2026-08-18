import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { BranchId } from "../../core/durable_events.js";
import { readSessionProgress, type HyperchartSessionProgress } from "./session_progress.js";

export type SessionSteeringRequest = {
	id: string;
	branchId: BranchId;
	actionKey: string;
	/** Durable invocation coordinate; prevents delivery to a later visit of the same action. */
	invokeSeqId: number;
	message: string;
	createdAt: number;
};

const MAX_STEERING_MESSAGE_LENGTH = 12_000;
const STEERING_POLL_MS = 250;

export function resolveLiveSessionForSteering(
	sessionsDir: string,
	branchId: BranchId,
	actionKey: string,
): HyperchartSessionProgress {
	const matches = Object.entries(readSessionProgress(sessionsDir).sessions)
		.filter(([, session]) => session.branchId === branchId && session.actionKey === actionKey)
		.sort(([leftKey, left], [rightKey, right]) => left.invokeSeqId - right.invokeSeqId || leftKey.localeCompare(rightKey));
	const live = matches.filter(([, session]) => session.status === "starting" || session.status === "running");
	if (live.length === 1) return live[0]![1];
	if (live.length > 1) {
		throw new Error(`Agent session '${actionKey}' is ambiguous on branch '${branchId}' (${live.map(([, session]) => session.invokeSeqId).join(", ")})`);
	}
	const stale = matches.at(-1)?.[1];
	if (stale !== undefined) throw new Error(`Agent session '${stale.actionName}' is ${stale.status} and cannot be steered`);
	throw new Error(`Agent session '${actionKey}' was not found on branch '${branchId}'`);
}

/** Resolve a public semantic action key to exactly one live progress entry, then queue it. */
export function queueLiveSessionSteering(
	sessionsDir: string,
	branchId: BranchId,
	actionKey: string,
	message: string,
): { request: SessionSteeringRequest; session: HyperchartSessionProgress } {
	const session = resolveLiveSessionForSteering(sessionsDir, branchId, actionKey);
	return { request: queueSessionSteering(sessionsDir, branchId, session.actionKey, session.invokeSeqId, message), session };
}

export function queueSessionSteering(sessionsDir: string, branchId: BranchId, actionKey: string, invokeSeqId: number, message: string): SessionSteeringRequest {
	const trimmed = message.trim();
	if (branchId.trim().length === 0) throw new Error("Steering branch is required");
	if (actionKey.length === 0) throw new Error("Steering target is required");
	if (!Number.isSafeInteger(invokeSeqId) || invokeSeqId <= 0) throw new Error("Steering invocation seqId must be a positive safe integer");
	if (trimmed.length === 0) throw new Error("Steering message is required");
	if (trimmed.length > MAX_STEERING_MESSAGE_LENGTH) throw new Error(`Steering message is limited to ${MAX_STEERING_MESSAGE_LENGTH} characters`);
	const request: SessionSteeringRequest = { id: randomUUID(), branchId, actionKey, invokeSeqId, message: trimmed, createdAt: Date.now() };
	const dir = steeringDir(sessionsDir);
	mkdirSync(dir, { recursive: true });
	const target = join(dir, `${request.createdAt}-${request.id}.json`);
	const temporary = `${target}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(request)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
	return request;
}

export function watchSessionSteering(sessionsDir: string, deliver: (request: SessionSteeringRequest) => boolean | Promise<boolean>): () => void {
	let disposed = false;
	let draining = false;
	const drain = async () => {
		if (disposed || draining) return;
		draining = true;
		try {
			for (const file of steeringFiles(sessionsDir)) {
				if (disposed) break;
				const path = join(steeringDir(sessionsDir), file);
				const request = readSteeringRequest(path);
				if (request === undefined) { safeUnlink(path); continue; }
				try { if (await deliver(request)) safeUnlink(path); } catch { /* retain for retry */ }
			}
		} finally { draining = false; }
	};
	void drain();
	const timer = setInterval(() => void drain(), STEERING_POLL_MS);
	timer.unref();
	return () => { disposed = true; clearInterval(timer); };
}

function steeringDir(sessionsDir: string): string { return resolve(sessionsDir, "steering"); }
function steeringFiles(sessionsDir: string): string[] {
	try { return readdirSync(steeringDir(sessionsDir)).filter((file) => file.endsWith(".json")).sort(); } catch { return []; }
}
function readSteeringRequest(path: string): SessionSteeringRequest | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionSteeringRequest>;
		if (typeof value.id !== "string" || typeof value.branchId !== "string" || value.branchId.length === 0 || typeof value.actionKey !== "string" || !Number.isSafeInteger(value.invokeSeqId) || (value.invokeSeqId ?? 0) <= 0 || typeof value.message !== "string" || typeof value.createdAt !== "number") return undefined;
		return { id: value.id, branchId: value.branchId, actionKey: value.actionKey, invokeSeqId: value.invokeSeqId as number, message: value.message, createdAt: value.createdAt };
	} catch { return undefined; }
}
function safeUnlink(path: string): void { try { unlinkSync(path); } catch { /* already removed */ } }
