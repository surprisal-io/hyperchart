export type MaybeAsyncIterable<T> = Iterable<T> | AsyncIterable<T>;

export async function* toAsyncIterable<T>(iterable: MaybeAsyncIterable<T>): AsyncIterable<T> {
	for await (const item of iterable) {
		yield item;
	}
}

export async function* concatAsyncIterables<T>(...iterables: Array<MaybeAsyncIterable<T>>): AsyncIterable<T> {
	for (const iterable of iterables) {
		yield* toAsyncIterable(iterable);
	}
}
