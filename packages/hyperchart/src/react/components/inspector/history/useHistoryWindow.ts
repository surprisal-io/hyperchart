import { useCallback, useEffect, useRef, useState } from "react";
import type { HistoryChunk, HistoryCursor, HistorySnapshot } from "../../../../runtime/generic/log_store.js";

export const HISTORY_WINDOW_ITEMS = 1_000;

export type HistoryWindow<T> = Readonly<{
	items: readonly T[];
	older?: HistoryCursor;
	newer?: HistoryCursor;
}>;

export type HistoryEdgeState = Readonly<{
	loading: boolean;
	error?: string;
}>;

export type HistoryWindowSource<T> = Readonly<{
	load(cursor?: HistoryCursor, signal?: AbortSignal): Promise<HistoryChunk<T>>;
}>;

type Segment<T> = Readonly<{
	items: readonly T[];
	older?: HistoryCursor;
	newer?: HistoryCursor;
}>;

type WindowState<T> = Readonly<{
	snapshot?: HistorySnapshot;
	segments: readonly Segment<T>[];
	older?: HistoryCursor;
	newer?: HistoryCursor;
}>;

export type MergeDirection = "initial" | "older" | "newer";

/** Pure merge seam used by the hook and characterized independently. */
export function mergeHistoryWindow<T>(
	current: WindowState<T>,
	chunk: HistoryChunk<T>,
	direction: MergeDirection,
	identity: (item: T) => string,
	limit = HISTORY_WINDOW_ITEMS,
): WindowState<T> {
	if (limit <= 0) return { snapshot: chunk.snapshot, segments: [] };
	const existing = new Set(current.segments.flatMap((segment) => segment.items.map(identity)));
	const seen = new Set<string>();
	const unique = chunk.items.filter((item) => {
		const key = identity(item);
		if (existing.has(key) || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	let segments: Segment<T>[];
	if (direction === "initial") {
		segments = unique.length === 0 ? [] : [{ items: unique, ...(chunk.older === undefined ? {} : { older: chunk.older }), ...(chunk.newer === undefined ? {} : { newer: chunk.newer }) }];
	} else if (unique.length === 0) {
		segments = [...current.segments];
	} else {
		const segment = { items: unique, ...(chunk.older === undefined ? {} : { older: chunk.older }), ...(chunk.newer === undefined ? {} : { newer: chunk.newer }) };
		segments = direction === "older" ? [...current.segments, segment] : [segment, ...current.segments];
	}

	let count = segments.reduce((sum, segment) => sum + segment.items.length, 0);
	while (count > limit && segments.length > 1) {
		const index = direction === "older" ? 0 : segments.length - 1;
		const removed = segments[index]!;
		segments.splice(index, 1);
		count -= removed.items.length;
	}
	if (count > limit && segments.length === 1) {
		const only = segments[0]!;
		segments = [{ ...only, items: direction === "older" ? only.items.slice(-limit) : only.items.slice(0, limit) }];
	}
	const first = segments[0];
	const last = segments.at(-1);
	return {
		snapshot: chunk.snapshot,
		segments,
		...(first?.newer === undefined ? {} : { newer: first.newer }),
		...(last?.older === undefined ? {} : { older: last.older }),
	};
}

export function useHistoryWindow<T>(options: {
	cacheKey: string;
	source: HistoryWindowSource<T>;
	identity: (item: T) => string;
	initialCursor?: HistoryCursor;
}) {
	const { cacheKey, source, identity, initialCursor } = options;
	const [window, setWindow] = useState<WindowState<T>>({ segments: [] });
	const [initial, setInitial] = useState<HistoryEdgeState>({ loading: true });
	const [older, setOlder] = useState<HistoryEdgeState>({ loading: false });
	const [newer, setNewer] = useState<HistoryEdgeState>({ loading: false });
	const generation = useRef(0);
	const sourceRef = useRef(source);
	const identityRef = useRef(identity);
	sourceRef.current = source;
	identityRef.current = identity;
	const controllers = useRef<{ initial?: AbortController; older?: AbortController; newer?: AbortController }>({});
	const windowRef = useRef(window);
	windowRef.current = window;

	const request = useCallback(async (direction: MergeDirection, cursor?: HistoryCursor) => {
		const edge = direction === "initial" ? setInitial : direction === "older" ? setOlder : setNewer;
		const active = controllers.current[direction];
		if (active !== undefined) return;
		const controller = new AbortController();
		controllers.current[direction] = controller;
		const requestGeneration = generation.current;
		edge({ loading: true });
		try {
			const chunk = await sourceRef.current.load(cursor, controller.signal);
			if (controller.signal.aborted || requestGeneration !== generation.current) return;
			setWindow((current) => mergeHistoryWindow(current, chunk, direction, identityRef.current));
			edge({ loading: false });
		} catch (error) {
			if (controller.signal.aborted || requestGeneration !== generation.current) return;
			edge({ loading: false, error: error instanceof Error ? error.message : String(error) });
		} finally {
			if (controllers.current[direction] === controller) delete controllers.current[direction];
		}
	}, []);

	useEffect(() => {
		generation.current += 1;
		for (const controller of Object.values(controllers.current)) controller?.abort();
		controllers.current = {};
		setWindow({ segments: [] });
		setInitial({ loading: true });
		setOlder({ loading: false });
		setNewer({ loading: false });
		void request("initial", initialCursor);
		return () => {
			generation.current += 1;
			for (const controller of Object.values(controllers.current)) controller?.abort();
			controllers.current = {};
		};
	}, [cacheKey, initialCursor, request]);

	const loadOlder = useCallback(() => {
		const cursor = windowRef.current.older;
		if (cursor !== undefined) return request("older", cursor);
		return Promise.resolve();
	}, [request]);
	const loadNewer = useCallback(() => {
		const cursor = windowRef.current.newer;
		if (cursor !== undefined) return request("newer", cursor);
		return Promise.resolve();
	}, [request]);
	const retryInitial = useCallback(() => request("initial", initialCursor), [initialCursor, request]);

	return {
		window: {
			items: window.segments.flatMap((segment) => segment.items),
			...(window.older === undefined ? {} : { older: window.older }),
			...(window.newer === undefined ? {} : { newer: window.newer }),
		} satisfies HistoryWindow<T>,
		initial,
		older,
		newer,
		loadOlder,
		loadNewer,
		retryInitial,
	};
}
