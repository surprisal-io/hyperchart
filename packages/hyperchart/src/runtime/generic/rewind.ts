import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { actionUidDirName, actionUidKey, sanitizeSegment } from "../../core/action_uid.js";
import type { DurableLogRecord } from "../../core/durable_events.js";
import type { ActionUID } from "../../core/types.js";
import { parseChartModuleSync } from "../../core/inspect.js";
import { instancePathFor, nearestInstance, nodeAt, stripLastKey, templatePath } from "../../core/paths.js";
import { createBranchProjection, projectBranch, type BranchProjection } from "../../core/projection.js";
import { explainReplay } from "../../core/replay_check.js";
import type { ChartAst, InputRef, StatePath, TemplateAst } from "../../core/types.js";
import { loadRunMeta } from "./run_dir.js";
import { isRunLive, patchRunStatus, readRunStatus } from "./run_status.js";
import { readSessionProgress, sessionProgressPath } from "./session_progress.js";

export type RewindMode = "before" | "after";

export type RewindOptions = {
	runDir: string;
	state?: string;
	seqId?: number;
	to?: "compatible";
	mode: RewindMode;
	cleanupSessions: boolean;
	cleanupArtifacts: boolean;
	/** Working directory the run must belong to; rewinding a foreign run is refused. */
	cwd: string;
};

export type RewindResult = {
	runId: string;
	runDir: string;
	chartId: string;
	targetLabel: string;
	backupDir: string;
	keptRecords: number;
	removedRecords: number;
	removedByState: Array<{ state: string; records: number }>;
	cutSeqId?: number;
	cleanup: { sessionsRemoved: number; artifactFilesRemoved: number; artifactWarnings: string[] };
};

/**
 * Back up and truncate a stopped run's durable log so replay can continue from
 * an earlier point. The removed suffix (log tail, downstream session dirs, and
 * optionally artifact files) is moved into `<runDir>/rewind-backups/`.
 */
export async function rewindHyperchartRun(opts: RewindOptions): Promise<RewindResult> {
	const targetCount = [opts.state, opts.seqId, opts.to].filter((target) => target !== undefined).length;
	if (targetCount !== 1) {
		throw new Error("rewind requires exactly one of state, seqId, or to=compatible");
	}
	const status = readRunStatus(opts.runDir);
	if (isRunLive(status)) throw new Error(`Run '${basename(opts.runDir)}' is live; stop it before rewinding`);
	const meta = loadRunMeta(opts.runDir);
	if (resolve(meta.workDir) !== resolve(opts.cwd)) {
		throw new Error(`Run '${basename(opts.runDir)}' belongs to ${meta.workDir}; open that directory first`);
	}
	const parsed = parseChartModuleSync(meta.chartPath, meta.exportName === undefined ? {} : { exportName: meta.exportName });
	if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	const logPath = resolve(opts.runDir, "log.jsonl");
	const records = readDurableLogSync(logPath);
	const match = findRewindMatch(records, opts, parsed.ast);
	const cutMode = opts.to === "compatible" ? "before" : opts.mode;
	const cutIndex = cutMode === "before" ? match.index : match.index + 1;
	const kept = records.slice(0, cutIndex);
	const removed = records.slice(cutIndex);
	if (removed.length === 0) throw new Error("Rewind would remove zero records; choose an earlier target or mode=before");

	const backupDir = resolve(
		opts.runDir,
		"rewind-backups",
		`${new Date().toISOString().replace(/[:.]/g, "-")}-${safeBackupLabel(match.label)}`,
	);
	mkdirSync(backupDir, { recursive: true });
	backupIfExists(logPath, backupDir, "log.jsonl");
	backupIfExists(resolve(opts.runDir, "status.json"), backupDir, "status.json");
	backupIfExists(sessionProgressPath(resolve(opts.runDir, "sessions")), backupDir, "sessions-progress.json");
	const terminalNotificationsDir = resolve(opts.runDir, "terminal-notification");
	if (existsSync(terminalNotificationsDir)) renameSync(terminalNotificationsDir, resolve(backupDir, "terminal-notification"));
	// Interaction seqIds can be reused after truncation. Isolate the whole old mailbox so
	// replay cannot consume a pre-rewind answer, close marker, or presentation receipt.
	const userInteractionsDir = resolve(opts.runDir, "user-interactions");
	if (existsSync(userInteractionsDir)) renameSync(userInteractionsDir, resolve(backupDir, "user-interactions"));

	const artifactCleanup = opts.cleanupArtifacts
		? cleanupDownstreamArtifacts({ ast: parsed.ast, records, cutIndex, workDir: meta.workDir, backupDir })
		: { removed: 0, warnings: [] as string[] };
	const sessionsRemoved = opts.cleanupSessions
		? cleanupDownstreamSessions(opts.runDir, kept, removed, backupDir)
		: 0;

	writeDurableLogSync(logPath, kept);
	patchRunStatus(opts.runDir, {
		runId: basename(opts.runDir),
		chartId: parsed.ast.id,
		state: "stopped",
		pid: undefined,
		heartbeatAt: undefined,
		exitCode: 0,
		error: undefined,
	});

	return {
		runId: basename(opts.runDir),
		runDir: opts.runDir,
		chartId: parsed.ast.id,
		targetLabel: match.label,
		backupDir,
		keptRecords: kept.length,
		removedRecords: removed.length,
		removedByState: summarizeRemovedRecordsByState(removed),
		...(match.recordSeqId === undefined ? {} : { cutSeqId: match.recordSeqId }),
		cleanup: {
			sessionsRemoved,
			artifactFilesRemoved: artifactCleanup.removed,
			artifactWarnings: artifactCleanup.warnings,
		},
	};
}

