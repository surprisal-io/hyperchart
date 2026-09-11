import { describe, expect, it } from "vitest";
import { createAsyncGate, createAsyncMemo } from "../packages/pi-hyperchart/src/runtime/pi/async_gate.js";

describe("Pi host snapshot concurrency", () => {
	it("bounds shared concurrent operations across simultaneous callers", async () => {
		const gate = createAsyncGate(8);
		let active = 0;
		let peak = 0;
		const run = () =>
			gate(async () => {
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 10));
				active -= 1;
			});

		await Promise.all([Promise.all(Array.from({ length: 24 }, run)), Promise.all(Array.from({ length: 24 }, run))]);

		expect(peak).toBe(8);
	});

	it("hands a permit to the next waiter when an operation fails", async () => {
		const gate = createAsyncGate(1);
		const first = gate(async () => {
			throw new Error("failed");
		});
		const second = gate(async () => "completed");

		await expect(first).rejects.toThrow("failed");
		await expect(second).resolves.toBe("completed");
	});

	it("coalesces concurrent immutable metadata reads and caches success", async () => {
		let calls = 0;
		const load = createAsyncMemo(async (key: string) => {
			calls += 1;
			await new Promise((resolve) => setTimeout(resolve, 10));
			return `meta:${key}`;
		});

		await expect(Promise.all([load("run-1"), load("run-1"), load("run-1")])).resolves.toEqual([
			"meta:run-1",
			"meta:run-1",
			"meta:run-1",
		]);
		await expect(load("run-1")).resolves.toBe("meta:run-1");
		expect(calls).toBe(1);
	});

	it("evicts failed metadata reads so a later poll can retry", async () => {
		let calls = 0;
		const load = createAsyncMemo(async () => {
			calls += 1;
			if (calls === 1) throw new Error("not ready");
			return "ready";
		});

		await expect(load("run-1")).rejects.toThrow("not ready");
		await expect(load("run-1")).resolves.toBe("ready");
		expect(calls).toBe(2);
	});
});
