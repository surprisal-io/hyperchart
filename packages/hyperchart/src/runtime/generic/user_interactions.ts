import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import type { SchemaRegistryLike } from "../../core/schema_registry.js";
import type { ActionUID, ChartEvent, SchemaAst } from "../../core/types.js";
import { checkSchemaAsync } from "./schema.js";
import { loadRunMeta } from "./run_dir.js";
import { isRunLive, readRunStatus } from "./run_status.js";

export const USER_INTERACTIONS_DIR = "user-interactions";
export const USER_INTERACTION_REQUEST = "request.json";
/** Response and close race for one immutable resolution fact. */
export const USER_INTERACTION_RESOLUTION = "resolution.json";
/** Compatibility aliases: both public readers address the same resolution fact. */
export const USER_INTERACTION_RESPONSE = USER_INTERACTION_RESOLUTION;
export const USER_INTERACTION_CLOSE = USER_INTERACTION_RESOLUTION;
/** Kept as the deterministic owner namespace; active selection is derived, not a mutable pointer. */
export const USER_INTERACTION_ARBITER_DIR = ".user-interaction-arbiter";
export const USER_INTERACTION_CLAIM_LEASE_MS = 30_000;
export const USER_INTERACTION_WAIT_LEASE_MS = 5 * 60_000;

export type UserInteractionCoordinate = Readonly<{ runId: string; seqId: number }>;

export type UserInteractionRequest = Readonly<{
	version: 1;
	runId: string;
	seqId: number;
	actionUid: ActionUID;
	prompt: string;
	options: readonly string[];
	events: readonly string[];
	reply?: SchemaAst;
	rejection?: Readonly<{
		attempt: number;
		onReject: "resume" | "restart";
		reason?: string;
	}>;
	createdAt: string;
}>;

export type UserInteractionResponse = Readonly<{
	version: 1;
	runId: string;
	seqId: number;
	event: ChartEvent;
	createdAt: string;
}>;

export type UserInteractionClose = Readonly<{
	version: 1;
	runId: string;
	seqId: number;
	reason: string;
	closedAt: string;
}>;

export type UserInteractionResolution =
	| Readonly<{
			version: 1;
			kind: "response";
			runId: string;
			seqId: number;
			event: ChartEvent;
			createdAt: string;
	  }>
	| Readonly<{
			version: 1;
			kind: "closed";
			runId: string;
			seqId: number;
			reason: string;
			closedAt: string;
	  }>;

export type UserInteractionReceipt = Readonly<{
	version: 1;
	runId: string;
	seqId: number;
	host: string;
	sessionId: string;
	state: "claimed" | "confirmed";
	/** Delivery path that owns an unconfirmed claim (for example monitor or wait). */
	source?: string;
	claimedAt?: string;
	leaseUntil?: string;
	deliveredAt?: string;
}>;

export type UserInteractionOwner = Readonly<{
	runsRoot: string;
	host: string;
	sessionId: string;
	workDir: string;
}>;

export type OwnedUserInteraction = Readonly<{
	runDir: string;
	request: UserInteractionRequest;
	presentation: "pending" | "claimed" | "confirmed";
	/** Filesystem publication order for an immutable claim/confirmation. */
	presentationOrder?: bigint;
}>;

/** Retained as a public diagnostic shape; active state is derived from live requests and receipts. */
export type UserInteractionArbiterRecord = Readonly<{
	version: 1;
	host: string;
	sessionId: string;
	workDir: string;
	runId: string;
	seqId: number;
	pinnedAt: string;
}>;

export type PersistUserInteractionRequestInput = Omit<UserInteractionRequest, "version" | "createdAt">;

export function userInteractionDir(runDir: string, seqId: number): string {
	assertSeqId(seqId);
	return join(runDir, USER_INTERACTIONS_DIR, String(seqId));
}

export function userInteractionRequestPath(runDir: string, seqId: number): string {
	return join(userInteractionDir(runDir, seqId), USER_INTERACTION_REQUEST);
}

export function userInteractionResolutionPath(runDir: string, seqId: number): string {
	return join(userInteractionDir(runDir, seqId), USER_INTERACTION_RESOLUTION);
}