function findRewindMatch(
	records: readonly DurableLogRecord[],
	opts: RewindOptions,
	ast: ChartAst,
): { index: number; label: string; recordSeqId?: number } {
	if (opts.to === "compatible") {
		const explanation = explainReplay(ast, records);
		const broken = explanation.broken;
		if (broken === undefined) {
			const warnings = explanation.skipped.length + explanation.stale.length;
			throw new Error(
				warnings === 0
					? "Durable log is already compatible with the current chart; no rewind needed"
					: `Durable log has no structural incompatibility (${warnings} warning record(s)); choose state or seqId if you still want to rewind`,
			);
		}
		const targetSeqId = broken.record.type === "state_action" ? (broken.invokeSeqId ?? broken.seqId) : broken.seqId;
		const index = records.findIndex((record) => record.seqId === targetSeqId);
		if (index === -1) throw new Error(`Cannot find compatible cut record seqId ${targetSeqId}`);
		return { index, label: `compatible before seqId ${targetSeqId}`, recordSeqId: targetSeqId };
	}
	if (opts.seqId !== undefined) {
		const index = records.findIndex((record) => record.seqId === opts.seqId);
		if (index === -1) throw new Error(`No durable log record with seqId ${opts.seqId}`);
		return { index, label: `${opts.mode} seqId ${opts.seqId}`, recordSeqId: opts.seqId };
	}
	const state = opts.state ?? "";
	const index = records.findIndex((record) => recordMatchesState(record, state));
	if (index === -1) throw new Error(`No durable log record matched state '${state}'`);
	const recordSeqId = records[index]?.seqId;
	return { index, label: `${opts.mode} state ${state}`, ...(recordSeqId === undefined ? {} : { recordSeqId }) };
}

