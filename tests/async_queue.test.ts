import { describe, expect, it } from "vitest";
import { createAsyncQueue } from "../packages/hyperchart/src/index.js";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const values: T[] = [];
	for await (const value of iterable) {
		values.push(value);
	}
	return values;
}

describe("AsyncQueue", () => {
	it("buffers sends before iteration starts", async () => {
		const queue = createAsyncQueue<number>();
		queue.send(1);
		queue.send(2);
		expect(queue.size).toBe(2);
		queue.close();

		await expect(collect(queue)).resolves.toEqual([1, 2]);
		expect(queue.size).toBe(0);
	});

	it("delivers sends to a pending iterator", async () => {
		const queue = createAsyncQueue<string>();
		const iterator = queue[Symbol.asyncIterator]();
		const next = iterator.next();

		queue.send("ready");

		await expect(next).resolves.toEqual({ done: false, value: "ready" });
		queue.close();
		await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
	});

	it("drains buffered values after close before ending", async () => {
		const queue = createAsyncQueue<string>();
		queue.send("first");
		queue.send("second");
		queue.close();
		const iterator = queue[Symbol.asyncIterator]();

		await expect(iterator.next()).resolves.toEqual({ done: false, value: "first" });
		await expect(iterator.next()).resolves.toEqual({ done: false, value: "second" });
		await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
	});

	it("throws when sending after close", () => {
		const queue = createAsyncQueue<number>();
		queue.close();

		expect(() => queue.send(1)).toThrow("closed AsyncQueue");
	});

	it("preserves explicit undefined values", async () => {
		const queue = createAsyncQueue<undefined>();
		queue.send(undefined);
		queue.close();

		await expect(collect(queue)).resolves.toEqual([undefined]);
	});
});
