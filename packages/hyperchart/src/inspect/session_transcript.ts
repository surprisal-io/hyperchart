import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { HyperchartSessionMessageInfo } from "../host/models.js";

export const MAX_TRANSCRIPT_MESSAGES = 120;
export const MAX_TRANSCRIPT_TEXT_LENGTH = 16_000;

/**
 * Reads the display transcript for one agent session file. Hosts plug their own
 * reader into run inspection; the neutral JSONL format below is the default.
 */
export type SessionTranscriptReadOptions = {
	/** Maximum newest messages to return. `false` preserves the full transcript for per-visit segmentation. */
	limit?: number | false;
};

/** Containment guard shared by transcript readers: only files inside sessionsDir are readable. */
export function resolveContainedSessionFile(sessionsDir: string, sessionFile: string): string | undefined {
	const root = resolve(sessionsDir);
	const file = resolve(sessionFile);
	try {
		const realRoot = realpathSync(root);
		const realFile = realpathSync(file);
		const fromRoot = relative(realRoot, realFile);
		if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) return undefined;
		return file;
	} catch {
		return undefined;
	}
}

/**
 * Collapses a tool call and its matching result (paired by toolCallId) into one
 * lifecycle entry whose toolStatus moves running → completed/error.
 */
export function combineToolLifecycle(messages: HyperchartSessionMessageInfo[]): HyperchartSessionMessageInfo[] {
	const combined: HyperchartSessionMessageInfo[] = [];
	const calls = new Map<string, number>();
	for (const message of messages) {
		if (message.role !== "tool" || message.toolCallId === undefined) {
			combined.push(message);
			continue;
		}
		if (message.toolStatus === "running") {
			calls.set(message.toolCallId, combined.length);
			combined.push(message);
			continue;
		}
		const callIndex = calls.get(message.toolCallId);
		if (callIndex === undefined) {
			combined.push(message);
			continue;
		}
		const call = combined[callIndex];
		if (call === undefined) continue;
		combined[callIndex] = {
			...call,
			toolStatus: message.toolStatus ?? (message.isError === true ? "error" : "completed"),
			...(message.toolOutput === undefined ? {} : { toolOutput: message.toolOutput }),
			...(message.isError === true ? { isError: true } : {}),
		};
	}
	return combined;
}

export function truncateTranscriptText(value: string): string {
	return value.length <= MAX_TRANSCRIPT_TEXT_LENGTH ? value : `${value.slice(0, MAX_TRANSCRIPT_TEXT_LENGTH)}\n…`;
}

export type NeutralTranscriptHeader = {
	hyperchartTranscript: 1;
	sessionId: string;
	createdAt: number;
};

/**
 * Neutral transcript format: a JSONL file whose first record is a
 * NeutralTranscriptHeader and whose remaining records are pre-flattened
 * HyperchartSessionMessageInfo entries. Non-Pi hosts write this format from
 * their own streaming events; the reader below is the default for run
 * inspection.
 */
export function readNeutralSessionTranscript(
	sessionsDir: string,
	sessionFile: string | undefined,
	options: SessionTranscriptReadOptions = {},
): HyperchartSessionMessageInfo[] | undefined {
	if (sessionFile === undefined) return undefined;
	const file = resolveContainedSessionFile(sessionsDir, sessionFile);
	if (file === undefined) return undefined;
	try {
		const lines = readFileSync(file, "utf8").split("\n");
		if (!isNeutralHeaderLine(lines[0])) return undefined;
		const messages: HyperchartSessionMessageInfo[] = [];
		for (const line of lines.slice(1)) {
			if (line.trim().length === 0) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				// A writer may still be appending the final JSONL record during an inspector poll.
				continue;
			}
			const message = normalizeNeutralRecord(entry);
			if (message !== undefined) messages.push(message);
		}
		return limitTranscriptMessages(combineToolLifecycle(messages), options);
	} catch {
		return undefined;
	}
}

export function limitTranscriptMessages(
	messages: HyperchartSessionMessageInfo[],
	options: SessionTranscriptReadOptions = {},
): HyperchartSessionMessageInfo[] {
	const limit = options.limit === undefined ? MAX_TRANSCRIPT_MESSAGES : options.limit;
	if (limit === false) return messages;
	if (!Number.isFinite(limit) || limit < 0) throw new RangeError("Transcript message limit must be a finite non-negative number or false");
	const count = Math.floor(limit);
	return count === 0 ? [] : messages.slice(-count);
}

function isNeutralHeaderLine(line: string | undefined): boolean {
	if (line === undefined) return false;
	try {
		const parsed = JSON.parse(line) as unknown;
		return isRecord(parsed) && parsed.hyperchartTranscript === 1;
	} catch {
		return false;
	}
}

function normalizeNeutralRecord(value: unknown): HyperchartSessionMessageInfo | undefined {
	if (!isRecord(value) || typeof value.id !== "string") return undefined;
	const role = value.role;
	if (role !== "user" && role !== "assistant" && role !== "reasoning" && role !== "tool" && role !== "system") {
		return undefined;
	}
	const toolStatus = value.toolStatus;
	return {
		id: value.id,
		role,
		...(typeof value.text === "string" ? { text: truncateTranscriptText(value.text) } : {}),
		...(typeof value.toolName === "string" ? { toolName: value.toolName } : {}),
		...(typeof value.toolCallId === "string" ? { toolCallId: value.toolCallId } : {}),
		...(typeof value.toolInput === "string" ? { toolInput: truncateTranscriptText(value.toolInput) } : {}),
		...(typeof value.toolOutput === "string" ? { toolOutput: truncateTranscriptText(value.toolOutput) } : {}),
		...(toolStatus === "running" || toolStatus === "completed" || toolStatus === "error" ? { toolStatus } : {}),
		...(value.isError === true ? { isError: true } : {}),
		...(typeof value.timestamp === "number" ? { timestamp: value.timestamp } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