function summarizeRemovedRecordsByState(records: readonly DurableLogRecord[]): Array<{ state: string; records: number }> {
	const counts = new Map<string, number>();
	for (const record of records) {
		const state = record.type === "spawned" ? record.path : record.type === "state_action" ? record.actionUid.state : "<run>";
		counts.set(state, (counts.get(state) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([state, count]) => ({ state, records: count }))
		.sort((left, right) => right.records - left.records || left.state.localeCompare(right.state));
}

function recordMatchesState(record: DurableLogRecord, state: string): boolean {
	if (record.type === "spawned") return record.path === state || templatePath(record.path) === state || isUnderState(record.path, state);
	if (record.type !== "state_action") return false;
	return record.actionUid.state === state || templatePath(record.actionUid.state) === state || isUnderState(record.actionUid.state, state);
}

function isUnderState(path: string, state: string): boolean {
	return path === state || path.startsWith(`${state}.`) || path.startsWith(`${state}#`) || templatePath(path).startsWith(`${state}.`);
}

export function readDurableLogSync(logPath: string): DurableLogRecord[] {
	if (!existsSync(logPath)) return [];
	return readFileSync(logPath, "utf8")
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as DurableLogRecord);
}

export function writeDurableLogSync(logPath: string, records: readonly DurableLogRecord[]): void {
	writeFileSync(logPath, records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function backupIfExists(path: string, backupDir: string, name: string): void {
	if (!existsSync(path)) return;
	copyFileSync(path, resolve(backupDir, name));
}

function cleanupDownstreamSessions(
	runDir: string,
	kept: readonly DurableLogRecord[],
	removed: readonly DurableLogRecord[],
	backupDir: string,
): number {
	const sessionsDir = resolve(runDir, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	const progress = readSessionProgress(sessionsDir);
	const retainedVisits = invocationCounts(kept);
	const removedVisits = removedInvocationVisits(removed, retainedVisits);
	const sharedTranscriptCutoffs = new Map<string, number>();
	let removedEntries = 0;
	for (const [progressKey, session] of Object.entries(progress.sessions)) {
		const actionKey = session.actionKey ?? actionUidKey(session.actionUid);
		const visits = removedVisits.get(actionKey);
		if (visits === undefined) continue;
		const visit = session.visit ?? Math.max(...visits.keys());
		const cutoff = session.visit === undefined ? Math.min(...visits.values()) : visits.get(visit);
		if (cutoff === undefined) continue;
		const sessionFile = session.sessionFile === undefined
			? undefined
			: containedSessionFile(sessionsDir, session.sessionFile);
		if (sessionFile !== undefined) {
			const removedVisitDir = resolve(
				sessionsDir,
				actionUidDirName(session.actionUid),
				sanitizeSegment(`${actionKey}:${visit}`),
			);
			if (!isWithin(removedVisitDir, sessionFile)) {
				const previousCutoff = sharedTranscriptCutoffs.get(sessionFile);
				sharedTranscriptCutoffs.set(sessionFile, previousCutoff === undefined ? cutoff : Math.min(previousCutoff, cutoff));
			}
		}
		delete progress.sessions[progressKey];
		removedEntries++;
	}
	progress.updatedAt = Date.now();
	writeFileSync(sessionProgressPath(sessionsDir), `${JSON.stringify(progress, null, 2)}\n`, "utf8");
	const backupSessionsDir = resolve(backupDir, "sessions");
	for (const [sessionFile, cutoff] of sharedTranscriptCutoffs) {
		truncateSharedTranscript(sessionFile, cutoff, sessionsDir, backupSessionsDir);
	}
	for (const [actionKey, visits] of removedVisits) {
		const actionUid = actionUidForKey(removed, actionKey);
		if (actionUid === undefined) continue;
		const actionDir = resolve(sessionsDir, actionUidDirName(actionUid));
		if (!existsSync(actionDir)) continue;
		for (const visit of visits.keys()) {
			const visitDir = resolve(actionDir, sanitizeSegment(`${actionKey}:${visit}`));
			if (!existsSync(visitDir)) continue;
			const backupActionDir = resolve(backupSessionsDir, basename(actionDir));
			mkdirSync(backupActionDir, { recursive: true });
			movePath(visitDir, resolve(backupActionDir, basename(visitDir)));
		}
	}
	return removedEntries;
}

function invocationCounts(records: readonly DurableLogRecord[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const record of records) {
		if (record.type !== "state_action" || record.kind !== "invoke") continue;
		const key = actionUidKey(record.actionUid);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

function removedInvocationVisits(
	removed: readonly DurableLogRecord[],
	retainedVisits: ReadonlyMap<string, number>,
): Map<string, Map<number, number>> {
	const counts = new Map(retainedVisits);
	const visits = new Map<string, Map<number, number>>();
	for (const record of removed) {
		if (record.type !== "state_action" || record.kind !== "invoke") continue;
		const key = actionUidKey(record.actionUid);
		const visit = (counts.get(key) ?? 0) + 1;
		counts.set(key, visit);
		const removedForAction = visits.get(key) ?? new Map<number, number>();
		removedForAction.set(visit, record.timestamp);
		visits.set(key, removedForAction);
	}
	return visits;
}

function actionUidForKey(records: readonly DurableLogRecord[], key: string): ActionUID | undefined {
	for (const record of records) {
		if (record.type === "state_action" && actionUidKey(record.actionUid) === key) return record.actionUid;
	}
	return undefined;
}

function containedSessionFile(sessionsDir: string, sessionFile: string): string | undefined {
	try {
		const root = realpathSync(sessionsDir);
		const file = realpathSync(sessionFile);
		return isWithin(root, file) ? file : undefined;
	} catch {
		return undefined;
	}
}

function isWithin(root: string, path: string): boolean {
	const fromRoot = relative(resolve(root), resolve(path));
	return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function truncateSharedTranscript(
	sessionFile: string,
	cutoff: number,
	sessionsDir: string,
	backupSessionsDir: string,
): void {
	const lines = readFileSync(sessionFile, "utf8").split(/\r?\n/);
	const kept: string[] = [];
	let reachedCutoff = false;
	for (const line of lines) {
		if (line.length === 0) continue;
		const timestamp = transcriptRecordTimestamp(line);
		if (timestamp !== undefined && timestamp >= cutoff) reachedCutoff = true;
		if (!reachedCutoff) kept.push(line);
	}
	if (!reachedCutoff) return;
	const backupPath = resolve(backupSessionsDir, relative(realpathSync(sessionsDir), resolve(sessionFile)));
	mkdirSync(dirname(backupPath), { recursive: true });
	copyFileSync(sessionFile, backupPath);
	writeFileSync(sessionFile, kept.length === 0 ? "" : `${kept.join("\n")}\n`, "utf8");
}

function transcriptRecordTimestamp(line: string): number | undefined {
	let record: unknown;
	try {
		record = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(record) || record.hyperchartTranscript === 1 || record.type === "session") return undefined;
	const nested = isRecord(record.message) ? record.message.timestamp : undefined;
	return timestampValue(record.timestamp) ?? timestampValue(nested);
}

function timestampValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanupDownstreamArtifacts(opts: {
	ast: ChartAst;
	records: readonly DurableLogRecord[];
	cutIndex: number;
	workDir: string;
	backupDir: string;
}): { removed: number; warnings: string[] } {
	const collected = collectDownstreamArtifactPaths(opts.ast, opts.records, opts.cutIndex, opts.workDir);
	const warnings = [...collected.warnings];
	let removed = 0;
	let index = 0;
	const backupArtifactsDir = resolve(opts.backupDir, "artifacts");
	for (const path of collected.paths) {
		if (!existsSync(path)) continue;
		const stat = statSync(path);
		if (!stat.isFile()) {
			warnings.push(`Skipped non-file artifact ${path}`);
			continue;
		}
		mkdirSync(backupArtifactsDir, { recursive: true });
		const backupPath = resolve(backupArtifactsDir, `${String(index++).padStart(4, "0")}-${basename(path)}`);
		copyFileSync(path, backupPath);
		rmSync(path, { force: true });
		removed++;
	}
	return { removed, warnings };
}

function collectDownstreamArtifactPaths(
	ast: ChartAst,
	records: readonly DurableLogRecord[],
	cutIndex: number,
	workDir: string,
): { paths: string[]; warnings: string[] } {
	const paths = new Set<string>();
	const warnings: string[] = [];
	for (let index = cutIndex; index < records.length; index++) {
		const record = records[index];
		if (record?.type !== "state_action" || record.kind !== "invoke") continue;
		try {
			const projection = projectBranch(createBranchProjection(ast), ast, records.slice(0, index + 1));
			const node = nodeAt(ast, record.actionUid.state);
			if (node?.kind !== "state") continue;
			const action = node.action;
			if (action.kind === "user" || action.artifacts === undefined) continue;
			for (const artifact of Object.values(action.artifacts)) {
				const rendered = renderTemplateForProjection(projection, ast, artifact.path, record.actionUid.state);
				paths.add(resolveArtifactPath(workDir, rendered));
			}
		} catch (error) {
			warnings.push(error instanceof Error ? error.message : String(error));
		}
	}
	return { paths: [...paths], warnings };
}

function renderTemplateForProjection(
	projection: BranchProjection,
	ast: ChartAst,
	template: TemplateAst,
	stateId: StatePath,
): string {
	let out = "";
	for (let index = 0; index < template.strings.length; index++) {
		out += template.strings[index] ?? "";
		const ref = template.refs[index];
		if (ref === undefined) continue;
		const value = resolveRefForProjection(projection, ast, ref, stateId);
		out += typeof value === "string" ? value : JSON.stringify(value);
	}
	return out;
}

function resolveRefForProjection(projection: BranchProjection, ast: ChartAst, ref: InputRef, stateId: StatePath): unknown {
	if (ref.kind === "arg") return projection.args?.[ref.name];
	if (ref.kind === "visit") {
		const target = ref.state === undefined ? stateId : instancePathFor(ref.state, stateId);
		const node = nodeAt(ast, target);
		if (node?.kind !== "state") throw new Error(`Cannot resolve visit(${ref.state ?? ""}) for ${stateId}`);
		return projection.stateVisits[actionUidKey({ ...node.action.uid, state: target })];
	}
	if (ref.kind === "input") {
		const slot = inputSlotForProjection(projection, ast, ref.name, stateId);
		return selectPathForProjection(slot?.values[ref.name], ref.path);
	}
	if (ref.kind === "key" || ref.kind === "item") {
		const instance = nearestInstance(stateId, ref.map);
		if (instance === undefined) throw new Error(`Cannot resolve map ref for ${stateId}`);
		const instances = projection.spawns[instance.container];
		if (instances === undefined || !(instance.key in instances)) throw new Error(`No spawned instance ${instance.key} in ${instance.container}`);
		return ref.kind === "key" ? instance.key : selectPathForProjection(instances[instance.key], ref.path);
	}
	const resultKey = instancePathFor(ref.state, stateId);
	return selectPathForProjection(projection.results[resultKey], ref.path);
}

function inputSlotForProjection(
	projection: BranchProjection,
	ast: ChartAst,
	name: string,
	stateId: StatePath,
): { values: Record<string, unknown> } | undefined {
	let current: StatePath | undefined = stateId;
	while (current !== undefined) {
		const node = nodeAt(ast, current);
		if ((node?.kind === "state" || node?.kind === "map") && node.input !== undefined && name in node.input) {
			return { values: projection.inputs[node.kind === "map" ? stripLastKey(current) : current] ?? {} };
		}
		const dot = current.lastIndexOf(".");
		current = dot === -1 ? undefined : current.slice(0, dot);
	}
	return undefined;
}

function selectPathForProjection(value: unknown, path: string | undefined): unknown {
	if (path === undefined) return value;
	let current = value;
	for (const segment of path.split(".")) {
		if (typeof current !== "object" || current === null || !(segment in current)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function resolveArtifactPath(workDir: string, path: string): string {
	return isAbsolute(path) ? path : resolve(workDir, path);
}

function movePath(from: string, to: string): void {
	let target = to;
	let suffix = 1;
	while (existsSync(target)) {
		target = `${to}.${suffix++}`;
	}
	mkdirSync(dirname(target), { recursive: true });
	renameSync(from, target);
}

function safeBackupLabel(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
}