export function userInteractionResponsePath(runDir: string, seqId: number): string {
	return userInteractionResolutionPath(runDir, seqId);
}

export function userInteractionClosePath(runDir: string, seqId: number): string {
	return userInteractionResolutionPath(runDir, seqId);
}

export function persistUserInteractionRequest(
	runDir: string,
	input: PersistUserInteractionRequestInput,
): UserInteractionRequest {
	assertRunCoordinate(runDir, input.runId, input.seqId);
	const existing = readUserInteractionRequest(runDir, input.seqId);
	if (existing !== undefined) {
		if (stableJson(requestComparable(existing)) !== stableJson(input)) {
			throw new Error(`User interaction request conflict for (${input.runId}, ${input.seqId})`);
		}
		return existing;
	}
	const request: UserInteractionRequest = {
		version: 1,
		...input,
		createdAt: new Date().toISOString(),
	};
	mkdirSync(userInteractionDir(runDir, input.seqId), { recursive: true });
	try {
		writeJsonExclusive(userInteractionRequestPath(runDir, input.seqId), request);
		return request;
	} catch (error) {
		if (!isNodeError(error) || error.code !== "EEXIST") throw error;
		const raced = readUserInteractionRequest(runDir, input.seqId);
		if (raced === undefined || stableJson(requestComparable(raced)) !== stableJson(input)) {
			throw new Error(`User interaction request conflict for (${input.runId}, ${input.seqId})`);
		}
		return raced;
	}
}

export function readUserInteractionRequest(runDir: string, seqId: number): UserInteractionRequest | undefined {
	const path = userInteractionRequestPath(runDir, seqId);
	if (!existsSync(path)) return undefined;
	const request = parseRequest(readJson(path), path);
	assertEmbeddedCoordinate(runDir, seqId, request, path);
	return request;
}

export function readUserInteractionResolution(runDir: string, seqId: number): UserInteractionResolution | undefined {
	const path = userInteractionResolutionPath(runDir, seqId);
	if (!existsSync(path)) return undefined;
	const resolution = parseResolution(readJson(path), path);
	assertEmbeddedCoordinate(runDir, seqId, resolution, path);
	return resolution;
}

export function readUserInteractionResponse(runDir: string, seqId: number): UserInteractionResponse | undefined {
	const resolution = readUserInteractionResolution(runDir, seqId);
	if (resolution?.kind !== "response") return undefined;
	const { kind: _kind, ...response } = resolution;
	return response;
}

export function readUserInteractionClose(runDir: string, seqId: number): UserInteractionClose | undefined {
	const resolution = readUserInteractionResolution(runDir, seqId);
	if (resolution?.kind !== "closed") return undefined;
	const { kind: _kind, ...close } = resolution;
	return close;
}

export function readOpenUserInteractionRequest(runDir: string, seqId: number): UserInteractionRequest | undefined {
	const request = readUserInteractionRequest(runDir, seqId);
	if (request === undefined || readUserInteractionResolution(runDir, seqId) !== undefined) return undefined;
	return request;
}

/** Strict per-run scan. Malformed entries are isolated and omitted from the result. */
export function scanOpenUserInteractions(runDir: string): UserInteractionRequest[] {
	const root = join(runDir, USER_INTERACTIONS_DIR);
	if (!existsSync(root)) return [];
	const requests: UserInteractionRequest[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		const seqId = Number(entry.name);
		if (!Number.isSafeInteger(seqId) || seqId <= 0) continue;
		try {
			const request = readOpenUserInteractionRequest(runDir, seqId);
			if (request !== undefined) requests.push(request);
		} catch {
			// One malformed or concurrently-created phase must not hide other gates.
		}
	}
	return requests.sort(compareCoordinates);
}

/**
 * Resolve a phase as machine-abandoned. If a response already won, close is a no-op.
 * Response and close publish the same immutable resolution path, so they cannot coexist.
 */
