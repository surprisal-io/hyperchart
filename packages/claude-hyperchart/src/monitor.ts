import { existsSync, readdirSync, realpathSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	USER_INTERACTION_WAIT_LEASE_MS,
	acquireActiveUserInteraction,
	claimTerminalNotificationReceipt,
	claimUserInteractionReceipt,
	hasTerminalNotificationReceipt,
	loadRunMeta,
	markTerminalNotificationReceipt,
	markUserInteractionReceipt,
	readDeliverableTerminalNotificationRequest,
	readUserInteractionReceipt,
	recoverStaleRunTerminalNotification,
	scanOwnedOpenUserInteractions,
	type OwnedUserInteraction,
	type TerminalNotificationRequest,
	type UserInteractionOwner,
} from "@surprisal/hyperchart/runtime";

export type ClaudeMonitorOptions = {
	runsRoot: string;
	cwd: string;
	sessionId?: string;
	writeLine?: (line: string) => void;
};

/** Backwards-compatible name retained for callers that only scan terminal notifications. */
export type ClaudeTerminalMonitorOptions = ClaudeMonitorOptions;

export type OwnedClaudeTerminalRequest = { runDir: string; request: TerminalNotificationRequest };

export function claudeInteractionOwner(options: ClaudeMonitorOptions & { sessionId: string }): UserInteractionOwner {
	return { runsRoot: options.runsRoot, host: "claude", sessionId: options.sessionId, workDir: options.cwd };
}

