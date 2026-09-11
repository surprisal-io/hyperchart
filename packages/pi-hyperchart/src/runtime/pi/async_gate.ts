export type AsyncGate = <T>(operation: () => Promise<T>) => Promise<T>;

export type AsyncMemo<K, V> = (key: K) => Promise<V>;

export function createAsyncMemo<K, V>(load: (key: K) => Promise<V>): AsyncMemo<K, V> {
	const values = new Map<K, Promise<V>>();
	return (key: K) => {
		const cached = values.get(key);
		if (cached !== undefined) {
			return cached;
		}
		const pending = load(key);
		values.set(key, pending);
		void pending.catch(() => {
			if (values.get(key) === pending) {
				values.delete(key);
			}
		});
		return pending;
	};
}

export function createAsyncGate(limit: number): AsyncGate {
	if (!Number.isInteger(limit) || limit < 1) {
		throw new Error("Async gate limit must be a positive integer");
	}
	let active = 0;
	const waiting: Array<() => void> = [];
	return async <T>(operation: () => Promise<T>): Promise<T> => {
		if (active < limit) {
			active += 1;
		} else {
			await new Promise<void>((resolveWaiting) => waiting.push(resolveWaiting));
		}
		try {
			return await operation();
		} finally {
			const next = waiting.shift();
			if (next === undefined) {
				active -= 1;
			} else {
				next();
			}
		}
	};
}