export function closeUserInteraction(
	runDir: string,
	coordinate: UserInteractionCoordinate,
	reason: string,
): UserInteractionClose | undefined {
	assertRunCoordinate(runDir, coordinate.runId, coordinate.seqId);
	const request = readUserInteractionRequest(runDir, coordinate.seqId);
	if (request === undefined) throw new Error(`No user interaction exists for (${coordinate.runId}, ${coordinate.seqId})`);
	const existing = readUserInteractionResolution(runDir, coordinate.seqId);
	if (existing?.kind === "closed") return closeFromResolution(existing);
	if (existing?.kind === "response") return undefined;
	const resolution: Extract<UserInteractionResolution, { kind: "closed" }> = {
		version: 1,
		kind: "closed",
		...coordinate,
		reason,
		closedAt: new Date().toISOString(),
	};
	try {
		writeJsonExclusive(userInteractionResolutionPath(runDir, coordinate.seqId), resolution);
		return closeFromResolution(resolution);
	} catch (error) {
		if (!isNodeError(error) || error.code !== "EEXIST") throw error;
		const raced = readUserInteractionResolution(runDir, coordinate.seqId);
		return raced?.kind === "closed" ? closeFromResolution(raced) : undefined;
	}
}

export function userInteractionReceiptPath(
	runDir: string,
	seqId: number,
	host: string,
	sessionId: string,
): string {
	const key = createHash("sha256").update(`${host}\0${sessionId}`).digest("hex");
	return join(userInteractionDir(runDir, seqId), "receipts", `${key}.claim.json`);
}

function userInteractionConfirmationPath(
	runDir: string,
	seqId: number,
	host: string,
	sessionId: string,
): string {
	return userInteractionReceiptPath(runDir, seqId, host, sessionId).replace(/\.claim\.json$/, ".confirmed.json");
}

export function hasUserInteractionReceipt(
	runDir: string,
	seqId: number,
	host: string,
	sessionId: string,
): boolean {
	const request = readUserInteractionRequest(runDir, seqId);
	if (request === undefined) return false;
	const receipt = readConfirmedReceipt(runDir, seqId, host, sessionId);
	return receipt !== undefined && sameReceiptCoordinate(receipt, request, host, sessionId);
}

/**
 * Acquire presentation for this exact gate. Initial acquisition is exclusive. An expired
 * unconfirmed claim may be redelivered without destructive takeover; duplicate delivery of the
 * same gate is allowed, while derived selection still prevents a different gate from advancing.
 */
export function claimUserInteractionReceipt(
	runDir: string,
	seqId: number,
	host: string,
	sessionId: string,
	options: { now?: number; leaseMs?: number; source?: string } = {},
): boolean {
	const request = readOpenUserInteractionRequest(runDir, seqId);
	if (request === undefined) return false;
	const confirmedPath = userInteractionConfirmationPath(runDir, seqId, host, sessionId);
	if (readConfirmedReceipt(runDir, seqId, host, sessionId) !== undefined) {
		writePublicationMarker(confirmedPath);
		return false;
	}
	const path = userInteractionReceiptPath(runDir, seqId, host, sessionId);
	const now = options.now ?? Date.now();
	const leaseMs = options.leaseMs ?? USER_INTERACTION_CLAIM_LEASE_MS;
	const existing = readReceipt(path);
	if (existing !== undefined) {
		if (!sameReceiptCoordinate(existing, request, host, sessionId)) return false;
		if (existing.state === "confirmed") return false; // Legacy single-file confirmation.
		const leaseUntil = existing.leaseUntil === undefined ? Number.NaN : Date.parse(existing.leaseUntil);
		const claimedAt = existing.claimedAt === undefined ? Number.NaN : Date.parse(existing.claimedAt);
		const expired = Number.isFinite(leaseUntil)
			? now >= leaseUntil
			: !Number.isFinite(claimedAt) || now - claimedAt >= leaseMs;
		if (!expired) return false;
		writePublicationMarker(path);
		return receiptPublicationOrder(path) !== undefined;
	}
	const claim: UserInteractionReceipt = {
		version: 1,
		runId: request.runId,
		seqId,
		host,
		sessionId,
		state: "claimed",
		...(options.source === undefined ? {} : { source: options.source }),
		claimedAt: new Date(now).toISOString(),
		leaseUntil: new Date(now + leaseMs).toISOString(),
	};
	mkdirSync(join(userInteractionDir(runDir, seqId), "receipts"), { recursive: true });
	try {
		writeJsonExclusive(path, claim);
		writePublicationMarker(path);
		return receiptPublicationOrder(path) !== undefined;
	} catch (error) {
		if (!isNodeError(error) || error.code !== "EEXIST") throw error;
		return false;
	}
}