export function pendingOwnedClaudeTerminalRequests(options: ClaudeMonitorOptions): OwnedClaudeTerminalRequest[] {
	if (options.sessionId === undefined || !existsSync(options.runsRoot)) return [];
	const pending: OwnedClaudeTerminalRequest[] = [];
	for (const entry of readdirSync(options.runsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const runDir = join(options.runsRoot, entry.name);
		try {
			const meta = loadRunMeta(runDir);
			if (canonicalPath(meta.workDir) !== canonicalPath(options.cwd) || meta.originSessionId !== options.sessionId) continue;
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

export function activeOwnedClaudeUserInteraction(options: ClaudeMonitorOptions): OwnedUserInteraction | undefined {
	if (options.sessionId === undefined) return undefined;
	return acquireActiveUserInteraction(claudeInteractionOwner({ ...options, sessionId: options.sessionId }));
}

export function ownedClaudeUserInteractionSummary(options: ClaudeMonitorOptions): {
	active?: ReturnType<typeof claudeUserInteractionDetails> & { presentation: OwnedUserInteraction["presentation"] };
	queued: Array<ReturnType<typeof claudeUserInteractionDetails> & { presentation: OwnedUserInteraction["presentation"] }>;
} {
	if (options.sessionId === undefined) return { queued: [] };
	const owner = claudeInteractionOwner({ ...options, sessionId: options.sessionId });
	const interactions = scanOwnedOpenUserInteractions(owner);
	const active = acquireActiveUserInteraction(owner);
	const activeKey = active === undefined ? undefined : interactionKey(active);
	return {
		...(active === undefined ? {} : { active: { ...claudeUserInteractionDetails(active), presentation: active.presentation } }),
		queued: interactions
			.filter((entry) => interactionKey(entry) !== activeKey)
			.map((entry) => ({ ...claudeUserInteractionDetails(entry), presentation: entry.presentation })),
	};
}

export function claudeUserInteractionDetails(interaction: OwnedUserInteraction) {
	return {
		version: 1 as const,
		runId: interaction.request.runId,
		seqId: interaction.request.seqId,
		prompt: interaction.request.prompt,
		options: interaction.request.options,
		allowedEvents: interaction.request.events.filter((event) => event !== "FAILED"),
		...(interaction.request.reply === undefined ? {} : { reply: interaction.request.reply }),
		...(interaction.request.rejection === undefined ? {} : { rejection: interaction.request.rejection }),
	};
}

export function claudeUserInteractionInstruction(interaction: OwnedUserInteraction): string {
	const details = claudeUserInteractionDetails(interaction);
	return [
		`Hyperchart is waiting for real user input at (${details.runId}, ${details.seqId}).`,
		`Question: ${details.prompt}`,
		details.options.length === 0
			? "This is a free-text question: use AskUserQuestion with an appropriate free-text/Other path and preserve the user's actual answer."
			: `Map these authored options to AskUserQuestion choices: ${details.options.join(", ")}.`,
		`Allowed response events: ${details.allowedEvents.join(", ")}.`,
		details.reply === undefined ? undefined : `Reply contract: ${JSON.stringify(details.reply)}.`,
		"Finish the current safe action first and start no unrelated work.",
		"Then call native AskUserQuestion once for this delivery attempt. If the same gate already has an in-flight question, do not open a concurrent duplicate; after interrupted-session recovery, ask it again. Never infer, fabricate, or supply the answer yourself.",
		`Immediately after the human answers, call hyperchart_respond with runId=${JSON.stringify(details.runId)}, seqId=${details.seqId}, one allowed event, and output when the reply contract requires it.`,
		"Do not continue the workflow until hyperchart_respond confirms the durable commit. Repeated delivery of this same (runId, seqId) is recovery, not a second question.",
	].filter((line): line is string => line !== undefined).join("\n");
}

export function claudeUserInteractionNotification(interaction: OwnedUserInteraction) {
	const details = claudeUserInteractionDetails(interaction);
	return {
		customType: "hyperchart-user-request",
		runId: details.runId,
		seqId: details.seqId,
		content: claudeUserInteractionInstruction(interaction),
		details,
	};
}

/** Emit each prompt as JSON so embedded newlines remain one physical stdout line, then receipt it. */
export function emitPendingClaudeTerminalNotifications(options: ClaudeMonitorOptions): number {
	if (options.sessionId === undefined) return 0;
	const writeLine = options.writeLine ?? ((line: string) => { writeSync(process.stdout.fd, `${line}\n`); });
	let delivered = 0;
	for (const pending of pendingOwnedClaudeTerminalRequests(options)) {
		if (!claimTerminalNotificationReceipt(pending.runDir, "claude", options.sessionId)) continue;
		// Confirm only after stdout accepts the line. A crash between write and confirmation
		// intentionally permits at-least-once redelivery.
		writeLine(JSON.stringify({ customType: "hyperchart-terminal", requestId: pending.request.requestId, content: pending.request.payload.prompt, details: pending.request }));
		markTerminalNotificationReceipt(pending.runDir, "claude", options.sessionId);
		delivered++;
	}
	return delivered;
}

/** Emit at most the arbiter's one pinned user gate, never a queued branch request. */
export function emitPendingClaudeUserInteraction(options: ClaudeMonitorOptions): number {
	if (options.sessionId === undefined) return 0;
	const active = activeOwnedClaudeUserInteraction(options);
	if (active === undefined || active.presentation === "confirmed") return 0;
	const existingClaim = readUserInteractionReceipt(active.runDir, active.request.seqId, "claude", options.sessionId);
	// A waited MCP result is already the delivery path into this Claude turn. Do not
	// re-notify it after the normal monitor lease while AskUserQuestion is still open;
	// SessionStart recovery will re-surface it if that turn/session is interrupted.
	if (existingClaim?.state === "claimed" && existingClaim.source === "wait") {
		const leaseUntil = existingClaim.leaseUntil === undefined ? Number.NaN : Date.parse(existingClaim.leaseUntil);
		const fallbackUntil = existingClaim.claimedAt === undefined
			? Number.NaN
			: Date.parse(existingClaim.claimedAt) + USER_INTERACTION_WAIT_LEASE_MS;
		if ((Number.isFinite(leaseUntil) && Date.now() < leaseUntil) ||
			(!Number.isFinite(leaseUntil) && Number.isFinite(fallbackUntil) && Date.now() < fallbackUntil)) return 0;
	}
	// Defense in depth around the shared owner's canonical/session checks.
	const meta = loadRunMeta(active.runDir);
	if (meta.originSessionId !== options.sessionId || canonicalPath(meta.workDir) !== canonicalPath(options.cwd)) return 0;
	if (!claimUserInteractionReceipt(active.runDir, active.request.seqId, "claude", options.sessionId, { source: "monitor" })) return 0;
	// Claim and selection are separate filesystem operations. Re-arbitrate after the
	// exclusive claim so a concurrently-created lower coordinate cannot be presented too.
	const current = activeOwnedClaudeUserInteraction(options);
	if (current === undefined || interactionKey(current) !== interactionKey(active)) return 0;
	const writeLine = options.writeLine ?? ((line: string) => { writeSync(process.stdout.fd, `${line}\n`); });
	writeLine(JSON.stringify(claudeUserInteractionNotification(current)));
	markUserInteractionReceipt(current.runDir, current.request.seqId, "claude", options.sessionId);
	return 1;
}

/** Combined persistent-monitor scan for terminal notifications and the one active user gate. */
export function emitPendingClaudeNotifications(options: ClaudeMonitorOptions): number {
	return emitPendingClaudeTerminalNotifications(options) + emitPendingClaudeUserInteraction(options);
}

function interactionKey(interaction: OwnedUserInteraction): string {
	return `${interaction.request.runId}\0${interaction.request.seqId}`;
}

function canonicalPath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}
