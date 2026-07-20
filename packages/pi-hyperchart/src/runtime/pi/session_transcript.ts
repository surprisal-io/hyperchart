import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { HyperchartSessionMessageInfo } from "@surprisal/hyperchart/host";

const MAX_MESSAGES = 120;
const MAX_TEXT_LENGTH = 16_000;

export function readSessionTranscript(
	sessionsDir: string,
	sessionFile: string | undefined,
): HyperchartSessionMessageInfo[] | undefined {
	if (sessionFile === undefined) return undefined;
	const root = resolve(sessionsDir);
	const file = resolve(sessionFile);
	if (!isAbsolute(file)) return undefined;
	try {
		const realRoot = realpathSync(root);
		const realFile = realpathSync(file);
		const fromRoot = relative(realRoot, realFile);
		if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) return undefined;
		const messages: HyperchartSessionMessageInfo[] = [];
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (line.trim().length === 0) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				// A writer may still be appending the final JSONL record during an inspector poll.
				continue;
			}
			messages.push(...messagesFromEntry(entry));
		}
		return combineToolLifecycle(messages).slice(-MAX_MESSAGES);
	} catch {
		return undefined;
	}
}

function messagesFromEntry(value: unknown): HyperchartSessionMessageInfo[] {
	if (!isRecord(value) || typeof value.id !== "string") return [];
	const timestamp = messageTimestamp(value);
	if (value.type === "message" && isRecord(value.message)) {
		const message = value.message;
		const role = message.role;
		if (role === "user") return [messageInfo(value.id, "user", contentText(message.content), timestamp)];
		if (role === "assistant") {
			const out: HyperchartSessionMessageInfo[] = [];
			if (Array.isArray(message.content)) {
				const reasoning = message.content
					.filter((block) => isRecord(block) && block.type === "thinking" && typeof block.thinking === "string")
					.map((block) => (block as { thinking: string }).thinking)
					.join("\n\n");
				if (reasoning.length > 0) out.push(messageInfo(`${value.id}:reasoning`, "reasoning", reasoning, timestamp));
			}
			const text = contentText(message.content);
			if (text !== undefined) out.push(messageInfo(value.id, "assistant", text, timestamp));
			if (Array.isArray(message.content)) {
				message.content.forEach((block, index) => {
					if (!isRecord(block) || block.type !== "toolCall" || typeof block.name !== "string") return;
					out.push({
						id: `${value.id}:tool:${index}`,
						role: "tool",
						toolName: block.name,
						...(typeof block.id === "string" ? { toolCallId: block.id } : {}),
						toolInput: truncate(stringify(block.arguments)),
						toolStatus: "running",
						...(timestamp === undefined ? {} : { timestamp }),
					});
				});
			}
			return out;
		}
		if (role === "toolResult" && typeof message.toolName === "string") {
			const output = contentText(message.content);
			return [{
				id: value.id,
				role: "tool",
				toolName: message.toolName,
				...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
				...(output === undefined ? {} : { toolOutput: output }),
				toolStatus: message.isError === true ? "error" : "completed",
				...(message.isError === true ? { isError: true } : {}),
				...(timestamp === undefined ? {} : { timestamp }),
			}];
		}
	}
	if (value.type === "compaction" && typeof value.summary === "string") {
		return [messageInfo(value.id, "system", `Context compacted\n${value.summary}`, timestamp)];
	}
	if (value.type === "branch_summary" && typeof value.summary === "string") {
		return [messageInfo(value.id, "system", `Branch summary\n${value.summary}`, timestamp)];
	}
	return [];
}

function combineToolLifecycle(messages: HyperchartSessionMessageInfo[]): HyperchartSessionMessageInfo[] {
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

function messageInfo(
	id: string,
	role: HyperchartSessionMessageInfo["role"],
	text: string | undefined,
	timestamp: number | undefined,
): HyperchartSessionMessageInfo {
	return {
		id,
		role,
		...(text === undefined ? {} : { text: truncate(text) }),
		...(timestamp === undefined ? {} : { timestamp }),
	};
}

function contentText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts = content.flatMap((block) => {
		if (!isRecord(block)) return [];
		if (block.type === "text" && typeof block.text === "string") return [block.text];
		return [];
	});
	return parts.length === 0 ? undefined : parts.join("\n\n");
}

function messageTimestamp(entry: Record<string, unknown>): number | undefined {
	const message = isRecord(entry.message) ? entry.message : undefined;
	if (typeof message?.timestamp === "number") return message.timestamp;
	if (typeof entry.timestamp !== "string") return undefined;
	const parsed = Date.parse(entry.timestamp);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function stringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function truncate(value: string): string {
	return value.length <= MAX_TEXT_LENGTH ? value : `${value.slice(0, MAX_TEXT_LENGTH)}\n…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