export function markUserInteractionReceipt(
	runDir: string,
	seqId: number,
	host: string,
	sessionId: string,
): UserInteractionReceipt {
	const request = readOpenUserInteractionRequest(runDir, seqId);
	if (request === undefined) throw new Error(`No open user interaction exists for ${runDir} seqId ${seqId}`);
	const existing = readConfirmedReceipt(runDir, seqId, host, sessionId);
	if (existing !== undefined) {
		if (!sameReceiptCoordinate(existing, request, host, sessionId)) {
			throw new Error(`Presentation receipt does not match user interaction (${request.runId}, ${seqId})`);
		}
		writePublicationMarker(userInteractionConfirmationPath(runDir, seqId, host, sessionId));
		return existing;
	}
	const receipt: UserInteractionReceipt = {
		version: 1,
		runId: request.runId,
		seqId,
		host,
		sessionId,
		state: "confirmed",
		deliveredAt: new Date().toISOString(),
	};
	const path = userInteractionConfirmationPath(runDir, seqId, host, sessionId);
	mkdirSync(join(userInteractionDir(runDir, seqId), "receipts"), { recursive: true });
	try {
		writeJsonExclusive(path, receipt);
		writePublicationMarker(path);
		return receipt;
	} catch (error) {
		if (!isNodeError(error) || error.code !== "EEXIST") throw error;
		return readConfirmedReceipt(runDir, seqId, host, sessionId) ?? receipt;
	}
}

export function readUserInteractionReceipt(
	runDir: string,
	seqId: number,
	host: string,
	sessionId: string,
): UserInteractionReceipt | undefined {
	return readConfirmedReceipt(runDir, seqId, host, sessionId) ??
		readReceipt(userInteractionReceiptPath(runDir, seqId, host, sessionId));
}

export function removeUserInteractionReceipt(
	runDir: string,
	seqId: number,
	host: string,
	sessionId: string,
): void {
	const claimPath = userInteractionReceiptPath(runDir, seqId, host, sessionId);
	const confirmationPath = userInteractionConfirmationPath(runDir, seqId, host, sessionId);
	rmSync(claimPath, { force: true });
	rmSync(`${claimPath}.published`, { force: true });
	rmSync(confirmationPath, { force: true });
	rmSync(`${confirmationPath}.published`, { force: true });
}

/** Deterministic diagnostic path only; active state is derived from requests and receipts. */
export function userInteractionArbiterPath(owner: UserInteractionOwner): string {
	const normalized = normalizeOwner(owner);
	const key = createHash("sha256")
		.update(`${normalized.host}\0${normalized.sessionId}\0${normalized.workDir}`)
		.digest("hex");
	return join(normalized.runsRoot, USER_INTERACTION_ARBITER_DIR, `${key}.json`);
}

/**
 * Return the one gate that may be presented for this host/session/cwd. Confirmed unanswered gates
 * remain pinned; then a live unexpired claim; otherwise strict lexical runId/numeric seqId order.
 * No mutable runs-root pointer exists, so concurrent callers derive the same candidate and race
 * only on that candidate's exclusive presentation claim.
 */
export function acquireActiveUserInteraction(ownerInput: UserInteractionOwner): OwnedUserInteraction | undefined {
	return selectActiveUserInteraction(scanOwnedOpenUserInteractions(ownerInput));
}

export function readActiveUserInteraction(ownerInput: UserInteractionOwner): OwnedUserInteraction | undefined {
	return selectActiveUserInteraction(scanOwnedOpenUserInteractions(ownerInput));
}

/** Resolution/close automatically releases derived active state; this helper only reports that. */
export function releaseActiveUserInteraction(
	ownerInput: UserInteractionOwner,
	coordinate: UserInteractionCoordinate,
): boolean {
	const active = readActiveUserInteraction(ownerInput);
	return active === undefined || active.request.runId !== coordinate.runId || active.request.seqId !== coordinate.seqId;
}

