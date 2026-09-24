import type { AgentEffect } from "../../core/machine.js";

const NON_RETRYABLE_LIMIT = /insufficient_quota|insufficient balance|quota exceeded|out of budget|billing/i;
const TRANSIENT_CAPACITY =
	/in_flight_budget_exhausted|rate.?limit|too many requests|overloaded|service.?unavailable|(?:^|\D)(?:408|429|502|503|504)(?:\D|$)/i;
const RETRY_AFTER = /["']?retry-after["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/i;

/** A provider error is retryable only when it identifies transient capacity, not exhausted quota. */
export function isTransientProviderFailure(message: string): boolean {
	return !NON_RETRYABLE_LIMIT.test(message) && TRANSIENT_CAPACITY.test(message);
}

/** Recompute a durable agent recovery's delay after restart; no in-memory attempt counter is needed. */
export function agentRetryDelayMs(effect: AgentEffect, random = Math.random): number {
	const recovery = effect.recovery;
	if (
		recovery?.scope !== "general" ||
		(recovery.failure.kind !== "provider" && recovery.failure.kind !== "runtime") ||
		!isTransientProviderFailure(recovery.failure.message)
	) {
		return 0;
	}
	const attempt = recovery.nudgeAttempt + recovery.restartAttempt * (effect.action.onFail.nudge + 1);
	const exponential = Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 240_000);
	const retryAfter = RETRY_AFTER.exec(recovery.failure.message);
	const requested = retryAfter === null ? 0 : Number(retryAfter[1]) * 1000;
	const serverDelay = Number.isFinite(requested) && requested > 0 ? requested : 0;
	return Math.min(2_147_483_647, Math.max(exponential, serverDelay) + random() * Math.min(exponential, 30_000));
}
