import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type HyperchartRunState = "starting" | "running" | "complete" | "failed" | "stopping" | "stopped";

export type HyperchartRunStatus = {
	version: 1;
	runId: string;
	runDir: string;
	chartId: string;
	state: HyperchartRunState;
	pid?: number;
	startedAt: number;
	updatedAt: number;
	heartbeatAt?: number;
	exitCode?: number;
	error?: string;
	replayWarnings?: string[];
};

export function runStatusPath(runDir: string): string {
	return join(runDir, "status.json");
}

export function readRunStatus(runDir: string): HyperchartRunStatus | undefined {
	const path = runStatusPath(runDir);
	if (!existsSync(path)) return undefined;
	try {
		return normalizeStatus(JSON.parse(readFileSync(path, "utf8")) as unknown, runDir);
	} catch {
		return undefined;
	}
}

export function writeRunStatus(runDir: string, status: HyperchartRunStatus): void {
	const path = runStatusPath(runDir);
	const temp = join(dirname(path), `.status.${process.pid}.${Date.now()}.tmp`);
	writeFileSync(temp, `${JSON.stringify(status, null, 2)}\n`, "utf8");
	renameSync(temp, path);
}

type RunStatusPatch = {
	[K in keyof Omit<HyperchartRunStatus, "version" | "runDir" | "startedAt">]?:
		| Omit<HyperchartRunStatus, "version" | "runDir" | "startedAt">[K]
		| undefined;
};

export function patchRunStatus(runDir: string, patch: RunStatusPatch): HyperchartRunStatus {
	const now = Date.now();
	const previous = readRunStatus(runDir);
	const pid = valueFor("pid", patch, previous);
	const heartbeatAt = valueFor("heartbeatAt", patch, previous);
	const exitCode = valueFor("exitCode", patch, previous);
	const error = valueFor("error", patch, previous);
	const replayWarnings = valueFor("replayWarnings", patch, previous);
	const next: HyperchartRunStatus = {
		version: 1,
		runId: valueFor("runId", patch, previous) ?? "unknown",
		runDir,
		chartId: valueFor("chartId", patch, previous) ?? "unknown",
		state: valueFor("state", patch, previous) ?? "starting",
		startedAt: previous?.startedAt ?? now,
		updatedAt: now,
		...(pid === undefined ? {} : { pid }),
		...(heartbeatAt === undefined ? {} : { heartbeatAt }),
		...(exitCode === undefined ? {} : { exitCode }),
		...(error === undefined ? {} : { error }),
		...(replayWarnings === undefined ? {} : { replayWarnings }),
	};
	writeRunStatus(runDir, next);
	return next;
}

export function markRunHeartbeat(runDir: string): HyperchartRunStatus {
	return patchRunStatus(runDir, { state: "running", pid: process.pid, heartbeatAt: Date.now() });
}

export function isTerminalRunState(state: HyperchartRunState): boolean {
	return state === "complete" || state === "failed" || state === "stopped";
}

export function isRunLive(status: HyperchartRunStatus | undefined, now = Date.now()): boolean {
	if (status === undefined || isTerminalRunState(status.state) || status.state === "stopping") return false;
	if (status.pid !== undefined && isPidAlive(status.pid)) return true;
	return status.heartbeatAt !== undefined && now - status.heartbeatAt < 15_000;
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function valueFor<K extends keyof RunStatusPatch>(
	key: K,
	patch: RunStatusPatch,
	previous: HyperchartRunStatus | undefined,
): HyperchartRunStatus[K] | undefined {
	return Object.hasOwn(patch, key) ? patch[key] : previous?.[key];
}

function normalizeStatus(value: unknown, fallbackRunDir: string): HyperchartRunStatus | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.runId !== "string" || typeof value.chartId !== "string") return undefined;
	const state = normalizeState(value.state);
	if (state === undefined) return undefined;
	return {
		version: 1,
		runId: value.runId,
		runDir: typeof value.runDir === "string" ? value.runDir : fallbackRunDir,
		chartId: value.chartId,
		state,
		startedAt: typeof value.startedAt === "number" ? value.startedAt : 0,
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
		...(typeof value.pid === "number" ? { pid: value.pid } : {}),
		...(typeof value.heartbeatAt === "number" ? { heartbeatAt: value.heartbeatAt } : {}),
		...(typeof value.exitCode === "number" ? { exitCode: value.exitCode } : {}),
		...(typeof value.error === "string" ? { error: value.error } : {}),
		...(Array.isArray(value.replayWarnings) && value.replayWarnings.every((entry) => typeof entry === "string")
			? { replayWarnings: value.replayWarnings }
			: {}),
	};
}

function normalizeState(value: unknown): HyperchartRunState | undefined {
	return value === "starting" ||
		value === "running" ||
		value === "complete" ||
		value === "failed" ||
		value === "stopping" ||
		value === "stopped"
		? value
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