export function scanOwnedOpenUserInteractions(ownerInput: UserInteractionOwner): OwnedUserInteraction[] {
	const owner = normalizeOwner(ownerInput);
	if (!existsSync(owner.runsRoot)) return [];
	const pending: OwnedUserInteraction[] = [];
	for (const entry of readdirSync(owner.runsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === USER_INTERACTION_ARBITER_DIR) continue;
		const runDir = join(owner.runsRoot, entry.name);
		try {
			const meta = loadRunMeta(runDir);
			if (meta.originSessionId !== owner.sessionId || canonicalPath(meta.workDir) !== owner.workDir) continue;
			if (!isRunLive(readRunStatus(runDir))) continue;
			for (const request of scanOpenUserInteractions(runDir)) {
				if (request.runId !== entry.name) continue;
				const receipt = receiptState(runDir, request, owner.host, owner.sessionId);
				pending.push({
					runDir,
					request,
					presentation: receipt.presentation,
					...(receipt.order === undefined ? {} : { presentationOrder: receipt.order }),
				});
			}
		} catch {
			// Malformed, foreign, or concurrently-created runs are isolated.
		}
	}
	return pending.sort((left, right) => compareCoordinates(left.request, right.request));
}

export type PersistUserInteractionResponseOptions = Readonly<{
	runDir: string;
	runId: string;
	seqId: number;
	event: ChartEvent;
	schemaRegistry?: SchemaRegistryLike;
	owner?: UserInteractionOwner;
}>;

export async function validateAndPersistUserInteractionResponse(
	options: PersistUserInteractionResponseOptions,
): Promise<{ response: UserInteractionResponse; idempotent: boolean }> {
	assertRunCoordinate(options.runDir, options.runId, options.seqId);
	if (options.owner !== undefined) assertUserInteractionOwner(options.owner, options.runDir, options.runId);
	const existing = readUserInteractionResolution(options.runDir, options.seqId);
	if (existing?.kind === "response") {
		if (sameEvent(existing.event, options.event)) return { response: responseFromResolution(existing), idempotent: true };
		throw new Error(`Conflicting response for user interaction (${options.runId}, ${options.seqId})`);
	}
	if (existing?.kind === "closed") {
		throw new Error(`User interaction (${options.runId}, ${options.seqId}) is stale or closed`);
	}
	if (options.owner !== undefined) assertOwnedActiveCoordinate(options.owner, options.runDir, options);
	if (!isRunLive(readRunStatus(options.runDir))) throw new Error(`Run '${options.runId}' is not live`);
	const request = readOpenUserInteractionRequest(options.runDir, options.seqId);
	if (request === undefined || request.runId !== options.runId) {
		throw new Error(`User interaction (${options.runId}, ${options.seqId}) is stale, closed, or missing`);
	}

	// Validation may await an exact runtime contract. Recheck ownership/liveness after the await;
	// the exclusive resolution publish below then arbitrates a concurrent close/response.
	await validateUserInteractionEvent(request, options.event, options.schemaRegistry);
	if (options.owner !== undefined) assertOwnedActiveCoordinate(options.owner, options.runDir, options);
	if (!isRunLive(readRunStatus(options.runDir))) throw new Error(`Run '${options.runId}' is not live`);
	if (readOpenUserInteractionRequest(options.runDir, options.seqId) === undefined) {
		throw new Error(`User interaction (${options.runId}, ${options.seqId}) is stale, closed, or missing`);
	}
	const resolution: Extract<UserInteractionResolution, { kind: "response" }> = {
		version: 1,
		kind: "response",
		runId: options.runId,
		seqId: options.seqId,
		event: options.event,
		createdAt: new Date().toISOString(),
	};
	try {
		writeJsonExclusive(userInteractionResolutionPath(options.runDir, options.seqId), resolution);
		return { response: responseFromResolution(resolution), idempotent: false };
	} catch (error) {
		if (!isNodeError(error) || error.code !== "EEXIST") throw error;
		const raced = readUserInteractionResolution(options.runDir, options.seqId);
		if (raced?.kind === "response" && sameEvent(raced.event, options.event)) {
			return { response: responseFromResolution(raced), idempotent: true };
		}
		if (raced?.kind === "closed") {
			throw new Error(`User interaction (${options.runId}, ${options.seqId}) was closed before response commit`);
		}
		throw new Error(`Conflicting response for user interaction (${options.runId}, ${options.seqId})`);
	}
}

