export type AsyncQueue<T> = AsyncIterable<T> & {
	send(value: T): void;
	close(): void;
	readonly size: number;
};

export function createAsyncQueue<T>(): AsyncQueue<T> {
	const buffer: T[] = [];
	let closed = false;
	let waiting: ((result: IteratorResult<T>) => void) | undefined;

	function next(): Promise<IteratorResult<T>> {
		if (buffer.length > 0) {
			return Promise.resolve({ done: false, value: buffer.shift() as T });
		}
		if (closed) {
			return Promise.resolve({ done: true, value: undefined });
		}
		if (waiting !== undefined) {
			return Promise.reject(new Error("AsyncQueue supports a single consumer with one pending read"));
		}
		return new Promise<IteratorResult<T>>((resolve) => {
			waiting = resolve;
		});
	}

	const queue: AsyncQueue<T> = {
		send(value: T): void {
			if (closed) {
				throw new Error("Cannot send to a closed AsyncQueue");
			}
			if (waiting !== undefined) {
				const resolve = waiting;
				waiting = undefined;
				resolve({ done: false, value });
				return;
			}
			buffer.push(value);
		},
		close(): void {
			if (closed) return;
			closed = true;
			if (waiting !== undefined) {
				const resolve = waiting;
				waiting = undefined;
				resolve({ done: true, value: undefined });
			}
		},
		get size(): number {
			return buffer.length;
		},
		[Symbol.asyncIterator](): AsyncIterator<T> {
			return { next };
		},
	};

	return queue;
}
