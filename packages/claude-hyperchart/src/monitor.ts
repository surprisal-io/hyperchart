import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	claimTerminalNotificationReceipt,
	hasTerminalNotificationReceipt,
	loadRunMeta,
	markTerminalNotificationReceipt,
	readDeliverableTerminalNotificationRequest,
	recoverStaleRunTerminalNotification,
	type TerminalNotificationRequest,
} from "@surprisal/hyperchart/runtime";

export type ClaudeTerminalMonitorOptions = {
	runsRoot: string;
	cwd: string;
	sessionId?: string;
	writeLine?: (line: string) => void;
};

export type OwnedClaudeTerminalRequest = { runDir: string; request: TerminalNotificationRequest };

export function pendingOwnedClaudeTerminalRequests(options: ClaudeTerminalMonitorOptions): OwnedClaudeTerminalRequest[] {
	if (options.sessionId === undefined || !existsSync(options.runsRoot)) return [];
	const pending: OwnedClaudeTerminalRequest[] = [];
	for (const entry of readdirSync(options.runsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const runDir = join(options.runsRoot, entry.name);
		try {
			const meta = loadRunMeta(runDir);
			if (resolve(meta.workDir) !== resolve(options.cwd) || meta.originSessionId !== options.sessionId) continue;
			recoverStaleRunTerminalNotification(runDir);
			const request = readDeliverableTerminalNotificationRequest(runDir);
			if (request === undefined || hasTerminalNotificationReceipt(runDir, "claude", options.sessionId)) continue;
			pending.push({ runDir, request });
		} catch {
			// A concurrently-created or unrelated malformed run must not break monitor routing.
		}
	}
	return pending.sort((left, right) => left.request.createdAt.localeCompare(right.request.createdAt));
}

/** Emit each prompt as JSON so embedded newlines remain one physical stdout line, then receipt it. */
export function emitPendingClaudeTerminalNotifications(options: ClaudeTerminalMonitorOptions): number {
	if (options.sessionId === undefined) return 0;
	const writeLine = options.writeLine ?? ((line: string) => process.stdout.write(`${line}\n`));
	let delivered = 0;
	for (const pending of pendingOwnedClaudeTerminalRequests(options)) {
		if (!claimTerminalNotificationReceipt(pending.runDir, "claude", options.sessionId)) continue;
		// JSON encoding keeps requestId and embedded prompt newlines on one physical line.
		// Confirm only after stdout accepts the line. If the process dies first, the claim
		// expires; if it dies between these operations Claude may receive a duplicate.
		writeLine(JSON.stringify({ customType: "hyperchart-terminal", requestId: pending.request.requestId, content: pending.request.payload.prompt, details: pending.request }));
		markTerminalNotificationReceipt(pending.runDir, "claude", options.sessionId);
		delivered++;
	}
	return delivered;
}