export async function validateUserInteractionEvent(
	request: UserInteractionRequest,
	event: ChartEvent,
	schemaRegistry?: SchemaRegistryLike,
): Promise<void> {
	validateUserEventShape(event);
	if (event.type === "FAILED") throw new Error("FAILED is reserved and cannot be returned by a user");
	if (!request.events.includes(event.type)) {
		throw new Error(`Event '${event.type}' is not allowed; expected one of ${request.events.filter((entry) => entry !== "FAILED").join(", ")}`);
	}
	if (request.reply !== undefined) {
		const check = await checkSchemaAsync(request.reply, "output" in event ? event.output : undefined, schemaRegistry);
		if (!check.ok) throw new Error(`User response output does not match reply schema: ${check.errors.join("; ")}`);
	}
}

function selectActiveUserInteraction(candidates: OwnedUserInteraction[]): OwnedUserInteraction | undefined {
	for (const presentation of ["confirmed", "claimed"] as const) {
		const presented = candidates
			.filter((candidate) => candidate.presentation === presentation)
			.sort(comparePresentationOrder);
		if (presented[0] !== undefined) return presented[0];
	}
	return candidates[0];
}

function comparePresentationOrder(left: OwnedUserInteraction, right: OwnedUserInteraction): number {
	if (left.presentationOrder !== undefined && right.presentationOrder !== undefined) {
		if (left.presentationOrder < right.presentationOrder) return -1;
		if (left.presentationOrder > right.presentationOrder) return 1;
	}
	return compareCoordinates(left.request, right.request);
}

function assertUserInteractionOwner(ownerInput: UserInteractionOwner, runDir: string, runId: string): void {
	const owner = normalizeOwner(ownerInput);
	if (canonicalPath(runDir) !== canonicalPath(join(owner.runsRoot, runId))) {
		throw new Error(`Run '${runId}' is outside the configured runs root`);
	}
	const meta = loadRunMeta(runDir);
	if (meta.originSessionId !== owner.sessionId) throw new Error(`Run '${runId}' is not owned by this session`);
	if (canonicalPath(meta.workDir) !== owner.workDir) throw new Error(`Run '${runId}' belongs to another working directory`);
}

function assertOwnedActiveCoordinate(
	ownerInput: UserInteractionOwner,
	runDir: string,
	coordinate: UserInteractionCoordinate,
): void {
	const owner = normalizeOwner(ownerInput);
	assertUserInteractionOwner(owner, runDir, coordinate.runId);
	const active = acquireActiveUserInteraction(owner);
	if (active === undefined || active.request.runId !== coordinate.runId || active.request.seqId !== coordinate.seqId) {
		throw new Error(`User interaction (${coordinate.runId}, ${coordinate.seqId}) is not the active gate`);
	}
}

function receiptState(
	runDir: string,
	request: UserInteractionRequest,
	host: string,
	sessionId: string,
): { presentation: OwnedUserInteraction["presentation"]; order?: bigint } {
	const confirmationPath = userInteractionConfirmationPath(runDir, request.seqId, host, sessionId);
	const confirmed = readConfirmedReceipt(runDir, request.seqId, host, sessionId);
	const confirmedOrder = receiptPublicationOrder(confirmationPath);
	if (confirmed !== undefined && confirmedOrder !== undefined && sameReceiptCoordinate(confirmed, request, host, sessionId)) {
		return { presentation: "confirmed", order: confirmedOrder };
	}
	const claimPath = userInteractionReceiptPath(runDir, request.seqId, host, sessionId);
	const claim = readReceipt(claimPath);
	// A claim pins this coordinate even after its delivery lease expires. Expiry permits
	// at-least-once redelivery of the SAME gate; it must never promote another branch's gate.
	const claimOrder = receiptPublicationOrder(claimPath);
	if (claim?.state === "claimed" && claimOrder !== undefined && sameReceiptCoordinate(claim, request, host, sessionId)) {
		return { presentation: "claimed", order: claimOrder };
	}
	return { presentation: "pending" };
}

