import { describe, expect, it, vi } from "vitest";
import {
	HYPERCHART_COMMAND_EVENT,
	requestHyperchartCommand,
	type HyperchartCommandRequest,
} from "../packages/pi-hyperchart/src/command.js";

function eventBusWith(...listeners: Array<(request: HyperchartCommandRequest) => void>) {
	return {
		emit: vi.fn((event: string, request: HyperchartCommandRequest) => {
			if (event === HYPERCHART_COMMAND_EVENT) listeners.forEach((listener) => listener(request));
		}),
	};
}

describe("requestHyperchartCommand", () => {
	it("reports an unavailable extension when no listener claims the request", async () => {
		await expect(requestHyperchartCommand(eventBusWith(), "runs")).resolves.toBe(false);
	});

	it("awaits the first listener that claims the command", async () => {
		const run = vi.fn(async () => {});
		const ignored = vi.fn(async () => {});
		const bus = eventBusWith(
			(request) => request.claim(run),
			(request) => request.claim(ignored),
		);

		await expect(requestHyperchartCommand(bus, "run demo")).resolves.toBe(true);
		expect(run).toHaveBeenCalledOnce();
		expect(ignored).not.toHaveBeenCalled();
	});

	it("propagates errors from the claimed command", async () => {
		const bus = eventBusWith((request) => request.claim(async () => {
			throw new Error("boom");
		}));

		await expect(requestHyperchartCommand(bus, "run demo")).rejects.toThrow("boom");
	});
});
