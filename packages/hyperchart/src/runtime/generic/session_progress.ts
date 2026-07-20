import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { actionUidKey } from "../../core/action_uid.js";
import type { ActionUID } from "../../core/types.js";

export { actionUidKey };

export type HyperchartSessionStatus = "starting" | "running" | "completed" | "failed" | "cancelled";

export type HyperchartSessionProgress = {
	actionKey: string;
	actionUid: ActionUID;
	actionName: string;
	status: HyperchartSessionStatus;
	startedAt: number;
	lastActivityAt: number;
	completedAt?: number;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	turnCount: number;
	toolCount: number;
	tokenCount?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentText?: string;
	currentReasoning?: string;
	lastMessage?: string;
	error?: string;
};

export type HyperchartSessionProgressFile = {
	version: 1;
	updatedAt: number;
	sessions: Record<string, HyperchartSessionProgress>;
};

export function sessionProgressPath(sessionsDir: string): string {
	return join(sessionsDir, "progress.json");
}

export function readSessionProgress(sessionsDir: string): HyperchartSessionProgressFile {
	const file = sessionProgressPath(sessionsDir);
	if (!existsSync(file)) return emptyProgress();
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<HyperchartSessionProgressFile>;
		return {
			version: 1,
			updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
			sessions: isRecord(parsed.sessions) ? normalizeSessions(parsed.sessions) : {},
		};
	} catch {
		return emptyProgress();
	}
}

type SessionProgressPatch = {
	[K in keyof Omit<HyperchartSessionProgress, "actionKey" | "actionUid">]?:
		| Omit<HyperchartSessionProgress, "actionKey" | "actionUid">[K]
		| undefined;
};