function receiptPublicationOrder(path: string): bigint | undefined {
	try {
		// The marker is created directly after hard-link publication completes. Unlike the
		// receipt inode, it is never linked or unlinked again, so its ctime is a stable order
		// for completed immutable publications. Unmarked crash-window receipts stay pending
		// until claim recovery publishes their marker after the delivery lease.
		return statSync(`${path}.published`, { bigint: true }).ctimeNs;
	} catch {
		return undefined;
	}
}

function writePublicationMarker(path: string): void {
	try {
		writeFileSync(`${path}.published`, "", { flag: "wx" });
	} catch {
		// The receipt is already durable. Missing markers use the stable legacy/crash fallback.
	}
}

function readConfirmedReceipt(
	runDir: string,
	seqId: number,
	host: string,
	sessionId: string,
): UserInteractionReceipt | undefined {
	const confirmed = readReceipt(userInteractionConfirmationPath(runDir, seqId, host, sessionId));
	if (confirmed?.state === "confirmed") return confirmed;
	const legacy = readReceipt(userInteractionReceiptPath(runDir, seqId, host, sessionId));
	return legacy?.state === "confirmed" ? legacy : undefined;
}

function readReceipt(path: string): UserInteractionReceipt | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const value = readJson(path);
		if (!isRecord(value) || value.version !== 1) return undefined;
		if (
			typeof value.runId !== "string" ||
			!isPositiveInteger(value.seqId) ||
			typeof value.host !== "string" ||
			typeof value.sessionId !== "string" ||
			(value.state !== "claimed" && value.state !== "confirmed") ||
			(value.source !== undefined && typeof value.source !== "string") ||
			(value.leaseUntil !== undefined && typeof value.leaseUntil !== "string")
		) return undefined;
		return value as UserInteractionReceipt;
	} catch {
		return undefined;
	}
}

function sameReceiptCoordinate(
	receipt: UserInteractionReceipt,
	coordinate: UserInteractionCoordinate,
	host: string,
	sessionId: string,
): boolean {
	return receipt.runId === coordinate.runId &&
		receipt.seqId === coordinate.seqId &&
		receipt.host === host &&
		receipt.sessionId === sessionId;
}

function normalizeOwner(owner: UserInteractionOwner) {
	return {
		runsRoot: canonicalPath(owner.runsRoot),
		host: owner.host,
		sessionId: owner.sessionId,
		workDir: canonicalPath(owner.workDir),
	};
}

function canonicalPath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

function parseRequest(value: unknown, path: string): UserInteractionRequest {
	const allowed = new Set([
		"version", "runId", "seqId", "actionUid", "prompt", "options", "events", "reply", "rejection", "createdAt",
	]);
	if (!isRecord(value) || value.version !== 1 || hasUnexpectedKeys(value, allowed)) invalid(path);
	if (
		typeof value.runId !== "string" ||
		!isPositiveInteger(value.seqId) ||
		!isActionUid(value.actionUid) ||
		typeof value.prompt !== "string" ||
		!isStringArray(value.options) ||
		!isStringArray(value.events) ||
		typeof value.createdAt !== "string" ||
		(value.reply !== undefined && !isSchemaAst(value.reply)) ||
		(value.rejection !== undefined && !isRejection(value.rejection))
	) invalid(path);
	return value as UserInteractionRequest;
}

