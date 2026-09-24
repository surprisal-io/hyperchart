import { describe, expect, it } from "vitest";
import type { AgentEffect } from "../packages/hyperchart/src/core/machine.js";
import {
	agentRetryDelayMs,
	isTransientProviderFailure,
} from "../packages/hyperchart/src/runtime/generic/agent_retry_backoff.js";

const uid = { chart: "chart", state: "work", action: "worker" };
const capacityError =
	'402: {"message":"This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.","code":402,"metadata":{"reason":"in_flight_budget_exhausted","headers":{"Retry-After":"120"}}}';

function effect(nudgeAttempt: number, restartAttempt = 0, message = capacityError): AgentEffect {
	return {
		kind: "agent",
		id: "retry",
		actionUid: uid,
		action: { kind: "agent", uid, name: "worker", onFail: { nudge: 2, restart: 1 } },
		sessionId: "session",
		events: ["DONE"],
		recovery: {
			mode: restartAttempt > 0 ? "restart" : "nudge",
			scope: "general",
			nudgeAttempt,
			restartAttempt,
			failure: { kind: "provider", message },
		},
	};
}

describe("generic agent provider recovery", () => {
	it("retries transient capacity, not exhausted quota or unknown payment errors", () => {
		expect(isTransientProviderFailure(capacityError)).toBe(true);
		expect(isTransientProviderFailure("HTTP 429: Too many requests")).toBe(true);
		expect(isTransientProviderFailure("HTTP 503: Service unavailable")).toBe(true);
		expect(isTransientProviderFailure("HTTP 402: Insufficient Balance")).toBe(false);
		expect(isTransientProviderFailure("HTTP 429: insufficient_quota")).toBe(false);
		expect(isTransientProviderFailure("HTTP 500: unrecognized error")).toBe(false);
	});

	it("uses exponential backoff, Retry-After floor, and restart attempt count", () => {
		expect(agentRetryDelayMs(effect(1, 0, "HTTP 429"), () => 0)).toBe(30_000);
		expect(agentRetryDelayMs(effect(2, 0, "HTTP 429"), () => 0)).toBe(60_000);
		expect(agentRetryDelayMs(effect(0, 1, "HTTP 429"), () => 0)).toBe(120_000);
		expect(agentRetryDelayMs(effect(1), () => 0)).toBe(120_000);
		expect(agentRetryDelayMs(effect(1), () => 1)).toBe(150_000);
		const { recovery, ...initial } = effect(1);
		expect(recovery).toBeDefined();
		expect(agentRetryDelayMs(initial, () => 0)).toBe(0);
	});
});