export function updateSessionProgress(sessionsDir: string, actionUid: ActionUID, patch: SessionProgressPatch): void {
	const actionKey = actionUidKey(actionUid);
	const file = readSessionProgress(sessionsDir);
	const now = Date.now();
	const previous = file.sessions[actionKey];
	const completedAt = valueFor("completedAt", patch, previous);
	const sessionFile = valueFor("sessionFile", patch, previous);
	const model = valueFor("model", patch, previous);
	const thinking = valueFor("thinking", patch, previous);
	const tokenCount = valueFor("tokenCount", patch, previous);
	const currentTool = valueFor("currentTool", patch, previous);
	const currentToolArgs = valueFor("currentToolArgs", patch, previous);
	const currentToolStartedAt = valueFor("currentToolStartedAt", patch, previous);
	const currentText = valueFor("currentText", patch, previous);
	const currentReasoning = valueFor("currentReasoning", patch, previous);
	const lastMessage = valueFor("lastMessage", patch, previous);
	const error = valueFor("error", patch, previous);
	const next: HyperchartSessionProgress = {
		actionKey,
		actionUid,
		actionName: valueFor("actionName", patch, previous) ?? actionUid.action,
		status: valueFor("status", patch, previous) ?? "starting",
		startedAt: valueFor("startedAt", patch, previous) ?? now,
		turnCount: valueFor("turnCount", patch, previous) ?? 0,
		toolCount: valueFor("toolCount", patch, previous) ?? 0,
		lastActivityAt: patch.lastActivityAt ?? now,
		...(tokenCount === undefined ? {} : { tokenCount }),
		...(completedAt === undefined ? {} : { completedAt }),
		...(sessionFile === undefined ? {} : { sessionFile }),
		...(model === undefined ? {} : { model }),
		...(thinking === undefined ? {} : { thinking }),
		...(currentTool === undefined ? {} : { currentTool }),
		...(currentToolArgs === undefined ? {} : { currentToolArgs }),
		...(currentToolStartedAt === undefined ? {} : { currentToolStartedAt }),
		...(currentText === undefined ? {} : { currentText }),
		...(currentReasoning === undefined ? {} : { currentReasoning }),
		...(lastMessage === undefined ? {} : { lastMessage }),
		...(error === undefined ? {} : { error }),
	};
	file.sessions[actionKey] = next;
	file.updatedAt = now;
	writeFileSync(sessionProgressPath(sessionsDir), `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

function emptyProgress(): HyperchartSessionProgressFile {
	return { version: 1, updatedAt: 0, sessions: {} };
}

function normalizeSessions(value: Record<string, unknown>): Record<string, HyperchartSessionProgress> {
	const out: Record<string, HyperchartSessionProgress> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!isRecord(entry)) continue;
		if (!isActionUid(entry.actionUid)) continue;
		const status = parseStatus(entry.status);
		if (status === undefined) continue;
		out[key] = {
			actionKey: typeof entry.actionKey === "string" ? entry.actionKey : key,
			actionUid: entry.actionUid,
			actionName: typeof entry.actionName === "string" ? entry.actionName : entry.actionUid.action,
			status,
			startedAt: typeof entry.startedAt === "number" ? entry.startedAt : 0,
			lastActivityAt: typeof entry.lastActivityAt === "number" ? entry.lastActivityAt : 0,
			...(typeof entry.completedAt === "number" ? { completedAt: entry.completedAt } : {}),
			...(typeof entry.sessionFile === "string" ? { sessionFile: entry.sessionFile } : {}),
			...(typeof entry.model === "string" ? { model: entry.model } : {}),
			...(typeof entry.thinking === "string" ? { thinking: entry.thinking } : {}),
			turnCount: typeof entry.turnCount === "number" ? entry.turnCount : 0,
			toolCount: typeof entry.toolCount === "number" ? entry.toolCount : 0,
			...(typeof entry.tokenCount === "number" ? { tokenCount: entry.tokenCount } : {}),
			...(typeof entry.currentTool === "string" ? { currentTool: entry.currentTool } : {}),
			...(typeof entry.currentToolArgs === "string" ? { currentToolArgs: entry.currentToolArgs } : {}),
			...(typeof entry.currentToolStartedAt === "number" ? { currentToolStartedAt: entry.currentToolStartedAt } : {}),
			...(typeof entry.currentText === "string" ? { currentText: entry.currentText } : {}),
			...(typeof entry.currentReasoning === "string" ? { currentReasoning: entry.currentReasoning } : {}),
			...(typeof entry.lastMessage === "string" ? { lastMessage: entry.lastMessage } : {}),
			...(typeof entry.error === "string" ? { error: entry.error } : {}),
		};
	}
	return out;
}

function parseStatus(value: unknown): HyperchartSessionStatus | undefined {
	return value === "starting" ||
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "cancelled"
		? value
		: undefined;
}

function isActionUid(value: unknown): value is ActionUID {
	return (
		isRecord(value) &&
		typeof value.chart === "string" &&
		typeof value.state === "string" &&
		typeof value.action === "string"
	);
}

function valueFor<K extends keyof Omit<HyperchartSessionProgress, "actionKey" | "actionUid">>(
	key: K,
	patch: SessionProgressPatch,
	previous: HyperchartSessionProgress | undefined,
): HyperchartSessionProgress[K] | undefined {
	return Object.hasOwn(patch, key) ? (patch[key] as HyperchartSessionProgress[K] | undefined) : previous?.[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type StreamingProgressWriter = {
	appendText(delta: string): void;
	appendReasoning(delta: string): void;
	/** Clears buffers and any pending write without publishing. */
	reset(): void;
	dispose(): void;
};

/**
 * Buffers streaming text/thinking deltas and writes them to session progress at
 * most every 250ms, so live views stay fresh without a write per token.
 */
export function createThrottledProgressWriter(
	sessionsDir: string,
	actionUid: ActionUID,
	actionName: string,
): StreamingProgressWriter {
	let currentText = "";
	let currentReasoning = "";
	let lastWrite = 0;
	let timer: NodeJS.Timeout | undefined;
	const clearTimer = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	const publish = () => {
		clearTimer();
		lastWrite = Date.now();
		updateSessionProgress(sessionsDir, actionUid, {
			actionName,
			status: "running",
			currentText: currentText.length === 0 ? undefined : currentText.slice(-32_000),
			currentReasoning: currentReasoning.length === 0 ? undefined : currentReasoning.slice(-32_000),
		});
	};
	const schedule = () => {
		const wait = 250 - (Date.now() - lastWrite);
		if (wait <= 0) {
			publish();
			return;
		}
		if (timer === undefined) {
			timer = setTimeout(publish, wait);
			timer.unref();
		}
	};
	return {
		appendText(delta) {
			currentText += delta;
			schedule();
		},
		appendReasoning(delta) {
			currentReasoning += delta;
			schedule();
		},
		reset() {
			currentText = "";
			currentReasoning = "";
			clearTimer();
		},
		dispose: clearTimer,
	};
}