function parseResolution(value: unknown, path: string): UserInteractionResolution {
	if (!isRecord(value) || value.version !== 1 || (value.kind !== "response" && value.kind !== "closed")) invalid(path);
	if (value.kind === "response") {
		const allowed = new Set(["version", "kind", "runId", "seqId", "event", "createdAt"]);
		if (hasUnexpectedKeys(value, allowed)) invalid(path);
		if (
			typeof value.runId !== "string" ||
			!isPositiveInteger(value.seqId) ||
			!isChartEvent(value.event) ||
			typeof value.createdAt !== "string"
		) invalid(path);
		const event = value.event as Record<string, unknown>;
		if (event.type === "FAILED" || Object.keys(event).some((key) => key !== "type" && key !== "output")) invalid(path);
		return value as Extract<UserInteractionResolution, { kind: "response" }>;
	}
	const allowed = new Set(["version", "kind", "runId", "seqId", "reason", "closedAt"]);
	if (hasUnexpectedKeys(value, allowed)) invalid(path);
	if (
		typeof value.runId !== "string" ||
		!isPositiveInteger(value.seqId) ||
		typeof value.reason !== "string" ||
		typeof value.closedAt !== "string"
	) invalid(path);
	return value as Extract<UserInteractionResolution, { kind: "closed" }>;
}

function assertEmbeddedCoordinate(
	runDir: string,
	seqId: number,
	value: UserInteractionCoordinate,
	path: string,
): void {
	if (value.runId !== basename(resolve(runDir)) || value.seqId !== seqId) invalid(path);
}

function requestComparable(request: UserInteractionRequest): PersistUserInteractionRequestInput {
	const { version: _version, createdAt: _createdAt, ...comparable } = request;
	return comparable;
}

function responseFromResolution(
	resolution: Extract<UserInteractionResolution, { kind: "response" }>,
): UserInteractionResponse {
	const { kind: _kind, ...response } = resolution;
	return response;
}

function closeFromResolution(
	resolution: Extract<UserInteractionResolution, { kind: "closed" }>,
): UserInteractionClose {
	const { kind: _kind, ...close } = resolution;
	return close;
}

function validateUserEventShape(event: ChartEvent): void {
	if (!isChartEvent(event)) throw new Error("User response event must contain a string type");
	const keys = Object.keys(event);
	const allowed = event.type === "FAILED" ? new Set(["type", "error"]) : new Set(["type", "output"]);
	const unexpected = keys.filter((key) => !allowed.has(key));
	if (unexpected.length > 0) throw new Error(`Unexpected user response field(s): ${unexpected.join(", ")}`);
}

function assertRunCoordinate(runDir: string, runId: string, seqId: number): void {
	assertSeqId(seqId);
	if (basename(resolve(runDir)) !== runId) {
		throw new Error(`Run coordinate mismatch: expected '${basename(resolve(runDir))}', received '${runId}'`);
	}
}

function assertSeqId(seqId: number): void {
	if (!Number.isSafeInteger(seqId) || seqId <= 0) throw new Error(`Invalid user interaction seqId ${seqId}`);
}

function compareCoordinates(left: UserInteractionCoordinate, right: UserInteractionCoordinate): number {
	return left.runId.localeCompare(right.runId) || left.seqId - right.seqId;
}

/**
 * Publish a fully-written immutable fact without replacing an existing winner. The temp file is
 * created in the same directory, and a hard link is the only Node filesystem primitive that is
 * both atomic and no-clobber after the bytes are complete. Hyperchart therefore requires a local
 * filesystem that supports same-volume hard links for durable mailbox facts.
 */
function writeJsonExclusive(path: string, value: unknown): void {
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
	try {
		linkSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function sameEvent(left: ChartEvent, right: ChartEvent): boolean {
	return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function hasUnexpectedKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).some((key) => !allowed.has(key));
}

function isActionUid(value: unknown): value is ActionUID {
	return isRecord(value) &&
		typeof value.chart === "string" &&
		typeof value.state === "string" &&
		typeof value.action === "string" &&
		Object.keys(value).every((key) => key === "chart" || key === "state" || key === "action");
}

function isSchemaAst(value: unknown): value is SchemaAst {
	return isRecord(value) && value.kind === "jsonSchema" && isRecord(value.schema);
}

function isRejection(value: unknown): value is NonNullable<UserInteractionRequest["rejection"]> {
	return isRecord(value) &&
		isPositiveInteger(value.attempt) &&
		(value.onReject === "resume" || value.onReject === "restart") &&
		(value.reason === undefined || typeof value.reason === "string");
}

function isChartEvent(value: unknown): value is ChartEvent {
	return isRecord(value) && typeof value.type === "string";
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function invalid(path: string): never {
	throw new Error(`Invalid user interaction record: ${path}`);
}
