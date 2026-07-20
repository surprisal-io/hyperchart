import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type SessionSteeringRequest = {
	id: string;
	actionKey: string;
	message: string;
	createdAt: number;
};

const MAX_STEERING_MESSAGE_LENGTH = 12_000;
const STEERING_POLL_MS = 250;

export function queueSessionSteering(sessionsDir: string, actionKey: string, message: string): SessionSteeringRequest {
	const trimmed = message.trim();
	if (actionKey.length === 0) throw new Error("Steering target is required");
	if (trimmed.length === 0) throw new Error("Steering message is required");
	if (trimmed.length > MAX_STEERING_MESSAGE_LENGTH) {
		throw new Error(`Steering message is limited to ${MAX_STEERING_MESSAGE_LENGTH} characters`);
	}
	const request: SessionSteeringRequest = { id: randomUUID(), actionKey, message: trimmed, createdAt: Date.now() };
	const dir = steeringDir(sessionsDir);
	mkdirSync(dir, { recursive: true });
	const target = join(dir, `${request.createdAt}-${request.id}.json`);
	const temporary = `${target}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(request)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
	return request;
}

export function watchSessionSteering(
	sessionsDir: string,
	deliver: (request: SessionSteeringRequest) => boolean | Promise<boolean>,
): () => void {
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
				if (request === undefined) {
					safeUnlink(path);
					continue;
				}
				try {
					if (await deliver(request)) safeUnlink(path);
				} catch {
					// Keep the request queued while the target session is temporarily unavailable.
				}
			}
		} finally {
			draining = false;
		}
	};
	void drain();
	const timer = setInterval(() => void drain(), STEERING_POLL_MS);
	timer.unref();
	return () => {
		disposed = true;
		clearInterval(timer);
	};
}

function steeringDir(sessionsDir: string): string {
	return resolve(sessionsDir, "steering");
}

function steeringFiles(sessionsDir: string): string[] {
	try {
		return readdirSync(steeringDir(sessionsDir)).filter((file) => file.endsWith(".json")).sort();
	} catch {
		return [];
	}
}

function readSteeringRequest(path: string): SessionSteeringRequest | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionSteeringRequest>;
		if (
			typeof value.id !== "string" ||
			typeof value.actionKey !== "string" ||
			typeof value.message !== "string" ||
			typeof value.createdAt !== "number"
		) return undefined;
		return { id: value.id, actionKey: value.actionKey, message: value.message, createdAt: value.createdAt };
	} catch {
		return undefined;
	}
}

function safeUnlink(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Another drain or shutdown may already have removed it.
	}
}
